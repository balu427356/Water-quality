// Boat (and station) emulator that speaks the gateway's MQTT protocol, driven by the same
// simulator core as the demo. Use it to test the gateway end to end without hardware.
import type { MqttClient } from 'mqtt';
import { mulberry32 } from '../supabase/functions/_shared/demoLake.ts';
import { TELEMETRY_INTERVAL_S, initialSimState, stepSim, type SimState, type SimWorld, type StepResult } from '../supabase/functions/_shared/simCore.ts';
import type { Boat, Command, Waypoint } from '../supabase/functions/_shared/types.ts';
import { topics, type AckMessage, type CommandMessage, type EventMessage, type SampleMessage, type StationMessage, type TelemetryMessage } from './protocol.ts';

export class BoatEmulator {
  sim: SimState;
  private commands: Command[] = [];
  private rng = mulberry32(99);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private mqtt: MqttClient, private world: SimWorld, boat: Boat, waypoints: Waypoint[] = [], now = Date.now()) {
    this.sim = initialSimState({ ...boat, mission_id: waypoints.length ? boat.mission_id : null }, waypoints, now);
  }

  get boatId() {
    return this.sim.boat.id;
  }

  async start(intervalMs = TELEMETRY_INTERVAL_S * 1000) {
    await this.mqtt.subscribeAsync(topics.commands(this.boatId), { qos: 1 });
    this.mqtt.on('message', (topic, payload) => {
      if (topic !== topics.commands(this.boatId)) return;
      const m = JSON.parse(payload.toString()) as CommandMessage;
      if (this.commands.some((c) => c.id === m.id)) return; // QoS 1 may redeliver
      this.commands.push({ id: m.id, boat_id: this.boatId, type: m.type, payload: m.payload ?? {}, issued_by: 'remote', issued_at: m.issued_at, status: 'pending', ack_at: null, done_at: null, result: null });
    });
    if (intervalMs > 0) this.timer = setInterval(() => void this.step(Date.now()), intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** One telemetry interval: run the boat, then publish what it would send. */
  async step(now: number): Promise<StepResult> {
    const missionBefore = this.sim.boat.mission_id;
    const r = stepSim(this.sim, this.world, now, this.rng, this.commands.filter((c) => c.status === 'pending' || c.status === 'acknowledged'));
    this.sim = r.state;
    for (const s of r.sensorHealth) this.world.sensors = this.world.sensors.map((x) => (x.id === s.id ? { ...x, health: s.health } : x));
    const ts = new Date(now).toISOString();
    const pub = (topic: string, body: unknown) => this.mqtt.publishAsync(topic, JSON.stringify(body), { qos: 1 });
    const id = this.boatId;

    for (const u of r.commandUpdates) {
      this.commands = this.commands.map((c) => (c.id === u.id ? { ...c, ...u } : c));
      if (u.ack_at) await pub(topics.acks(id), { id: u.id, ts, status: 'acknowledged' } satisfies AckMessage);
      if (u.done_at) await pub(topics.acks(id), { id: u.id, ts, status: u.status === 'executed' ? 'executed' : 'failed', result: u.result } as AckMessage);
    }
    if (r.telemetry) {
      const probe = r.readings.filter((x) => x.source_type === 'boat' && !x.confirmation && x.id.startsWith('L'));
      const msg: TelemetryMessage = {
        ...r.telemetry,
        readings: Object.fromEntries(probe.map((x) => [x.parameter_key, x.value])),
        edge: {
          anomaly: probe.some((x) => x.edge_anomaly_flag),
          sensor_health: Object.fromEntries(this.world.sensors.filter((s) => s.owner_id === id && s.health !== 'ok').map((s) => [s.parameter_key, s.health])),
        },
      };
      await pub(topics.telemetry(id), msg);
    }
    const sample = (kind: SampleMessage['kind'], prefix: string) => {
      const rs = r.readings.filter((x) => x.source_type === 'boat' && x.id.startsWith(prefix));
      if (!rs.length) return null;
      return { boat_id: id, ts, lat: rs[0].lat, lon: rs[0].lon, kind, readings: Object.fromEntries(rs.map((x) => [x.parameter_key, x.value])) } satisfies SampleMessage;
    };
    const conf = sample('confirmation', 'C');
    if (conf) await pub(topics.samples(id), conf);
    const manual = sample('manual', 'M');
    if (manual) await pub(topics.samples(id), manual);
    const byStation = new Map<string, Record<string, number>>();
    for (const x of r.readings.filter((x) => x.source_type === 'station')) byStation.set(x.source_id, { ...(byStation.get(x.source_id) ?? {}), [x.parameter_key]: x.value });
    for (const [sid, readings] of byStation) await pub(topics.station(sid), { station_id: sid, ts, readings } satisfies StationMessage);
    for (const u of r.missionUpdates) {
      await pub(topics.events(id), { boat_id: id, ts, type: 'mission_status', mission_id: u.mission_id, status: u.status, note: u.note } satisfies EventMessage);
    }
    const wpMission = this.sim.boat.mission_id ?? missionBefore;
    for (const e of r.events) {
      if (e.type === 'waypoint_reached' && wpMission) await pub(topics.events(id), { boat_id: id, ts, type: 'waypoint', mission_id: wpMission, seq: e.seq, status: 'reached' } satisfies EventMessage);
    }
    return r;
  }
}
