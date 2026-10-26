// MQTT ↔ database bridge for real boats and stations.
// Boats publish telemetry/samples/events/acks; the bridge writes rows the app already reads
// (boat_telemetry, boats, readings, sensors, missions, waypoints, commands) and forwards
// pending commands to the boat. The app and the alert engine do not change.

import type { MqttClient } from 'mqtt';
import { limitStatus, round } from '../supabase/functions/_shared/limits.ts';
import { zoneAt } from '../supabase/functions/_shared/simCore.ts';
import { provisionalTrust } from '../supabase/functions/_shared/trust.ts';
import type { BoatTelemetry, Command } from '../supabase/functions/_shared/types.ts';
import {
  parseAck,
  parseEvent,
  parseSample,
  parseStation,
  parseTelemetry,
  topics,
  type CommandMessage,
  type SampleMessage,
  type StationMessage,
  type TelemetryMessage,
} from './protocol.ts';
import type { GatewayContext, GatewayStore, NewReading } from './store.ts';

// ------------------------------------------------------------------ pure mapping

function readingRows(
  ctx: GatewayContext,
  base: { source_type: 'boat' | 'station'; source_id: string; ts: string; lat: number; lon: number; zone_id?: string | null; confirmation: boolean },
  values: Record<string, number>,
  trustFor: (key: string) => number,
): NewReading[] {
  const zone = base.zone_id !== undefined ? base.zone_id : zoneAt([base.lat, base.lon], ctx.zones)?.id ?? null;
  const out: NewReading[] = [];
  for (const [key, value] of Object.entries(values)) {
    const p = ctx.parameters.find((x) => x.key === key);
    if (!p || !p.enabled) continue; // unknown or disabled parameters are ignored
    const anomalous = limitStatus(value, p, ctx.settings.near_limit_pct) === 'out';
    out.push({
      source_type: base.source_type,
      source_id: base.source_id,
      ts: base.ts,
      lat: base.lat,
      lon: base.lon,
      zone_id: zone,
      parameter_key: key,
      value,
      edge_anomaly_flag: anomalous,
      trust_T: anomalous ? round(trustFor(key), 2) : null,
      imputed: false,
      survey_id: null,
      confirmation: base.confirmation,
    });
  }
  return out;
}

/** Section 9 telemetry → telemetry row, boat patch, readings and sensor-health changes. */
export function telemetryToRows(ctx: GatewayContext, m: TelemetryMessage) {
  const telemetry: BoatTelemetry = {
    boat_id: m.boat_id,
    ts: m.ts,
    lat: m.lat,
    lon: m.lon,
    heading_deg: m.heading_deg,
    speed_mps: m.speed_mps,
    battery_pct: m.battery_pct,
    mode: m.mode,
    link: m.link,
    mission_id: m.mission_id,
    waypoint_seq: m.waypoint_seq,
  };
  const boat = {
    id: m.boat_id,
    status: 'online' as const,
    battery_pct: m.battery_pct,
    mode: m.mode,
    last_seen: m.ts,
    link_type: m.link,
    position: [m.lat, m.lon] as [number, number],
    heading_deg: m.heading_deg,
    speed_mps: m.speed_mps,
    mission_id: m.mission_id,
    waypoint_seq: m.waypoint_seq,
  };
  const reported = m.edge?.sensor_health ?? {};
  const sensorFor = (key: string) => ctx.sensors.find((s) => s.owner_id === m.boat_id && s.parameter_key === key);
  const health = (key: string) => reported[key] ?? sensorFor(key)?.health;
  const readings = readingRows(ctx, { source_type: 'boat', source_id: m.boat_id, ts: m.ts, lat: m.lat, lon: m.lon, confirmation: false }, m.readings, (k) => provisionalTrust(health(k)));
  const sensorUpdates = Object.entries(reported)
    .map(([key, h]) => ({ sensor: sensorFor(key), h }))
    .filter((x) => x.sensor && x.sensor.health !== x.h)
    .map((x) => ({ id: x.sensor!.id, health: x.h }));
  return { telemetry, boat, readings, sensorUpdates };
}

/** Confirmation samples are independent of the probe, so they get high provisional trust. */
export function sampleToRows(ctx: GatewayContext, m: SampleMessage): NewReading[] {
  return readingRows(ctx, { source_type: 'boat', source_id: m.boat_id, ts: m.ts, lat: m.lat, lon: m.lon, confirmation: m.kind === 'confirmation' }, m.readings, () =>
    m.kind === 'confirmation' ? 0.92 : provisionalTrust(undefined),
  );
}

export function stationToRows(ctx: GatewayContext, m: StationMessage): NewReading[] {
  const st = ctx.stations.find((s) => s.id === m.station_id);
  if (!st) throw new Error(`unknown station ${m.station_id}`);
  return readingRows(ctx, { source_type: 'station', source_id: st.id, ts: m.ts, lat: st.position[0], lon: st.position[1], zone_id: st.zone_id, confirmation: false }, m.readings, () => 0.85);
}

