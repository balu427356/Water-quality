import { describe, expect, it } from 'vitest';
import { demoBoat, demoMission, demoParameters, demoSensors, demoStations, demoWaterBody, demoZones, mulberry32 } from './demoLake.ts';
import { distanceM } from './geo.ts';
import { CRUISE_SPEED_MPS, TELEMETRY_INTERVAL_S, drainBattery, dropLink, initialSimState, injectDrift, injectPlume, stepSim, type SimState } from './simCore.ts';
import { DEFAULT_SETTINGS } from './types.ts';

const T0 = Date.parse('2026-10-26T10:00:00+05:30');
const iso = new Date(T0).toISOString();

function setup() {
  const world = {
    waterBody: demoWaterBody(),
    zones: demoZones(),
    parameters: demoParameters(),
    stations: demoStations(iso),
    sensors: demoSensors(T0).map((s) => ({ ...s, health: 'ok' as const })),
    settings: DEFAULT_SETTINGS,
  };
  const state = initialSimState(demoBoat(iso), demoMission(iso).waypoints, T0);
  return { world, state };
}

function run(state: SimState, world: ReturnType<typeof setup>['world'], ticks: number, start = T0) {
  const rng = mulberry32(1);
  let s = state;
  const out = [];
  for (let i = 1; i <= ticks; i++) {
    const r = stepSim(s, world, start + i * TELEMETRY_INTERVAL_S * 1000, rng);
    s = r.state;
    out.push(r);
  }
  return { state: s, results: out };
}

describe('simulator', () => {
  it('moves at 0.8 m/s and writes telemetry every tick', () => {
    const { world, state } = setup();
    const { state: s, results } = run(state, world, 10);
    expect(results.every((r) => r.telemetry)).toBe(true);
    const moved = distanceM(state.boat.position, s.boat.position);
    expect(moved).toBeCloseTo(CRUISE_SPEED_MPS * TELEMETRY_INTERVAL_S * 10, 0);
    expect(s.boat.mode).toBe('AUTO');
  });

  it('drains battery in proportion to distance', () => {
    const { world, state } = setup();
    const { state: s } = run(state, world, 100);
    expect(s.boat.battery_pct).toBeLessThan(state.boat.battery_pct);
    expect(state.boat.battery_pct - s.boat.battery_pct).toBeLessThan(5);
  });

  it('stops telemetry while the link is down and holds after the timeout', () => {
    const { world, state } = setup();
    const down = dropLink(state, T0);
    const { results } = run(down, world, 30); // 90 s
    expect(results.slice(0, 29).every((r) => r.telemetry === null)).toBe(true);
    expect(results[0].events).toContainEqual({ type: 'link_lost' });
    // After 60 s the boat holds position (onboard failsafe).
    expect(results[25].state.boat.speed_mps).toBe(0);
    const after = run(results[29].state, world, 2, T0 + 30 * 3000);
    expect(after.results.some((r) => r.telemetry !== null)).toBe(true);
  });

  it('returns home on low battery', () => {
    const { world, state } = setup();
    const away = run(state, world, 20).state; // leave the dock first
    const low = drainBattery(away, DEFAULT_SETTINGS);
    const { results } = run(low, world, 1, T0 + 20 * 3000);
    expect(results[0].events.map((e) => e.type)).toContain('low_battery_return');
    expect(results[0].state.boat.mode).toBe('RETURNING');
  });

  it('a drifting probe produces low-trust anomalies and flags the sensor', () => {
    const { world, state } = setup();
    const { results } = run(injectDrift(state, 'do', T0 - 20 * 60_000), world, 5);
    const doReadings = results.flatMap((r) => r.readings).filter((r) => r.parameter_key === 'do' && r.edge_anomaly_flag);
    expect(doReadings.length).toBeGreaterThan(0);
    expect(doReadings.every((r) => (r.trust_T ?? 1) < 0.5)).toBe(true);
    expect(results.flatMap((r) => r.sensorHealth)).toContainEqual({ id: 'B1-do', health: 'drift_suspected' });
  });

  it('a plume raises trusted exceedances at the station in that zone', () => {
    const { world, state } = setup();
    const s = { ...injectPlume(state, 'C', T0 - 5 * 60_000), last_station_at: T0 - 301_000 };
    const { results } = run(s, world, 1);
    const s2 = results[0].readings.filter((r) => r.source_id === 'S2' && r.parameter_key === 'turbidity');
    expect(s2).toHaveLength(1);
    expect(s2[0].edge_anomaly_flag).toBe(true);
    expect(s2[0].trust_T!).toBeGreaterThanOrEqual(0.5);
  });
});
