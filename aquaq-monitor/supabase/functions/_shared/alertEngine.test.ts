import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ALERT_RULES,
  FAULT_STREAK_FOR_MAINTENANCE,
  acknowledge,
  emptyMemory,
  escalate,
  resolve,
  runEngine,
  type EngineContext,
  type EngineMemory,
} from './alertEngine.ts';
import {
  demoBoat,
  demoMission,
  demoParameters,
  demoSensors,
  demoStations,
  demoWaterBody,
  demoZones,
  generateHistory,
  mulberry32,
} from './demoLake.ts';
import { TELEMETRY_INTERVAL_S, drainBattery, dropLink, initialSimState, injectDrift, injectPlume, stepSim, type SimState, type SimWorld } from './simCore.ts';
import { DEFAULT_SETTINGS, type Alert, type Reading } from './types.ts';

const T0 = Date.parse('2026-10-26T10:00:00+05:30');
const iso = new Date(T0).toISOString();

/** Simulator + engine harness mirroring what DemoSource does every tick. */
function harness(opts: { calibrated?: boolean } = {}) {
  const history = generateHistory(T0);
  const sensors = demoSensors(T0).map((s) => (opts.calibrated === false ? s : { ...s, last_calibrated_at: iso }));
  const world: SimWorld = {
    waterBody: demoWaterBody(),
    zones: demoZones(),
    parameters: demoParameters(),
    stations: demoStations(iso),
    sensors,
    settings: DEFAULT_SETTINGS,
  };
  let sim: SimState = initialSimState(demoBoat(iso), demoMission(iso).waypoints, T0);
  let memory: EngineMemory = emptyMemory();
  let alerts: Alert[] = [];
  let n = 0;
  let now = T0;
  const rng = mulberry32(3);
  const ctx = (boat = sim.boat): EngineContext => ({
    now,
    settings: DEFAULT_SETTINGS,
    rules: DEFAULT_ALERT_RULES,
    parameters: world.parameters,
    zones: world.zones,
    stations: world.stations,
    sensors: world.sensors,
    boats: [boat],
    surveys: history.surveys,
    zoneScores: history.zoneScores,
    missions: [demoMission(iso).mission],
    waterBody: world.waterBody,
  });
  let lastBoat = sim.boat;
  const h = {
    world,
    get sim() {
      return sim;
    },
    set sim(v: SimState) {
      sim = v;
    },
    get alerts() {
      return alerts;
    },
    get now() {
      return now;
    },
    get memory() {
      return memory;
    },
    /** Advance `ticks` telemetry intervals, running the engine after each. */
    run(ticks: number) {
      const all: Reading[] = [];
      for (let i = 0; i < ticks; i++) {
        now += TELEMETRY_INTERVAL_S * 1000;
        const r = stepSim(sim, world, now, rng);
        sim = r.state;
        if (r.telemetry) lastBoat = { ...sim.boat };
        for (const u of r.sensorHealth) world.sensors = world.sensors.map((s) => (s.id === u.id ? { ...s, health: u.health } : s));
        const res = runEngine(ctx(lastBoat), memory, alerts, r.readings, () => `AL-${++n}`);
        memory = res.memory;
        alerts = res.alerts;
        for (const u of res.sensorUpdates) world.sensors = world.sensors.map((s) => (s.id === u.id ? { ...s, ...u } : s));
        all.push(...r.readings);
      }
      return all;
    },
    /** Feed readings straight into the engine. */
    feed(readings: Reading[]) {
      const res = runEngine(ctx(lastBoat), memory, alerts, readings, () => `AL-${++n}`);
      memory = res.memory;
      alerts = res.alerts;
      return res;
    },
    byRule: (id: string) => alerts.filter((a) => a.rule_id === id),
  };
  return h;
}

