import { describe, expect, it } from 'vitest';
import { DEMO_PLAN, demoMission, demoWaterBody, demoZones, generateHistory } from './demoLake.ts';
import { distanceToEdgeM, fromLocal, pointInPolygon } from './geo.ts';
import {
  DEFAULT_LEVEL_ENERGY,
  buildRoute,
  evaluatePlan,
  levelValue,
  mockPlan,
  scheduledProposalNeeded,
  type PlannerRequest,
} from './planner.ts';
import { DEFAULT_SETTINGS, type Mission } from './types.ts';

const demoRequest = (): PlannerRequest => ({
  water_body_id: 'WB1',
  boat_id: 'B1',
  energy_budget: 14,
  zones: DEMO_PLAN.map((z) => ({ zone_id: z.zone_id, risk_R: z.R, trust_T: z.T })),
  levels: { ...DEFAULT_LEVEL_ENERGY },
});

describe('mock planner', () => {
  it('gives exactly the section 10 plan for the demo lake', () => {
    const res = mockPlan(demoRequest());
    expect(res.solver).toBe('mock');
    expect(res.zones.map((z) => [z.zone_id, z.level, z.energy])).toEqual([
      ['A', 'hotspot_5m', 10],
      ['B', 'confirm', 1],
      ['C', 'standard_25m', 3],
      ['D', 'skip', 0],
    ]);
    expect(res.energy_planned).toBe(14);
    expect(res.objective).toBe(2.69);
    // Reasons match the seeded demo plan wording.
    expect(res.zones.map((z) => z.reason)).toEqual(DEMO_PLAN.map((z) => z.reason));
  });

  it('values choices as in the brief', () => {
    expect(levelValue('hotspot_5m', 0.9, 0.9)).toBeCloseTo(1.782);
    expect(levelValue('confirm', 0.8, 0.3)).toBeCloseTo(0.672);
    expect(levelValue('standard_25m', 0.3, 0.8)).toBeCloseTo(0.24);
    expect(levelValue('dense_10m', 0.5, 0.5)).toBeCloseTo(0.4);
    expect(levelValue('skip', 1, 1)).toBe(0);
  });

  it('never exceeds the budget', () => {
    for (const budget of [0, 1, 3, 5, 9, 13, 20, 40]) {
      const r = mockPlan({ ...demoRequest(), energy_budget: budget });
      expect(r.energy_planned).toBeLessThanOrEqual(budget);
    }
    expect(mockPlan({ ...demoRequest(), energy_budget: 0 }).zones.every((z) => z.level === 'skip')).toBe(true);
  });

  it('uses a labelled greedy heuristic above 8 zones', () => {
    const zones = Array.from({ length: 10 }, (_, i) => ({ zone_id: `Z${i}`, risk_R: 0.1 * (i + 1) * 0.9, trust_T: i % 2 ? 0.3 : 0.9 }));
    const r = mockPlan({ ...demoRequest(), zones, energy_budget: 20 });
    expect(r.solver).toBe('mock');
    expect(r.note).toMatch(/greedy/);
    expect(r.energy_planned).toBeLessThanOrEqual(20);
    expect(r.zones.some((z) => z.level !== 'skip')).toBe(true);
  });

  it('recalculates energy and blocks over-budget edits', () => {
    const zones = DEMO_PLAN.map((z) => ({ zone_id: z.zone_id, level: z.level, risk_R: z.R, trust_T: z.T }));
    expect(evaluatePlan(zones, DEFAULT_LEVEL_ENERGY, 14)).toEqual({ energy: 14, objective: 2.69, overBudget: false });
    zones[3].level = 'standard_25m';
    expect(evaluatePlan(zones, DEFAULT_LEVEL_ENERGY, 14).overBudget).toBe(true);
  });
});

describe('route builder', () => {
  const wb = demoWaterBody();
  const zones = demoZones();
  const plan = DEMO_PLAN.map((z) => ({ zone_id: z.zone_id, level: z.level }));
  const route = buildRoute(plan, {
    waterBody: wb,
    zones,
    hotspots: { A: fromLocal([12.9716, 79.1588], -50, 160) },
    confirmPoints: {},
    start: wb.home_point,
    edgeMarginM: 12,
  });

  it('keeps every waypoint well inside the geofence and ends at the dock', () => {
    for (const w of route) {
      expect(pointInPolygon([w.lat, w.lon], wb.geofence)).toBe(true);
      if (w.action !== 'transit') expect(distanceToEdgeM([w.lat, w.lon], wb.geofence)).toBeGreaterThanOrEqual(12);
    }
    expect(route[route.length - 1]).toMatchObject({ action: 'transit', lat: wb.home_point[0], lon: wb.home_point[1] });
    expect(route.map((w) => w.seq)).toEqual(route.map((_, i) => i + 1));
  });

  it('samples each planned zone at its level and skips skipped zones', () => {
    const inZone = (id: string) => route.filter((w) => w.action !== 'transit' && pointInPolygon([w.lat, w.lon], zones.find((z) => z.id === id)!.polygon));
    expect(inZone('B').map((w) => w.action)).toEqual(['confirm_sample']);
    expect(inZone('D')).toHaveLength(0);
    // Hotspot at 5 m inside a 60 m box: ~12 transects → ~24 waypoints in zone A.
    expect(inZone('A').length).toBeGreaterThanOrEqual(16);
    expect(inZone('C').length).toBeGreaterThanOrEqual(6);
  });
});

describe('scheduled surveys', () => {
  const NOW = Date.parse('2026-10-26T10:00:00+05:30');
  const { surveys } = generateHistory(NOW);
  const next = Date.parse(surveys[5].started_at) + 15 * 86_400_000;

  it('proposes a mission one day before the next survey, once', () => {
    expect(scheduledProposalNeeded(next - 2 * 86_400_000, surveys, [], DEFAULT_SETTINGS)).toBeNull();
    expect(scheduledProposalNeeded(next - 86_400_000 + 1000, surveys, [], DEFAULT_SETTINGS)).toBe(next);
    const m: Mission = { ...demoMission(new Date(NOW).toISOString()).mission, kind: 'scheduled', status: 'proposed', created_at: new Date(next - 86_400_000).toISOString() };
    expect(scheduledProposalNeeded(next - 86_400_000 + 1000, surveys, [m], DEFAULT_SETTINGS)).toBeNull();
  });
});
