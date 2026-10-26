import { formatLimit, limitStatus } from '@shared/limits.ts';
import type { Parameter, Reading, Settings } from '@shared/types.ts';
import type { CsvRow } from '@/lib/csv';
import { fmtDateTime } from '@/lib/time';

/** One CSV row per reading, with the limit and its status at the time of export. */
export function readingRows(readings: Reading[], params: Parameter[], settings: Settings): CsvRow[] {
  const byKey = new Map(params.map((p) => [p.key, p]));
  return readings.map((r) => {
    const p = byKey.get(r.parameter_key);
    return {
      ts_utc: r.ts,
      ts_ist: fmtDateTime(r.ts),
      source_type: r.source_type,
      source_id: r.source_id,
      survey_id: r.survey_id,
      zone_id: r.zone_id,
      lat: r.lat,
      lon: r.lon,
      parameter: r.parameter_key,
      value: r.value,
      unit: p?.unit,
      limit: p ? formatLimit(p) : null,
      status: p ? limitStatus(r.value, p, settings.near_limit_pct) : null,
      edge_anomaly: r.edge_anomaly_flag,
      trust_T: r.trust_T,
      confirmation_sample: r.confirmation,
    };
  });
}