describe('alert engine: Phase 2 acceptance scenarios', () => {
  it('a pollution plume raises trusted exceedance alerts with the right severity', () => {
    const h = harness();
    h.sim = { ...injectPlume(h.sim, 'D', T0), last_station_at: T0 };
    // Route goes home → D first; run until the boat has spent time in D with the plume at full strength.
    h.run(60);
    const d = h.byRule('limit_exceeded').filter((a) => a.zone_id === 'D');
    expect(d.length).toBeGreaterThan(0);
    for (const a of d) {
      expect(a.category).toBe('water_quality');
      // Zone D is Low tier, so severity is high unless the value is more than 2× the limit.
      expect(['high', 'critical']).toContain(a.severity);
      expect(a.title).toMatch(/(above|below) safe limit in zone D/);
      if (a.severity === 'critical') expect(a.message).toMatch(/More than twice the limit/);
    }
  });

  it('a plume near a station raises a station trigger proposing an early mission', () => {
    const h = harness();
    h.sim = { ...injectPlume(h.sim, 'C', T0 - 5 * 60_000), last_station_at: T0 - 301_000 };
    h.run(1);
    const st = h.byRule('station_trigger').filter((a) => a.source_id === 'S2');
    expect(st.length).toBeGreaterThan(0);
    expect(st[0].severity).toBe('high');
    expect(st[0].action).toBe('propose_early_mission');
    expect(h.byRule('limit_exceeded').some((a) => a.source_id === 'S2')).toBe(false);
  });

  it('a drifting probe raises "Possible sensor fault", never a pollution alert for that probe', () => {
    const h = harness();
    h.sim = injectDrift(h.sim, 'turbidity', T0 - 30 * 60_000); // fully ramped
    h.run(40);
    const faults = h.byRule('possible_sensor_fault').filter((a) => a.parameter_key === 'turbidity');
    expect(faults.length).toBeGreaterThan(0);
    for (const a of faults) {
      expect(a.title).toBe('Possible sensor fault: confirmation sample planned');
      expect(a.severity).toBe('warning');
      expect(a.category).toBe('sensor');
      expect(`${a.title} ${a.message}`).not.toMatch(/pollution/i);
    }
    // While drifting, no trusted turbidity exceedance is reported from the boat in clean zones.
    expect(h.byRule('limit_exceeded').filter((a) => a.parameter_key === 'turbidity' && (a.zone_id === 'D' || a.zone_id === 'B'))).toHaveLength(0);
  });

  it('low battery raises one high alert saying the boat returns by itself', () => {
    const h = harness();
    h.run(20);
    h.sim = drainBattery(h.sim, DEFAULT_SETTINGS);
    h.run(10);
    const lb = h.byRule('low_battery');
    expect(lb).toHaveLength(1);
    expect(lb[0].severity).toBe('high');
    expect(lb[0].title).toMatch(/returning to dock/);
    expect(lb[0].message).toMatch(/by itself/);
  });

  it('link loss raises one critical alert after the timeout and mentions the onboard failsafe', () => {
    const h = harness();
    h.run(2);
    h.sim = dropLink(h.sim, h.now);
    h.run(15); // 45 s: below the 60 s timeout
    expect(h.byRule('link_lost')).toHaveLength(0);
    h.run(10); // 75 s
    const ll = h.byRule('link_lost');
    expect(ll).toHaveLength(1);
    expect(ll[0].severity).toBe('critical');
    expect(ll[0].message).toMatch(/Boat following onboard failsafe/);
    h.run(10); // still down: no duplicate
    expect(h.byRule('link_lost')).toHaveLength(1);
  });
});

describe('alert engine: confirmation samples', () => {
  const base = (o: Partial<Reading>): Reading => ({
    id: Math.random().toString(36), source_type: 'boat', source_id: 'B1', ts: iso, lat: 0, lon: 0, zone_id: 'B',
    parameter_key: 'do', value: 6.8, edge_anomaly_flag: false, trust_T: null, imputed: false, survey_id: null, confirmation: false, ...o,
  });
  const lowTrust = () => base({ value: 3.2, edge_anomaly_flag: true, trust_T: 0.28 });

  it('confirms pollution when the confirmation sample is also outside the limit', () => {
    const h = harness();
    h.feed([lowTrust()]);
    h.feed([base({ value: 3.0, edge_anomaly_flag: true, trust_T: 0.93, confirmation: true })]);
    const c = h.byRule('confirmed_pollution');
    expect(c).toHaveLength(1);
    expect(c[0].severity).toBe('critical'); // zone B is Critical tier in the latest survey
    expect(c[0].title).toMatch(/^Confirmed pollution: Dissolved oxygen/);
  });

  it('reports a confirmed fault and flags maintenance after 3 in a row', () => {
    const h = harness();
    for (let i = 1; i <= FAULT_STREAK_FOR_MAINTENANCE; i++) {
      h.feed([lowTrust()]);
      const res = h.feed([base({ value: 6.9, confirmation: true })]);
      if (i < FAULT_STREAK_FOR_MAINTENANCE) expect(res.sensorUpdates).toHaveLength(0);
      else expect(res.sensorUpdates).toEqual([{ id: 'B1-do', maintenance_flag: true }]);
    }
    const f = h.byRule('fault_confirmed');
    expect(f).toHaveLength(1); // merged with a count
    expect(f[0].count).toBe(3);
    expect(f[0].severity).toBe('info');
    expect(f[0].message).toMatch(/3 of 3.*Maintenance flag set/);
  });

  it('the simulator takes an independent confirmation sample at the confirm waypoint', () => {
    const h = harness();
    h.sim = injectDrift(h.sim, 'do', T0 - 30 * 60_000);
    const readings = h.run(200); // home → D → B confirm waypoint
    const conf = readings.filter((r) => r.confirmation);
    expect(conf.length).toBeGreaterThan(0);
    expect(conf.every((r) => r.zone_id === 'B')).toBe(true);
    // Drift does not apply to the confirmation sample, so zone B's clean water is reported.
    expect(conf.find((r) => r.parameter_key === 'do')!.value).toBeGreaterThan(5);
  });
});

