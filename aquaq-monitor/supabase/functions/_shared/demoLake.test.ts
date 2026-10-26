import { describe, expect, it } from 'vitest';
import { DEMO_PLAN, demoMission, demoWaterBody, demoZones, generateHistory, generateStationHistory, surveyStartTimes } from './demoLake.ts';
import { pointInPolygon } from './geo.ts';

const NOW = Date.parse('2026-10-26T10:15:00+05:30');

describe('demo lake', () => {
  const h = generateHistory(NOW);

  it('has 6 completed surveys 15 days apart, the latest in the past', () => {
    expect(h.surveys).toHaveLength(6);
    const starts = h.surveys.map((s) => Date.parse(s.started_at));
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBe(15 * 86_400_000);
    expect(starts[5]).toBeLessThan(NOW);
    expect(surveyStartTimes(NOW)).toEqual(starts);
  });

  it('latest survey matches the section 10 table', () => {
    const latest = h.zoneScores.filter((z) => z.survey_id === h.surveys[5].id);
    const byZone = Object.fromEntries(latest.map((z) => [z.zone_id, z]));
    for (const p of DEMO_PLAN) {
      expect(byZone[p.zone_id].risk_R).toBe(p.R);
      expect(byZone[p.zone_id].trust_T).toBe(p.T);
    }
    expect(byZone.A.risk_tier).toBe('Critical');
    expect(byZone.B.trust_gate).toBe('lab_review');
  });

  it('zone A worsens, zone C improves, zone B has one earlier low-trust false alarm', () => {
    const series = (z: string) => h.surveys.map((s) => h.zoneScores.find((x) => x.survey_id === s.id && x.zone_id === z)!);
    const a = series('A').map((x) => x.risk_R);
    const c = series('C').map((x) => x.risk_R);
    for (let i = 1; i < 6; i++) {
      expect(a[i]).toBeGreaterThan(a[i - 1]);
      expect(c[i]).toBeLessThan(c[i - 1]);
    }
    const lowTrustEarlier = series('B').slice(0, 5).filter((x) => x.trust_T < 0.5);
    expect(lowTrustEarlier).toHaveLength(1);
  });

  it('the drifting DO probe shows up as low-trust anomalies in zone B', () => {
    const drift = h.readings.filter((r) => r.survey_id === h.surveys[2].id && r.zone_id === 'B' && r.parameter_key === 'do' && r.edge_anomaly_flag);
    expect(drift.length).toBeGreaterThan(0);
    expect(drift.every((r) => (r.trust_T ?? 1) < 0.5)).toBe(true);
  });

  it('readings sit inside the zone they are tagged with', () => {
    const zones = Object.fromEntries(demoZones().map((z) => [z.id, z]));
    for (const r of h.readings.slice(0, 500)) expect(pointInPolygon([r.lat, r.lon], zones[r.zone_id!].polygon)).toBe(true);
  });

  it('every mission waypoint and the dock are inside the geofence', () => {
    const wb = demoWaterBody();
    expect(pointInPolygon(wb.home_point, wb.geofence)).toBe(true);
    for (const w of demoMission(new Date(NOW).toISOString()).waypoints) expect(pointInPolygon([w.lat, w.lon], wb.geofence)).toBe(true);
  });

  it('demo mission plan uses 14 of 14 energy units', () => {
    const m = demoMission(new Date(NOW).toISOString());
    expect(m.zones.reduce((s, z) => s + z.energy, 0)).toBe(14);
    expect(m.mission.solver).toBe('mock');
  });

  it('is deterministic', () => {
    expect(generateHistory(NOW).readings.slice(0, 50)).toEqual(h.readings.slice(0, 50));
  });

  it('station history is hourly for both stations', () => {
    const s = generateStationHistory(NOW, 2);
    const s1do = s.filter((r) => r.source_id === 'S1' && r.parameter_key === 'do');
    expect(s1do.length).toBeGreaterThanOrEqual(48);
  });
});
