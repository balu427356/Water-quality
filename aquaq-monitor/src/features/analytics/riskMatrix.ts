import { limitRatio, limitStatus } from '@shared/limits.ts';
import type { Parameter, Reading } from '@shared/types.ts';

/** Map a hazard-weighted limit ratio to a 1–5 severity level. */
export function severityLevel(weightedRatio: number): number {
  if (weightedRatio < 0.5) return 1;
  if (weightedRatio < 0.8) return 2;
  if (weightedRatio < 1) return 3;
  if (weightedRatio < 1.5) return 4;
  return 5;
}

/** Map a 0–1 probability to a 1–5 level. */
export function probabilityLevel(p: number): number {
  return Math.min(5, Math.max(1, Math.ceil(p * 5)));
}

export interface MatrixItem {
  id: string;
  label: string;
  probability: number;
  severity: number;
}

function worstWeightedRatio(readings: Reading[], params: Parameter[]): number {
  let worst = 0;
  for (const r of readings) {
    const p = params.find((x) => x.key === r.parameter_key);
    if (!p || p.hazard_weight <= 0) continue;
    const ratio = limitRatio(r.value, p);
    if (ratio == null || !Number.isFinite(ratio)) continue;
    worst = Math.max(worst, ratio * Math.min(1.2, p.hazard_weight));
  }
  return worst;
}

/**
 * Zones: probability = share of readings near or outside a limit; severity = worst
 * hazard-weighted limit ratio of the zone's mean values.
 */
export function zoneMatrixItems(readings: Reading[], params: Parameter[], zoneIds: string[], nearPct: number): MatrixItem[] {
  return zoneIds.map((z) => {
    const zr = readings.filter((r) => r.zone_id === z);
    const limited = zr.filter((r) => {
      const p = params.find((x) => x.key === r.parameter_key);
      return p && p.limit_type !== 'none';
    });
    const bad = limited.filter((r) => limitStatus(r.value, params.find((x) => x.key === r.parameter_key)!, nearPct) !== 'ok');
    const byParam = new Map<string, number[]>();
    for (const r of zr) byParam.set(r.parameter_key, [...(byParam.get(r.parameter_key) ?? []), r.value]);
    const means: Reading[] = [...byParam.entries()].map(([k, vs]) => ({ ...zr[0], parameter_key: k, value: vs.reduce((a, b) => a + b, 0) / vs.length }));
    return {
      id: z,
      label: `Zone ${z}`,
      probability: probabilityLevel(limited.length ? bad.length / limited.length : 0),
      severity: severityLevel(worstWeightedRatio(means, params)),
    };
  });
}

/**
 * Samples: probability = trust T for anomalous samples (how likely the exceedance is real),
 * 0.1 for samples without an anomaly; severity = worst hazard-weighted limit ratio.
 */
export function sampleMatrixItems(readings: Reading[], params: Parameter[]): MatrixItem[] {
  const groups = new Map<string, Reading[]>();
  for (const r of readings) {
    if (r.source_type === 'station') continue;
    const k = `${r.ts}|${r.lat.toFixed(5)}|${r.lon.toFixed(5)}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.entries()].map(([k, rs]) => {
    const anomalies = rs.filter((r) => r.edge_anomaly_flag && r.trust_T != null);
    const T = anomalies.length ? Math.max(...anomalies.map((r) => r.trust_T!)) : 0.1;
    return { id: k, label: `${rs[0].zone_id ?? '?'} ${rs[0].ts}`, probability: probabilityLevel(T), severity: severityLevel(worstWeightedRatio(rs, params)) };
  });
}
