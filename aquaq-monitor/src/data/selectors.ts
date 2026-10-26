import { TIER_ORDER, trendOf, type Trend } from '@shared/limits.ts';
import type { Mission, Reading, RiskTier, Survey, Zone, ZoneScore } from '@shared/types.ts';
import { DAY_MS } from '@/lib/time';
import type { Snapshot } from './source';

export function completedSurveys(s: Snapshot): Survey[] {
  return s.surveys.filter((x) => x.status === 'completed');
}

export function latestSurvey(s: Snapshot): Survey | undefined {
  const c = completedSurveys(s);
  return c[c.length - 1];
}

export function scoresBySurvey(s: Snapshot, surveyId: string | undefined): Record<string, ZoneScore> {
  const out: Record<string, ZoneScore> = {};
  if (!surveyId) return out;
  for (const z of s.zoneScores) if (z.survey_id === surveyId) out[z.zone_id] = z;
  return out;
}

export interface ZoneSummary {
  zone: Zone;
  score: ZoneScore | undefined;
  previous: ZoneScore | undefined;
  trend: Trend;
}

export function zoneSummaries(s: Snapshot): ZoneSummary[] {
  const c = completedSurveys(s);
  const cur = scoresBySurvey(s, c[c.length - 1]?.id);
  const prev = scoresBySurvey(s, c[c.length - 2]?.id);
  return s.zones.map((zone) => ({
    zone,
    score: cur[zone.id],
    previous: prev[zone.id],
    trend: cur[zone.id] ? trendOf(cur[zone.id].risk_R, prev[zone.id]?.risk_R) : 'stable',
  }));
}

export function worstTier(scores: (ZoneScore | undefined)[]): RiskTier | null {
  let worst = -1;
  for (const z of scores) if (z) worst = Math.max(worst, TIER_ORDER.indexOf(z.risk_tier));
  return worst < 0 ? null : TIER_ORDER[worst];
}

/** Score history for one zone, oldest first. */
export function zoneHistory(s: Snapshot, zoneId: string): { survey: Survey; score: ZoneScore }[] {
  const out: { survey: Survey; score: ZoneScore }[] = [];
  for (const survey of completedSurveys(s)) {
    const score = s.zoneScores.find((z) => z.survey_id === survey.id && z.zone_id === zoneId);
    if (score) out.push({ survey, score });
  }
  return out;
}

/** Most recent live reading for each parameter across the boat and all stations. */
export function latestPerParameter(s: Snapshot): Record<string, Reading> {
  const out: Record<string, Reading> = {};
  for (const bySource of Object.values(s.latestBySource)) {
    for (const r of Object.values(bySource)) {
      if (!out[r.parameter_key] || out[r.parameter_key].ts < r.ts) out[r.parameter_key] = r;
    }
  }
  return out;
}

export function nextSurveyAt(s: Snapshot): number | null {
  const last = latestSurvey(s);
  if (!last) return null;
  return new Date(last.started_at).getTime() + s.settings.survey_interval_days * DAY_MS;
}

export function activeMission(s: Snapshot): Mission | undefined {
  const boat = s.boats[0];
  return s.missions.find((m) => m.id === boat?.mission_id) ?? s.missions.find((m) => m.status === 'running');
}

export function secondsSince(iso: string | null | undefined, now: number): number {
  return iso ? (now - new Date(iso).getTime()) / 1000 : Infinity;
}

export function paramName(s: Snapshot, key: string): string {
  return s.parameters.find((p) => p.key === key)?.name ?? key;
}