export function commandToMessage(c: Command): CommandMessage {
  return { id: c.id, type: c.type, payload: c.payload, issued_at: c.issued_at };
}

// ------------------------------------------------------------------ the bridge

export interface BridgeOptions {
  boatIds: string[];
  stationIds?: string[];
  /** How often to look for pending commands (ms). */
  pollMs?: number;
  log?: (msg: string) => void;
  now?: () => number;
}

export class Bridge {
  private ctx!: GatewayContext;
  private forwarded = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private log: (msg: string) => void;
  private now: () => number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private mqtt: MqttClient, private store: GatewayStore, private opts: BridgeOptions) {
    this.log = opts.log ?? ((m) => console.log(`[gateway] ${m}`));
    this.now = opts.now ?? Date.now;
  }

  async start() {
    this.ctx = await this.store.loadContext();
    const subs = [
      ...this.opts.boatIds.flatMap((b) => [topics.telemetry(b), topics.samples(b), topics.events(b), topics.acks(b)]),
      ...(this.opts.stationIds ?? this.ctx.stations.map((s) => s.id)).map((s) => topics.station(s)),
    ];
    await this.mqtt.subscribeAsync(subs, { qos: 1 });
    this.mqtt.on('message', (topic, payload) => {
      // Handle messages in arrival order so acks never overtake the telemetry before them.
      this.queue = this.queue.then(() => this.handle(topic, payload)).catch((e: unknown) => this.log(`dropped message on ${topic}: ${(e as Error).message}`));
    });
    this.timer = setInterval(() => void this.pollCommands().catch((e: unknown) => this.log(`command poll failed: ${(e as Error).message}`)), this.opts.pollMs ?? 1000);
    this.log(`listening for ${this.opts.boatIds.join(', ')}`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Wait until every received message has been written (tests). */
  idle() {
    return this.queue;
  }

  async handle(topic: string, payload: Buffer | string) {
    const raw = JSON.parse(payload.toString());
    const kind = topic.split('/').pop();
    if (topic.startsWith('aquaq/stations/')) {
      const m = parseStation(raw);
      await this.store.writeReadings(stationToRows(this.ctx, m));
      await this.store.touchStation(m.station_id, m.ts);
      return;
    }
    const boatId = topic.split('/')[2];
    switch (kind) {
      case 'telemetry': {
        const m = parseTelemetry(raw);
        if (m.boat_id !== boatId) throw new Error(`boat_id ${m.boat_id} does not match topic ${boatId}`);
        const rows = telemetryToRows(this.ctx, m);
        await this.store.writeTelemetry(rows.telemetry, rows.boat);
        if (rows.readings.length) await this.store.writeReadings(rows.readings);
        for (const u of rows.sensorUpdates) {
          await this.store.updateSensor(u.id, { health: u.health });
          this.ctx.sensors = this.ctx.sensors.map((s) => (s.id === u.id ? { ...s, health: u.health } : s));
        }
        return;
      }
      case 'samples':
        await this.store.writeReadings(sampleToRows(this.ctx, parseSample(raw)));
        return;
      case 'acks': {
        const a = parseAck(raw);
        await this.store.updateCommand(a.id, a.status === 'acknowledged' ? { status: 'acknowledged', ack_at: a.ts } : { status: a.status, done_at: a.ts, result: a.result ?? null });
        return;
      }
      case 'events': {
        const e = parseEvent(raw);
        if (e.type === 'waypoint') await this.store.updateWaypoint(e.mission_id, e.seq, e.status);
        else {
          const patch: Record<string, unknown> = { status: e.status };
          if (e.status === 'running') patch.started_at = e.ts;
          if (e.status === 'completed' || e.status === 'aborted') patch.ended_at = e.ts;
          if (e.note) patch.note = e.note;
          await this.store.updateMission(e.mission_id, patch);
        }
        return;
      }
    }
  }

  /** Forward new pending commands; close ones the boat never acknowledged within the timeout. */
  async pollCommands() {
    const pending = await this.store.pendingCommands(this.opts.boatIds);
    const timeoutMs = this.ctx.settings.command_timeout_s * 1000;
    for (const c of pending) {
      if (this.now() - new Date(c.issued_at).getTime() > timeoutMs) {
        await this.store.updateCommand(c.id, {
          status: 'timed_out',
          done_at: new Date(this.now()).toISOString(),
          result: `No acknowledgement from the boat within ${this.ctx.settings.command_timeout_s} s.`,
        });
        continue;
      }
      if (this.forwarded.has(c.id)) continue;
      this.forwarded.add(c.id);
      await this.mqtt.publishAsync(topics.commands(c.boat_id), JSON.stringify(commandToMessage(c)), { qos: 1 });
    }
  }
}
