// Zone scoring (section 9, POST /score): risk R, trust T, tier, drivers and trust gate per zone
// from one survey's readings. Classical and deterministic. The Python planner service implements
// the identical algorithm (planner-service/app/scoring.py); a shared fixture keeps them in step.
//
// R uses every reading, trusted or not: it answers "how bad would this be if the data are true?".
// T is the mean trust of the zone's anomalous readings (0.9 when there were none), so a
// high-risk, low-trust zone gets a confirmation sample before anyone acts on it.

import { computeDrivers, limitRatio, limitStatus, riskTier, round, trustGate } from './limits.ts';
import type { Driver, Parameter, RiskTier, Settings, TrustGate } from './types.ts';

export const SCORING_METHOD = 'classical_v1';
/** Zone trust when the survey found no anomalies in it. */
export const NO_ANOMALY_TRUST = 0.9;

export interface ScoreReading {
  zone_id: string | null;
  parameter_key: string;
  value: number;
  edge_anomaly_flag: boolean;
  trust_T: number | null;
}

export interface ScoreRequest {
  survey_id: string;
  zones: string[];
  readings: ScoreReading[];
  parameters: Parameter[];
  settings: Pick<Settings, 'trust_threshold' | 'tier_cutoffs' | 'near_limit_pct'>;
}

export interface ScoredZone {
  zone_id: string;
  risk_R: number;
  trust_T: number;
  risk_tier: RiskTier;
  top_drivers: Driver[];
  trust_gate: TrustGate;
  trust_gate_reason: string | null;
}

export interface ScoreResponse {
  survey_id: string;
  method: string;
  zone_scores: ScoredZone[];
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** 0 at 60 % of the way to the limit, 1 at 140 % (40 % beyond it). */
export function exceedanceScore(ratio: number): number {
  return clamp((ratio - 0.6) / 0.8, 0, 1);
}

export function scoreZone(zoneId: string, req: ScoreRequest): ScoredZone {
  const rs = req.readings.filter((r) => r.zone_id === zoneId);
  const params = req.parameters.filter((p) => p.enabled && p.limit_type !== 'none' && p.hazard_weight > 0);
  const wmax = Math.max(...params.map((p) => p.hazard_weight), 1e-9);
  const parts: number[] = [];
  const means: Record<string, number> = {};
  for (const p of params) {
    const vals = rs.filter((r) => r.parameter_key === p.key).map((r) => r.value);
    if (!vals.length) continue;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    means[p.key] = mean;
    const ratio = limitRatio(mean, p);
    if (ratio == null || !Number.isFinite(ratio)) continue;
    const exceedFrac = vals.filter((v) => limitStatus(v, p, req.settings.near_limit_pct) === 'out').length / vals.length;
    parts.push(clamp(0.75 * exceedanceScore(ratio) + 0.25 * exceedFrac, 0, 1) * (p.hazard_weight / wmax));
  }
  const R = parts.length ? round(clamp(0.7 * Math.max(...parts) + (0.3 * parts.reduce((a, b) => a + b, 0)) / parts.length, 0, 1), 2) : 0;
  const anomalies = rs.filter((r) => r.edge_anomaly_flag && r.trust_T != null);
  const T = anomalies.length ? round(anomalies.reduce((a, r) => a + r.trust_T!, 0) / anomalies.length, 2) : NO_ANOMALY_TRUST;
  // Drivers also include parameters without a hazard weight filter applied above, like the seed data.
  for (const p of req.parameters) {
    if (means[p.key] != null || !p.enabled) continue;
    const vals = rs.filter((r) => r.parameter_key === p.key).map((r) => r.value);
    if (vals.length) means[p.key] = vals.reduce((a, b) => a + b, 0) / vals.length;
  }
  const gate = trustGate(R, T, req.settings);
  return {
    zone_id: zoneId,
    risk_R: R,
    trust_T: T,
    risk_tier: riskTier(R, req.settings.tier_cutoffs),
    top_drivers: computeDrivers(means, req.parameters),
    trust_gate: gate.gate,
    trust_gate_reason: gate.reason,
  };
}

export function scoreSurvey(req: ScoreRequest): ScoreResponse {
  return { survey_id: req.survey_id, method: SCORING_METHOD, zone_scores: req.zones.map((z) => scoreZone(z, req)) };
}
