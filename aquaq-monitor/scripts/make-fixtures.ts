// Regenerates planner-service/tests/fixtures/*.json from the TypeScript implementations.
// The Python service's tests assert it produces the same output, so both stay in step.
//   npm run fixtures
import { writeFileSync } from 'node:fs';
import { DEMO_PLAN, demoParameters, demoZones, generateHistory } from '../supabase/functions/_shared/demoLake.ts';
import { DEFAULT_LEVEL_ENERGY, mockPlan, type PlannerRequest } from '../supabase/functions/_shared/planner.ts';
import { scoreSurvey, type ScoreRequest } from '../supabase/functions/_shared/scoring.ts';
import { DEFAULT_SETTINGS } from '../supabase/functions/_shared/types.ts';

const NOW = Date.parse('2026-10-26T10:00:00+05:30');
const dir = new URL('../planner-service/tests/fixtures/', import.meta.url);

export function scoreFixtureRequests(): ScoreRequest[] {
  const h = generateHistory(NOW);
  // Two surveys keep the fixture small: SV-003 (drifting-probe false alarm) and SV-006 (latest).
  return h.surveys.filter((s) => s.id === 'SV-003' || s.id === 'SV-006').map((s) => ({
    survey_id: s.id,
    zones: demoZones().map((z) => z.id),
    readings: h.readings
      .filter((r) => r.survey_id === s.id)
      .map((r) => ({ zone_id: r.zone_id, parameter_key: r.parameter_key, value: r.value, edge_anomaly_flag: r.edge_anomaly_flag, trust_T: r.trust_T })),
    parameters: demoParameters(),
    settings: { trust_threshold: DEFAULT_SETTINGS.trust_threshold, tier_cutoffs: DEFAULT_SETTINGS.tier_cutoffs, near_limit_pct: DEFAULT_SETTINGS.near_limit_pct },
  }));
}

export function planFixtureRequest(): PlannerRequest {
  return {
    water_body_id: 'WB1',
    boat_id: 'B1',
    energy_budget: 14,
    zones: DEMO_PLAN.map((z) => ({ zone_id: z.zone_id, risk_R: z.R, trust_T: z.T })),
    levels: { ...DEFAULT_LEVEL_ENERGY },
  };
}

if (process.argv[1]?.endsWith('make-fixtures.ts')) {
  const score = scoreFixtureRequests().map((request) => ({ request, expected: scoreSurvey(request) }));
  writeFileSync(new URL('score_fixture.json', dir), JSON.stringify(score, null, 1) + '\n');
  const request = planFixtureRequest();
  writeFileSync(new URL('plan_fixture.json', dir), JSON.stringify({ request, expected: mockPlan(request) }, null, 1) + '\n');
  console.log('Wrote score_fixture.json and plan_fixture.json');
}