describe('alert engine: noise control and escalation', () => {
  it('merges repeats of the same zone/rule/parameter into one alert with a count', () => {
    const h = harness();
    const r = { id: 'x', source_type: 'boat' as const, source_id: 'B1', ts: iso, lat: 0, lon: 0, zone_id: 'C', parameter_key: 'turbidity', value: 4.7, edge_anomaly_flag: false, trust_T: null, imputed: false, survey_id: null, confirmation: false };
    h.feed([r, r, r]);
    const near = h.byRule('near_limit');
    expect(near).toHaveLength(1);
    expect(near[0].count).toBe(3);
    expect(near[0].severity).toBe('warning');
  });

  it('respects the cooldown after an alert is resolved', () => {
    const h = harness();
    const r = { id: 'x', source_type: 'boat' as const, source_id: 'B1', ts: iso, lat: 0, lon: 0, zone_id: 'C', parameter_key: 'turbidity', value: 4.7, edge_anomaly_flag: false, trust_T: null, imputed: false, survey_id: null, confirmation: false };
    h.feed([r]);
    const first = h.byRule('near_limit')[0];
    const resolved = resolve(first, 'u1', 'checked', h.now);
    h.alerts.splice(h.alerts.indexOf(first), 1, resolved);
    h.feed([r]);
    expect(h.byRule('near_limit')).toHaveLength(1); // suppressed by the 60 min cooldown
  });

  it('raises the zone tier rise once for the latest survey', () => {
    const h = harness();
    h.feed([]);
    h.feed([]);
    const tr = h.byRule('zone_tier_rose');
    expect(tr).toHaveLength(1);
    expect(tr[0].zone_id).toBe('B');
    expect(tr[0].title).toBe('Zone B risk rose from Medium to Critical');
    expect(tr[0].severity).toBe('high');
  });

  it('raises calibration due once per overdue sensor', () => {
    const h = harness({ calibrated: false });
    h.feed([]);
    h.feed([]);
    const cd = h.byRule('calibration_due').map((a) => a.parameter_key + '@' + a.source_id).sort();
    expect(cd).toEqual(['do@B1', 'turbidity@S2']);
  });

  it('escalates unacknowledged critical alerts after 15 minutes, and not acknowledged ones', () => {
    const t = Date.parse('2026-10-26T10:00:00Z');
    const a = { severity: 'critical', status: 'open', created_at: new Date(t).toISOString(), escalated_at: null, escalation_count: 0 } as unknown as Alert;
    expect(escalate([a], t + 14 * 60_000, 15).escalated).toHaveLength(0);
    const e = escalate([a], t + 15 * 60_000, 15);
    expect(e.escalated).toHaveLength(1);
    expect(e.alerts[0].escalation_count).toBe(1);
    expect(escalate(e.alerts, t + 20 * 60_000, 15).escalated).toHaveLength(0);
    const acked = acknowledge(a, 'u1', t);
    expect(escalate([acked], t + 60 * 60_000, 15).escalated).toHaveLength(0);
  });

  it('requires a note to resolve', () => {
    const a = { status: 'open' } as Alert;
    expect(() => resolve(a, 'u1', '  ', 0)).toThrow(/note is required/);
    expect(resolve(a, 'u1', 'Probe cleaned', 0).status).toBe('resolved');
  });

  it('skips disabled rules', () => {
    const h = harness();
    const ctxRules = DEFAULT_ALERT_RULES.map((r) => (r.id === 'zone_tier_rose' ? { ...r, enabled: false } : r));
    const res = runEngine(
      { now: T0, settings: DEFAULT_SETTINGS, rules: ctxRules, parameters: h.world.parameters, zones: h.world.zones, stations: h.world.stations, sensors: [], boats: [], surveys: generateHistory(T0).surveys, zoneScores: generateHistory(T0).zoneScores, missions: [], waterBody: null },
      emptyMemory(),
      [],
      [],
      () => 'id',
    );
    expect(res.created).toHaveLength(0);
  });
});
