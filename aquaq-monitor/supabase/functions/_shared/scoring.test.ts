import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { demoParameters } from './demoLake.ts';
import { exceedanceScore, scoreSurvey, type ScoreRequest, type ScoreResponse } from './scoring.ts';
import { DEFAULT_SETTINGS } from './types.ts';

const fixture = JSON.parse(readFileSync(new URL('../../../planner-service/tests/fixtures/score_fixture.json', import.meta.url), 'utf8')) as { request: ScoreRequest; expected: ScoreResponse }[];

const settings = { trust_threshold: DEFAULT_SETTINGS.trust_threshold, tier_cutoffs: DEFAULT_SETTINGS.tier_cutoffs, near_limit_pct: 10 };
const r = (zone: string, key: string, value: number, anomaly = false, T: number | null = null) => ({ zone_id: zone, parameter_key: key, value, edge_anomaly_flag: anomaly, trust_T: T });

describe('zone scoring (/score)', () => {
  it('matches the committed fixture (shared with the Python service)', () => {
    for (const f of fixture) expect(scoreSurvey(f.request)).toEqual(f.expected);
  });

  it('scores a clean zone low and trusted', () => {
    const res = scoreSurvey({ survey_id: 'S', zones: ['D'], parameters: demoParameters(), settings, readings: [r('D', 'turbidity', 2.4), r('D', 'do', 7.1), r('D', 'ph', 7.4)] });
    expect(res.zone_scores[0]).toMatchObject({ zone_id: 'D', risk_tier: 'Low', trust_T: 0.9, trust_gate: 'auto_accept' });
    expect(res.zone_scores[0].risk_R).toBeLessThan(0.25);
  });

  it('scores a heavily polluted zone Critical with high trust', () => {
    const rs = Array.from({ length: 6 }, () => [r('A', 'turbidity', 11, true, 0.9), r('A', 'do', 2.8, true, 0.88)]).flat();
    const z = scoreSurvey({ survey_id: 'S', zones: ['A'], parameters: demoParameters(), settings, readings: rs }).zone_scores[0];
    expect(z.risk_tier).toBe('Critical');
    expect(z.trust_T).toBe(0.89);
    expect(z.top_drivers[0].contribution).toBeGreaterThan(0);
  });

  it('keeps R high but T low when the anomaly comes from an untrusted probe', () => {
    const rs = Array.from({ length: 6 }, () => [r('B', 'do', 2.6, true, 0.3), r('B', 'turbidity', 3)]).flat();
    const z = scoreSurvey({ survey_id: 'S', zones: ['B'], parameters: demoParameters(), settings, readings: rs }).zone_scores[0];
    expect(z.risk_R).toBeGreaterThanOrEqual(0.75);
    expect(z.trust_T).toBe(0.3);
    expect(z.trust_gate).toBe('lab_review');
  });

  it('scores a zone without readings as R 0', () => {
    expect(scoreSurvey({ survey_id: 'S', zones: ['X'], parameters: demoParameters(), settings, readings: [] }).zone_scores[0].risk_R).toBe(0);
  });

  it('maps limit ratios to 0–1', () => {
    expect(exceedanceScore(0.5)).toBe(0);
    expect(exceedanceScore(1)).toBeCloseTo(0.5);
    expect(exceedanceScore(2)).toBe(1);
  });
});
