import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import mqtt, { type MqttClient } from 'mqtt';
import { createBroker } from 'aedes';
import type Aedes from 'aedes';
import { demoBoat, demoParameters, demoSensors, demoStations, demoWaterBody, demoZones } from '../supabase/functions/_shared/demoLake.ts';
import { fromLocal } from '../supabase/functions/_shared/geo.ts';
import { TELEMETRY_INTERVAL_S, injectDrift } from '../supabase/functions/_shared/simCore.ts';
import { DEFAULT_SETTINGS, type Command, type CommandPayload, type CommandType } from '../supabase/functions/_shared/types.ts';
import { Bridge, telemetryToRows } from './bridge.ts';
import { BoatEmulator } from './emulator.ts';
import { parseTelemetry } from './protocol.ts';
import { MemoryStore } from './store.ts';

const T0 = Date.parse('2026-10-26T10:00:00+05:30');
const iso = new Date(T0).toISOString();
const ctx = () => ({ zones: demoZones(), parameters: demoParameters(), sensors: demoSensors(T0), stations: demoStations(iso), settings: DEFAULT_SETTINGS });

describe('telemetry mapping (section 9 message)', () => {
  const msg = {
    boat_id: 'B1', ts: '2026-10-26T10:15:00+05:30', lat: 12.9729, lon: 79.1585, heading_deg: 140, speed_mps: 0.8,
    battery_pct: 72, mode: 'AUTO', link: '4G', mission_id: 'M-0012', waypoint_seq: 7,
    readings: { ph: 7.4, do: 4.2, temperature: 28.1, turbidity: 6.3, conductivity: 620, tds: 410, orp: 180, bogus: 1 },
    edge: { anomaly: true, sensor_health: { do: 'drift_suspected' } },
  };

  it('writes telemetry, zone-tagged readings and provisional trust', () => {
    const rows = telemetryToRows(ctx(), parseTelemetry(msg));
    expect(rows.telemetry).toMatchObject({ boat_id: 'B1', battery_pct: 72, mode: 'AUTO', ts: '2026-10-26T04:45:00.000Z' });
    expect(rows.readings.map((r) => r.parameter_key)).not.toContain('bogus');
    expect(new Set(rows.readings.map((r) => r.zone_id))).toEqual(new Set(['A']));
    const doR = rows.readings.find((r) => r.parameter_key === 'do')!;
    expect(doR).toMatchObject({ edge_anomaly_flag: true, trust_T: 0.3 }); // drifting probe → low trust
    const turb = rows.readings.find((r) => r.parameter_key === 'turbidity')!;
    expect(turb).toMatchObject({ edge_anomaly_flag: true, trust_T: 0.88 });
    expect(rows.readings.find((r) => r.parameter_key === 'ph')).toMatchObject({ edge_anomaly_flag: false, trust_T: null });
    expect(rows.sensorUpdates).toEqual([{ id: 'B1-do', health: 'drift_suspected' }]);
  });

  it('rejects malformed messages', () => {
    expect(() => parseTelemetry({ ...msg, mode: 'TURBO' })).toThrow(/unknown mode/);
    expect(() => parseTelemetry({ ...msg, battery_pct: 140 })).toThrow(/battery_pct/);
    expect(() => parseTelemetry({ ...msg, ts: 'yesterday' })).toThrow(/ISO/);
    expect(() => parseTelemetry({ ...msg, readings: { ph: 'high' } })).toThrow(/readings.ph/);
  });
});

