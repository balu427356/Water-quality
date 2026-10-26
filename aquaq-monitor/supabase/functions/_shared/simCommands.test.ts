import { describe, expect, it } from 'vitest';
import { demoBoat, demoMission, demoParameters, demoSensors, demoStations, demoWaterBody, demoZones, mulberry32 } from './demoLake.ts';
import { distanceM, fromLocal, pointInPolygon } from './geo.ts';
import { TELEMETRY_INTERVAL_S, dropLink, initialSimState, stepSim, type SimState, type SimWorld, type StepResult } from './simCore.ts';
import { DEFAULT_SETTINGS, type Command, type CommandPayload, type CommandType } from './types.ts';

const T0 = Date.parse('2026-10-26T10:00:00+05:30');
const iso = new Date(T0).toISOString();
const origin: [number, number] = [12.9716, 79.1588];

function harness(idle = true) {
  const world: SimWorld = {
    waterBody: demoWaterBody(), zones: demoZones(), parameters: demoParameters(), stations: demoStations(iso),
    sensors: demoSensors(T0), settings: DEFAULT_SETTINGS,
  };
  let sim: SimState = initialSimState(demoBoat(iso), idle ? [] : demoMission(iso).waypoints, T0);
  let now = T0;
  let cmds: Command[] = [];
  const rng = mulberry32(5);
  let n = 0;
  const h = {
    world,
    get sim() { return sim; },
    set sim(v: SimState) { sim = v; },
    get cmds() { return cmds; },
    send(type: CommandType, payload: CommandPayload = {}) {
      const c: Command = { id: `C${++n}`, boat_id: 'B1', type, payload, issued_by: 'u', issued_at: new Date(now).toISOString(), status: 'pending', ack_at: null, done_at: null, result: null };
      cmds.push(c);
      return c.id;
    },
    tick(k = 1): StepResult[] {
      const out: StepResult[] = [];
      for (let i = 0; i < k; i++) {
        now += TELEMETRY_INTERVAL_S * 1000;
        const r = stepSim(sim, world, now, rng, cmds.filter((c) => c.status === 'pending' || c.status === 'acknowledged'));
        sim = r.state;
        cmds = cmds.map((c) => ({ ...c, ...(r.commandUpdates.find((u) => u.id === c.id) ?? {}) }));
        out.push(r);
      }
      return out;
    },
    cmd: (id: string) => cmds.find((c) => c.id === id)!,
    get now() { return now; },
  };
  return h;
}

describe('simulator command handling', () => {
  it('goes pending → acknowledged → executed', () => {
    const h = harness();
    const id = h.send('TAKE_SAMPLE');
    h.tick();
    expect(h.cmd(id).status).toBe('acknowledged');
    const [r] = h.tick();
    expect(h.cmd(id).status).toBe('executed');
    expect(r.events.map((e) => e.type)).toContain('sample_taken');
  });

  it('executes an emergency stop in the same tick and holds the boat', () => {
    const h = harness(false);
    h.tick(5);
    const id = h.send('EMERGENCY_STOP');
    const [r] = h.tick();
    expect(h.cmd(id).status).toBe('executed');
    expect(h.sim.boat.mode).toBe('EMERGENCY_STOP');
    expect(r.missionUpdates).toContainEqual(expect.objectContaining({ status: 'paused' }));
    const pos = h.sim.boat.position;
    h.tick(5);
    expect(distanceM(pos, h.sim.boat.position)).toBe(0);
  });

  it('loads and starts a mission, which completes at the dock without looping', () => {
    const h = harness();
    const wps = [
      { seq: 1, ...ll(150, -100), action: 'sample' as const },
      { seq: 2, ...ll(200, -140), action: 'transit' as const },
    ];
    h.send('LOAD_MISSION', { mission_id: 'M-9', waypoints: wps });
    const loaded = h.tick(2);
    expect(loaded.flatMap((r) => r.missionUpdates)).toContainEqual({ mission_id: 'M-9', status: 'sent' });
    h.send('START_MISSION', { mission_id: 'M-9' });
    const started = h.tick(2);
    expect(started.flatMap((r) => r.missionUpdates)).toContainEqual(expect.objectContaining({ mission_id: 'M-9', status: 'running' }));
    expect(h.sim.boat.mode).toBe('AUTO');
    const rest = h.tick(80);
    expect(rest.flatMap((r) => r.missionUpdates)).toContainEqual(expect.objectContaining({ mission_id: 'M-9', status: 'completed' }));
    expect(h.sim.boat.mode).toBe('IDLE');
    expect(h.sim.boat.mission_id).toBeNull();
  });

  it('refuses to start a mission that was not loaded', () => {
    const h = harness();
    const id = h.send('START_MISSION', { mission_id: 'M-X' });
    h.tick(2);
    expect(h.cmd(id)).toMatchObject({ status: 'failed', result: 'That mission is not loaded on the boat.' });
  });

  it('return home aborts the running mission', () => {
    const h = harness(false);
    h.tick(3);
    h.send('RETURN_HOME');
    const r = h.tick(2);
    expect(r.flatMap((x) => x.missionUpdates)).toContainEqual(expect.objectContaining({ mission_id: 'M-0012', status: 'aborted' }));
    expect(h.sim.boat.mode).toBe('RETURNING');
  });

  it('goes to a point and holds there', () => {
    const h = harness();
    const target = fromLocal(origin, 180, -120);
    h.send('GOTO', { target });
    h.tick(40);
    expect(distanceM(h.sim.boat.position, target)).toBeLessThan(0.5);
    expect(h.sim.boat.mode).toBe('IDLE');
  });

  it('manual mode: deadman stop, max speed clamp, onboard geofence and the 2-minute idle exit', () => {
    const h = harness();
    h.send('ENTER_MANUAL');
    h.tick(2);
    expect(h.sim.boat.mode).toBe('MANUAL');
    h.send('MANUAL_DRIVE', { heading_deg: 180, speed_mps: 5 }); // above the limit: the boat clamps it
    const [r] = h.tick();
    expect(r.state.boat.speed_mps).toBeLessThanOrEqual(DEFAULT_SETTINGS.manual_max_speed_mps);
    h.tick(3); // no more input: deadman stops the boat
    expect(h.sim.boat.speed_mps).toBe(0);
    // Drive south toward the shore repeatedly: the boat stops at the geofence.
    for (let i = 0; i < 150; i++) {
      h.send('MANUAL_DRIVE', { heading_deg: 180, speed_mps: 1 });
      h.tick();
    }
    expect(pointInPolygon(h.sim.boat.position, h.world.waterBody.geofence)).toBe(true);
    // 2 minutes without input → leaves manual mode.
    const after = h.tick(Math.ceil(125 / TELEMETRY_INTERVAL_S));
    expect(after.flatMap((x) => x.events).map((e) => e.type)).toContain('manual_timeout');
    expect(h.sim.boat.mode).toBe('IDLE');
  });

  it('does not process commands while the link is down', () => {
    const h = harness();
    h.sim = dropLink(h.sim, h.now);
    const id = h.send('TAKE_SAMPLE');
    h.tick(5);
    expect(h.cmd(id).status).toBe('pending');
  });
});

function ll(x: number, y: number) {
  const [lat, lon] = fromLocal(origin, x, y);
  return { lat, lon };
}
