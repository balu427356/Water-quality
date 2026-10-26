import type { Driver, Parameter, RiskTier, Settings, TrustGate } from './types.ts';

export type LimitStatus = 'ok' | 'near' | 'out' | 'none';

/**
 * Normalised position of a value relative to its safe limit:
 * 0 = comfortably safe, 1 = exactly at the limit, >1 = outside it, 2 = "twice the limit".
 *   max:   value / limit_high
 *   min:   limit_low / value
 *   range: |value − centre| / half-width   (so either bound is 1)
 * Returns null for trend-only parameters.
 */
export function limitRatio(value: number, p: Parameter): number | null {
  switch (p.limit_type) {
    case 'max':
      if (p.limit_high == null || p.limit_high <= 0) return null;
      return value / p.limit_high;
    case 'min':
      if (p.limit_low == null) return null;
      return value <= 0 ? Infinity : p.limit_low / value;
    case 'range': {
      if (p.limit_low == null || p.limit_high == null) return null;
      const centre = (p.limit_low + p.limit_high) / 2;
      const half = (p.limit_high - p.limit_low) / 2;
      return half <= 0 ? null : Math.abs(value - centre) / half;
    }
    default:
      return null;
  }
}

/**
 * Classify a value against its limit.
 * "Near" means inside the limit but within `nearPct` % of it. The reference for that
 * percentage is the limit value for max/min limits and the range width for range limits
 * (10 % of 6.5–8.5 pH is 0.2 pH, so 6.5–6.7 and 8.3–8.5 count as near).
 */
export function limitStatus(value: number, p: Parameter, nearPct = 10): LimitStatus {
  const f = nearPct / 100;
  switch (p.limit_type) {
    case 'max':
      if (p.limit_high == null) return 'none';
      if (value > p.limit_high) return 'out';
      return value >= p.limit_high * (1 - f) ? 'near' : 'ok';
    case 'min':
      if (p.limit_low == null) return 'none';
      if (value < p.limit_low) return 'out';
      return value <= p.limit_low * (1 + f) ? 'near' : 'ok';
    case 'range': {
      if (p.limit_low == null || p.limit_high == null) return 'none';
      if (value < p.limit_low || value > p.limit_high) return 'out';
      const band = (p.limit_high - p.limit_low) * f;
      return value - p.limit_low <= band || p.limit_high - value <= band ? 'near' : 'ok';
    }
    default:
      return 'none';
  }
}

export function formatLimit(p: Parameter): string {
  switch (p.limit_type) {
    case 'max':
      return `≤ ${p.limit_high} ${p.unit}`;
    case 'min':
      return `≥ ${p.limit_low} ${p.unit}`;
    case 'range':
      return `${p.limit_low}–${p.limit_high} ${p.unit}`;
    default:
      return 'trend only';
  }
}

export function riskTier(R: number, cutoffs: Settings['tier_cutoffs']): RiskTier {
  if (R >= cutoffs.critical) return 'Critical';
  if (R >= cutoffs.high) return 'High';
  if (R >= cutoffs.medium) return 'Medium';
  return 'Low';
}

export const TIER_ORDER: RiskTier[] = ['Low', 'Medium', 'High', 'Critical'];

/** Distance below which an R value is treated as "borderline" between two tiers. */
export const BORDERLINE_MARGIN = 0.03;

export function trustGate(
  R: number,
  T: number,
  settings: Pick<Settings, 'trust_threshold' | 'tier_cutoffs'>,
): { gate: TrustGate; reason: string | null } {
  if (T < settings.trust_threshold) {
    return {
      gate: 'lab_review',
      reason: `Low agreement: trust ${T.toFixed(2)} is below the ${settings.trust_threshold} threshold, so the change may be a sensor fault.`,
    };
  }
  const c = settings.tier_cutoffs;
  for (const [name, cut] of [
    ['Low/Medium', c.medium],
    ['Medium/High', c.high],
    ['High/Critical', c.critical],
  ] as const) {
    if (Math.abs(R - cut) < BORDERLINE_MARGIN) {
      return { gate: 'lab_review', reason: `Borderline decision: R ${R.toFixed(2)} is within ${BORDERLINE_MARGIN} of the ${name} cut-off (${cut}).` };
    }
  }
  return { gate: 'auto_accept', reason: null };
}

/**
 * Per-parameter driver contributions for one zone. Contribution = hazard_weight × (ratio − 0.75):
 * positive values push the zone toward unsafe (the mean is more than 75 % of the way to its
 * limit), negative values are safety margin.
 */
export function computeDrivers(meanByParam: Record<string, number>, params: Parameter[]): Driver[] {
  const out: Driver[] = [];
  for (const p of params) {
    if (!p.enabled) continue;
    const v = meanByParam[p.key];
    if (v == null) continue;
    const r = limitRatio(v, p);
    if (r == null || !Number.isFinite(r)) continue;
    out.push({
      parameter_key: p.key,
      value: round(v, 3),
      limit: formatLimit(p),
      contribution: round(p.hazard_weight * (r - 0.75), 3),
    });
  }
  return out.sort((a, b) => b.contribution - a.contribution);
}

export type Trend = 'worsening' | 'improving' | 'stable';

export function trendOf(current: number, previous: number | undefined, tolerance = 0.05): Trend {
  if (previous == null) return 'stable';
  if (current - previous > tolerance) return 'worsening';
  if (previous - current > tolerance) return 'improving';
  return 'stable';
}

export function round(v: number, dp = 2): number {
  const k = 10 ** dp;
  return Math.round(v * k) / k;
}