describe('gateway end to end over MQTT', () => {
  let server: Server;
  let broker: Aedes;
  let url: string;
  const clients: MqttClient[] = [];

  beforeEach(async () => {
    broker = await createBroker();
    server = createServer(broker.handle);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `mqtt://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) await c.endAsync(true);
    await new Promise<void>((r) => broker.close(() => r()));
    await new Promise<void>((r) => server.close(() => r()));
  });

  async function setup() {
    const store = new MemoryStore(ctx());
    const gw = await mqtt.connectAsync(url, { clientId: 'gw' });
    const boatClient = await mqtt.connectAsync(url, { clientId: 'boat' });
    clients.push(gw, boatClient);
    let now = T0;
    const bridge = new Bridge(gw, store, { boatIds: ['B1'], pollMs: 60_000, log: () => {}, now: () => now });
    await bridge.start();
    const world = { waterBody: demoWaterBody(), zones: demoZones(), parameters: demoParameters(), stations: demoStations(iso), sensors: demoSensors(T0), settings: DEFAULT_SETTINGS };
    const emu = new BoatEmulator(boatClient, world, { ...demoBoat(iso), mode: 'IDLE' }, [], T0);
    await emu.start(0);
    let n = 0;
    const settle = async () => {
      // Let MQTT deliver both ways, then let the bridge finish its writes.
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 20));
      await bridge.idle();
    };
    const h = {
      store,
      emu,
      bridge,
      get now() {
        return now;
      },
      issue(type: CommandType, payload: CommandPayload = {}) {
        const c: Command = { id: `C${++n}`, boat_id: 'B1', type, payload, issued_by: 'u', issued_at: new Date(now).toISOString(), status: 'pending', ack_at: null, done_at: null, result: null };
        store.commands.push(c);
        return c.id;
      },
      async tick(k = 1) {
        for (let i = 0; i < k; i++) {
          await bridge.pollCommands();
          await settle();
          now += TELEMETRY_INTERVAL_S * 1000;
          await emu.step(now);
          await settle();
        }
      },
      cmd: (id: string) => store.commands.find((c) => c.id === id)!,
      /** Move the clock without the boat sending anything. */
      advance(ms: number) {
        now += ms;
      },
    };
    return h;
  }

  it('turns boat telemetry into rows the app reads', async () => {
    const h = await setup();
    await h.tick(3);
    expect(h.store.telemetry).toHaveLength(3);
    expect(h.store.boats.get('B1')).toMatchObject({ mode: 'IDLE', status: 'online' });
    expect(h.store.readings.filter((r) => r.source_type === 'boat')).toHaveLength(3 * 7);
    expect(h.store.readings.every((r) => r.zone_id === 'D')).toBe(true); // the dock is in zone D
  });

  it('forwards commands and records acknowledged → executed', async () => {
    const h = await setup();
    const id = h.issue('TAKE_SAMPLE');
    await h.tick(1);
    expect(h.cmd(id)).toMatchObject({ status: 'acknowledged' });
    await h.tick(1);
    expect(h.cmd(id)).toMatchObject({ status: 'executed' });
    expect(h.store.readings.some((r) => r.source_type === 'boat' && r.confirmation === false)).toBe(true);
  });

  it('runs a mission: load, start, progress, completion', async () => {
    const h = await setup();
    const o: [number, number] = [12.9716, 79.1588];
    const wps = [
      { seq: 1, ...ll(fromLocal(o, 180, -100)), action: 'confirm_sample' as const },
      { seq: 2, ...ll(fromLocal(o, 200, -140)), action: 'transit' as const },
    ];
    h.issue('LOAD_MISSION', { mission_id: 'M-0100', waypoints: wps });
    await h.tick(2);
    expect(h.store.missions.get('M-0100')).toMatchObject({ status: 'sent' });
    h.issue('START_MISSION', { mission_id: 'M-0100' });
    await h.tick(2);
    expect(h.store.missions.get('M-0100')).toMatchObject({ status: 'running' });
    await h.tick(40);
    expect(h.store.waypoints.get('M-0100|1')).toBe('reached');
    expect(h.store.missions.get('M-0100')).toMatchObject({ status: 'completed' });
    expect(h.store.missions.get('M-0100')!.ended_at).toBeTruthy();
    // The confirmation sample arrives flagged as such.
    expect(h.store.readings.some((r) => r.confirmation)).toBe(true);
  }, 30_000);

  it('marks commands the boat never acknowledges as timed out', async () => {
    const h = await setup();
    const id = h.issue('GOTO', { target: [12.9716, 79.1588] });
    await h.bridge.pollCommands(); // forwarded, but the boat is silent
    h.advance(11_000);
    await h.bridge.pollCommands();
    expect(h.cmd(id)).toMatchObject({ status: 'timed_out', result: 'No acknowledgement from the boat within 10 s.' });
  });

  it('carries probe drift through as low-trust readings and a sensor-health update', async () => {
    const h = await setup();
    h.emu.sim = injectDrift(h.emu.sim, 'do', T0 - 20 * 60_000);
    await h.tick(2);
    const doRows = h.store.readings.filter((r) => r.parameter_key === 'do' && r.edge_anomaly_flag);
    expect(doRows.length).toBeGreaterThan(0);
    expect(doRows.every((r) => (r.trust_T ?? 1) < 0.5)).toBe(true);
    expect(h.store.sensorPatches).toContainEqual({ id: 'B1-do', patch: { health: 'drift_suspected' } });
  });
});

function ll(p: [number, number]) {
  return { lat: p[0], lon: p[1] };
}
