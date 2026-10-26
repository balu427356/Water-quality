// MQTT contract between boats/stations and the gateway. Telemetry follows section 9 of the brief.
import type { BoatMode, CommandPayload, CommandType, LinkType, MissionStatus, SensorHealth, WaypointStatus } from '../supabase/functions/_shared/types.ts';

export const topics = {
  /** boat → server, every 2–5 s: TelemetryMessage */
  telemetry: (boat: string) => `aquaq/boats/${boat}/telemetry`,
  /** boat → server: SampleMessage (confirmation samples and "take sample here") */
  samples: (boat: string) => `aquaq/boats/${boat}/samples`,
  /** boat → server: EventMessage (mission status, waypoint progress) */
  events: (boat: string) => `aquaq/boats/${boat}/events`,
  /** server → boat: CommandMessage (QoS 1) */
  commands: (boat: string) => `aquaq/boats/${boat}/commands`,
  /** boat → server: AckMessage */
  acks: (boat: string) => `aquaq/boats/${boat}/acks`,
  /** station → server: StationMessage */
  station: (station: string) => `aquaq/stations/${station}/readings`,
};

export interface TelemetryMessage {
  boat_id: string;
  ts: string;
  lat: number;
  lon: number;
  heading_deg: number;
  speed_mps: number;
  battery_pct: number;
  mode: BoatMode;
  link: LinkType;
  mission_id: string | null;
  waypoint_seq: number | null;
  readings: Record<string, number>;
  edge?: { anomaly?: boolean; sensor_health?: Record<string, SensorHealth> };
}

export interface SampleMessage {
  boat_id: string;
  ts: string;
  lat: number;
  lon: number;
  kind: 'confirmation' | 'manual';
  readings: Record<string, number>;
}

export type EventMessage =
  | { boat_id: string; ts: string; type: 'mission_status'; mission_id: string; status: MissionStatus; note?: string }
  | { boat_id: string; ts: string; type: 'waypoint'; mission_id: string; seq: number; status: WaypointStatus };

export interface CommandMessage {
  id: string;
  type: CommandType;
  payload: CommandPayload;
  issued_at: string;
}

export interface AckMessage {
  id: string;
  ts: string;
  status: 'acknowledged' | 'executed' | 'failed';
  result?: string;
}

export interface StationMessage {
  station_id: string;
  ts: string;
  readings: Record<string, number>;
}

const MODES: BoatMode[] = ['IDLE', 'AUTO', 'MANUAL', 'RETURNING', 'EMERGENCY_STOP'];
const LINKS: LinkType[] = ['4G', '5G', 'satellite', 'none'];

const num = (v: unknown, name: string) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${name} must be a number`);
  return v;
};
const iso = (v: unknown, name: string) => {
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) throw new Error(`${name} must be an ISO timestamp`);
  return new Date(v).toISOString();
};
const readingsOf = (v: unknown) => {
  if (!v || typeof v !== 'object') throw new Error('readings must be an object');
  const out: Record<string, number> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = num(x, `readings.${k}`);
  return out;
};

/** Validate an incoming telemetry message (untrusted input from the network). */
export function parseTelemetry(raw: unknown): TelemetryMessage {
  const m = raw as Record<string, unknown>;
  if (!m || typeof m !== 'object') throw new Error('telemetry must be an object');
  if (typeof m.boat_id !== 'string') throw new Error('boat_id missing');
  if (!MODES.includes(m.mode as BoatMode)) throw new Error(`unknown mode ${String(m.mode)}`);
  if (!LINKS.includes(m.link as LinkType)) throw new Error(`unknown link ${String(m.link)}`);
  const battery = num(m.battery_pct, 'battery_pct');
  if (battery < 0 || battery > 100) throw new Error('battery_pct out of range');
  return {
    boat_id: m.boat_id,
    ts: iso(m.ts, 'ts'),
    lat: num(m.lat, 'lat'),
    lon: num(m.lon, 'lon'),
    heading_deg: num(m.heading_deg, 'heading_deg'),
    speed_mps: num(m.speed_mps, 'speed_mps'),
    battery_pct: battery,
    mode: m.mode as BoatMode,
    link: m.link as LinkType,
    mission_id: typeof m.mission_id === 'string' ? m.mission_id : null,
    waypoint_seq: typeof m.waypoint_seq === 'number' ? m.waypoint_seq : null,
    readings: m.readings == null ? {} : readingsOf(m.readings),
    edge: (m.edge as TelemetryMessage['edge']) ?? undefined,
  };
}

export function parseSample(raw: unknown): SampleMessage {
  const m = raw as Record<string, unknown>;
  if (m?.kind !== 'confirmation' && m?.kind !== 'manual') throw new Error('kind must be confirmation or manual');
  return { boat_id: String(m.boat_id), ts: iso(m.ts, 'ts'), lat: num(m.lat, 'lat'), lon: num(m.lon, 'lon'), kind: m.kind, readings: readingsOf(m.readings) };
}

export function parseAck(raw: unknown): AckMessage {
  const m = raw as Record<string, unknown>;
  if (typeof m?.id !== 'string') throw new Error('ack id missing');
  if (m.status !== 'acknowledged' && m.status !== 'executed' && m.status !== 'failed') throw new Error(`unknown ack status ${String(m.status)}`);
  return { id: m.id, ts: iso(m.ts, 'ts'), status: m.status, result: typeof m.result === 'string' ? m.result : undefined };
}

export function parseEvent(raw: unknown): EventMessage {
  const m = raw as Record<string, unknown>;
  if (m?.type === 'mission_status' && typeof m.mission_id === 'string' && typeof m.status === 'string') {
    return { boat_id: String(m.boat_id), ts: iso(m.ts, 'ts'), type: 'mission_status', mission_id: m.mission_id, status: m.status as MissionStatus, note: typeof m.note === 'string' ? m.note : undefined };
  }
  if (m?.type === 'waypoint' && typeof m.mission_id === 'string') {
    return { boat_id: String(m.boat_id), ts: iso(m.ts, 'ts'), type: 'waypoint', mission_id: m.mission_id, seq: num(m.seq, 'seq'), status: m.status as WaypointStatus };
  }
  throw new Error(`unknown event ${String(m?.type)}`);
}

export function parseStation(raw: unknown): StationMessage {
  const m = raw as Record<string, unknown>;
  if (typeof m?.station_id !== 'string') throw new Error('station_id missing');
  return { station_id: m.station_id, ts: iso(m.ts, 'ts'), readings: readingsOf(m.readings) };
}
