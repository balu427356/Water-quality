// Pure boat + station simulator. Used by the in-browser demo data source and by the
// `simulator` Edge Function, which persists SimState between invocations.

import { BASELINE, BOAT_PROBES, LIVE_POLLUTION, STATION_PROBES, clamp01, diurnal, gaussian, modelValue } from './demoLake.ts';
import { bearingDeg, distanceM, moveM, pointInPolygon } from './geo.ts';
import { limitStatus, round } from './limits.ts';
import type {
  Boat,
  BoatTelemetry,
  Command,
  CommandStatus,
  CommandType,
  LatLon,
  MissionStatus,
  Parameter,
  Reading,
  Sensor,
  Settings,
  Station,
  WaterBody,
  Waypoint,
  Zone,
} from './types.ts';

export const CRUISE_SPEED_MPS = 0.8;
export const TELEMETRY_INTERVAL_S = 3;
export const STATION_INTERVAL_S = 300;
const LINK_DROP_S = 90;
const PLUME_DURATION_S = 30 * 60;
const DRIFT_RAMP_S = 10 * 60;
/** Fully developed drift per probe: enough to push clean-water readings past the limit. */
const DRIFT_FULL: Record<string, number> = { ph: 1.6, do: -3.2, turbidity: 4, conductivity: 250, tds: 900, orp: -120 };
const BATTERY_PCT_PER_100M = 0.6;
const CHARGE_PCT_PER_S = 0.2;

export interface SimInjections {
  drift: { parameter_key: string; started_at: number } | null;
  plume: { zone_id: string; started_at: number } | null;
  link_down_until: number | null;
}

export type SimPhase = 'mission' | 'paused' | 'goto' | 'manual' | 'returning' | 'charging' | 'idle' | 'stopped';

export interface SimState {
  boat: Boat;
  /** Route of the active mission. */
  waypoints: Waypoint[];
  target_idx: number;
  phase: SimPhase;
  /** Why the boat is returning/idle/holding, shown in the boat panel. */
  phase_reason: string | null;
  link_down_since: number | null;
  last_station_at: number;
  injections: SimInjections;
  /** Simulated seconds per real second (demo only; the Edge Function always uses 1). */
  speed_factor: number;
  /** Cumulative distance travelled, for battery accounting. */
  odometer_m: number;
  /** Mission received with LOAD_MISSION and not yet started. */
  loaded: { mission_id: string; waypoints: Waypoint[] } | null;
  goto_target: LatLon | null;
  manual: { heading_deg: number; speed_mps: number; last_input_at: number } | null;
}

export interface SimWorld {
  waterBody: WaterBody;
  zones: Zone[];
  parameters: Parameter[];
  stations: Station[];
  sensors: Sensor[];
  settings: Settings;
}

export type SimEvent =
  | { type: 'waypoint_reached'; seq: number }
  | { type: 'mission_completed'; mission_id: string }
  | { type: 'low_battery_return'; battery_pct: number }
  | { type: 'docked' }
  | { type: 'link_lost' }
  | { type: 'link_restored' }
  | { type: 'failsafe_hold' }
  | { type: 'goto_reached' }
  | { type: 'geofence_hold' }
  | { type: 'manual_timeout' }
  | { type: 'sample_taken' };

export interface CommandUpdate {
  id: string;
  status: CommandStatus;
  ack_at?: string;
  done_at?: string;
  result?: string;
}

export interface MissionUpdate {
  mission_id: string;
  status: MissionStatus;
  started_at?: string;
  ended_at?: string;
  note?: string;
}

export interface StepResult {
  state: SimState;
  telemetry: BoatTelemetry | null;
  readings: Reading[];
  sensorHealth: { id: string; health: Sensor['health'] }[];
  events: SimEvent[];
  commandUpdates: CommandUpdate[];
  missionUpdates: MissionUpdate[];
}

/** Manual drive commands keep the boat moving this long; then it stops (deadman). */
export const MANUAL_DEADMAN_S = 4;
/** Commands executed in the same tick they are acknowledged. */
const IMMEDIATE: CommandType[] = ['EMERGENCY_STOP', 'MANUAL_DRIVE'];

export function initialSimState(boat: Boat, waypoints: Waypoint[], now: number): SimState {
  return {
    boat: { ...boat },
    waypoints: waypoints.map((w) => ({ ...w })),
    target_idx: 0,
    phase: waypoints.length ? 'mission' : 'idle',
    phase_reason: null,
    link_down_since: null,
    last_station_at: now,
    injections: { drift: null, plume: null, link_down_until: null },
    speed_factor: 1,
    odometer_m: 0,
    loaded: null,
    goto_target: null,
    manual: null,
  };
}

export function zoneAt(p: LatLon, zones: Zone[]): Zone | null {
  return zones.find((z) => pointInPolygon(p, z.polygon)) ?? null;
}

/** Pollution level of the "true" water at a zone, including an injected plume. */
function pollutionIn(zoneId: string | null, inj: SimInjections, now: number, speed: number): number {
  let p = zoneId ? LIVE_POLLUTION[zoneId] ?? 0.1 : 0.1;
  if (inj.plume && inj.plume.zone_id === zoneId) {
    const age = ((now - inj.plume.started_at) / 1000) * speed;
    if (age < PLUME_DURATION_S) {
      // Ramp up over 2 min, then decay.
      const ramp = Math.min(1, age / 120);
      const decay = 1 - Math.max(0, age - 600) / (PLUME_DURATION_S - 600);
      p += 1.1 * ramp * decay;
    }
  }
  return p;
}

function driftBias(key: string, inj: SimInjections, now: number, speed: number): number {
  if (!inj.drift || inj.drift.parameter_key !== key) return 0;
  const ramp = Math.min(1, (((now - inj.drift.started_at) / 1000) * speed) / DRIFT_RAMP_S);
  return (DRIFT_FULL[key] ?? -BASELINE[key] * 0.45) * ramp;
}

let readingSeq = 0;
const newId = (prefix: string, now: number) => `${prefix}-${now.toString(36)}-${(readingSeq++).toString(36)}`;

/**
 * Advance the simulation by one telemetry interval.
 * `now` is wall-clock milliseconds; simulated time advances by TELEMETRY_INTERVAL_S × speed_factor.
 * `commands` are this boat's unfinished commands; the boat acknowledges pending ones and
 * executes acknowledged ones (emergency stop and manual drive in the same tick).
 */
export function stepSim(prev: SimState, world: SimWorld, now: number, rng: () => number, commands: Command[] = []): StepResult {
  const s: SimState = {
    ...prev,
    boat: { ...prev.boat },
    waypoints: prev.waypoints.map((w) => ({ ...w })),
    injections: { ...prev.injections },
    manual: prev.manual ? { ...prev.manual } : null,
  };
  const events: SimEvent[] = [];
  const commandUpdates: CommandUpdate[] = [];
  const missionUpdates: MissionUpdate[] = [];
  const dt = TELEMETRY_INTERVAL_S * s.speed_factor;
  const b = s.boat;
  const settings = world.settings;
  const nowIso = new Date(now).toISOString();
  const sampleAt: LatLon[] = [];

  // ---- link state
  const linkDown = s.injections.link_down_until != null && now < s.injections.link_down_until;
  if (linkDown && s.link_down_since == null) {
    s.link_down_since = now;
    events.push({ type: 'link_lost' });
  }
  if (!linkDown && s.link_down_since != null) {
    s.link_down_since = null;
    s.injections.link_down_until = null;
    events.push({ type: 'link_restored' });
  }
  const failsafeHold = linkDown && s.link_down_since != null && (now - s.link_down_since) / 1000 > settings.link_loss_timeout_s;
  if (failsafeHold && prev.boat.speed_mps > 0) events.push({ type: 'failsafe_hold' });

  // ---- commands (only reach the boat while the link is up)
  if (!linkDown) {
    const mine = commands.filter((c) => c.boat_id === b.id && (c.status === 'pending' || c.status === 'acknowledged'));
    mine.sort((x, y) => (x.issued_at < y.issued_at ? -1 : 1));
    for (const c of mine) {
      const upd: CommandUpdate = { id: c.id, status: c.status };
      if (c.status === 'pending') {
        upd.status = 'acknowledged';
        upd.ack_at = nowIso;
      }
      if (c.status === 'acknowledged' || IMMEDIATE.includes(c.type)) {
        const r = execute(s, c, world, now, missionUpdates, sampleAt);
        upd.status = r.ok ? 'executed' : 'failed';
        upd.done_at = nowIso;
        upd.result = r.result;
      }
      commandUpdates.push(upd);
    }
  }

  // ---- onboard low-battery failsafe
  const atHome = distanceM(b.position, world.waterBody.home_point) < 5;
  const lowBattery = b.battery_pct < settings.low_battery_return_pct;
  if (lowBattery && (['mission', 'paused', 'goto', 'manual'].includes(s.phase) || (s.phase === 'idle' && !atHome))) {
    if (s.phase === 'mission' || s.phase === 'paused') endMission(s, 'aborted', nowIso, missionUpdates, 'Low battery: onboard failsafe returned the boat to the dock.');
    s.phase = 'returning';
    s.manual = null;
    s.goto_target = null;
    s.phase_reason = `Battery below ${settings.low_battery_return_pct}%: onboard failsafe returning to dock`;
    events.push({ type: 'low_battery_return', battery_pct: b.battery_pct });
  }

  // ---- manual-mode timeouts
  if (s.phase === 'manual' && s.manual) {
    const idle = (now - s.manual.last_input_at) / 1000;
    if (idle > settings.manual_idle_timeout_s) {
      s.phase = 'idle';
      s.manual = null;
      s.phase_reason = `Left manual mode after ${Math.round(settings.manual_idle_timeout_s / 60)} min without input; holding position.`;
      events.push({ type: 'manual_timeout' });
    }
  }

  // ---- movement
  let travelled = 0;
  const confirmAt: LatLon[] = [];
  const moving = !failsafeHold && (s.phase === 'mission' || s.phase === 'returning' || s.phase === 'goto');
  if (moving) {
    let budget = CRUISE_SPEED_MPS * dt;
    while (budget > 0) {
      const target: LatLon =
        s.phase === 'mission'
          ? [s.waypoints[s.target_idx].lat, s.waypoints[s.target_idx].lon]
          : s.phase === 'goto'
            ? s.goto_target!
            : world.waterBody.home_point;
      const d = distanceM(b.position, target);
      if (d > 0.01) b.heading_deg = round(bearingDeg(b.position, target), 0);
      if (d > budget) {
        b.position = moveM(b.position, b.heading_deg, budget);
        travelled += budget;
        budget = 0;
        break;
      }
      b.position = target;
      travelled += d;
      budget -= d;
      if (s.phase === 'returning') {
        s.phase = 'charging';
        s.phase_reason = s.phase_reason ?? 'Docked';
        events.push({ type: 'docked' });
        break;
      }
      if (s.phase === 'goto') {
        s.phase = 'idle';
        s.goto_target = null;
        s.phase_reason = 'Holding at the go-to point.';
        events.push({ type: 'goto_reached' });
        break;
      }
      const wp = s.waypoints[s.target_idx];
      wp.status = 'reached';
      events.push({ type: 'waypoint_reached', seq: wp.seq });
      if (wp.action === 'confirm_sample') confirmAt.push([wp.lat, wp.lon]);
      if (s.target_idx < s.waypoints.length - 1) {
        s.target_idx += 1;
      } else {
        const id = b.mission_id;
        endMission(s, 'completed', nowIso, missionUpdates, null);
        if (id) events.push({ type: 'mission_completed', mission_id: id });
        s.phase = distanceM(b.position, world.waterBody.home_point) < 5 ? 'charging' : 'idle';
        s.phase_reason = 'Mission complete.';
        break;
      }
    }
  } else if (s.phase === 'manual' && s.manual && !failsafeHold) {
    const active = (now - s.manual.last_input_at) / 1000 <= MANUAL_DEADMAN_S;
    const speed = active ? Math.min(s.manual.speed_mps, settings.manual_max_speed_mps) : 0;
    if (speed > 0) {
      b.heading_deg = s.manual.heading_deg;
      const next = moveM(b.position, s.manual.heading_deg, speed * dt);
      // Onboard geofence: the boat refuses to leave it, whatever the app sends.
      if (pointInPolygon(next, world.waterBody.geofence)) {
        b.position = next;
        travelled = speed * dt;
      } else {
        s.manual.speed_mps = 0;
        events.push({ type: 'geofence_hold' });
      }
    }
  }
  s.odometer_m += travelled;
  b.speed_mps = round(travelled / dt, 2);

  // ---- battery: drain with distance, charge at the dock
  b.battery_pct -= (travelled / 100) * BATTERY_PCT_PER_100M + 0.0008 * dt;
  const docked = distanceM(b.position, world.waterBody.home_point) < 5;
  if (s.phase === 'charging' || (s.phase === 'idle' && docked)) {
    if (b.battery_pct < 95) b.battery_pct = Math.min(95, b.battery_pct + CHARGE_PCT_PER_S * dt);
    else if (s.phase === 'charging') {
      s.phase = 'idle';
      s.phase_reason = 'Charged at the dock. Ready for the next mission.';
    }
  }
  // Keep full precision in state: per-tick drain is far below the 0.1 % display resolution.
  b.battery_pct = Math.max(0, Math.min(100, b.battery_pct));

  b.mode = MODE[s.phase];
  b.waypoint_seq = s.phase === 'mission' || s.phase === 'paused' ? s.waypoints[s.target_idx]?.seq ?? null : null;
  b.link_type = linkDown ? 'none' : '4G';

  // ---- readings
  const readings: Reading[] = [];
  const sensorHealth: StepResult['sensorHealth'] = [];
  let telemetry: BoatTelemetry | null = null;
  
  const zone = zoneAt(b.position, world.zones);
  const pol = pollutionIn(zone?.id ?? null, s.injections, now, s.speed_factor);

  if (!linkDown) {
    b.last_seen = nowIso;
    b.status = 'online';
    telemetry = {
      boat_id: b.id,
      ts: nowIso,
      lat: b.position[0],
      lon: b.position[1],
      heading_deg: b.heading_deg,
      speed_mps: b.speed_mps,
      battery_pct: round(b.battery_pct, 1),
      mode: b.mode,
      link: b.link_type,
      mission_id: b.mission_id,
      waypoint_seq: b.waypoint_seq,
    };
    for (const key of BOAT_PROBES) {
      const param = world.parameters.find((p) => p.key === key);
      if (!param?.enabled) continue;
      const bias = driftBias(key, s.injections, now, s.speed_factor);
      const value = modelValue(key, pol, rng, bias + diurnal(key, now));
      const anomalous = limitStatus(value, param, settings.near_limit_pct) === 'out';
      const sensor = world.sensors.find((x) => x.owner_type === 'boat' && x.parameter_key === key);
      const drifting = bias !== 0;
      if (drifting && anomalous && sensor && sensor.health === 'ok') {
        sensorHealth.push({ id: sensor.id, health: 'drift_suspected' });
      }
      const suspect = drifting || (sensor != null && sensor.health !== 'ok');
      readings.push({
        id: newId('L', now),
        source_type: 'boat',
        source_id: b.id,
        ts: nowIso,
        lat: b.position[0],
        lon: b.position[1],
        zone_id: zone?.id ?? null,
        parameter_key: key,
        value,
        edge_anomaly_flag: anomalous,
        trust_T: anomalous ? round(clamp01((suspect ? 0.3 : 0.88) + gaussian(rng) * 0.04), 2) : null,
        imputed: false,
        survey_id: null,
        confirmation: false,
      });
    }
  }

  // ---- operator "take sample here" requests produce an extra full probe set
  if (!linkDown && sampleAt.length) {
    events.push({ type: 'sample_taken' });
    for (const r of readings.filter((x) => x.source_type === 'boat' && !x.confirmation).slice(0, BOAT_PROBES.length)) {
      readings.push({ ...r, id: newId('M', now) });
    }
  }

  // ---- confirmation samples: an independent measurement (fresh probe / grab sample), so probe drift does not apply
  if (!linkDown) {
    for (const pos of confirmAt) {
      const cz = zoneAt(pos, world.zones);
      const cp = pollutionIn(cz?.id ?? null, s.injections, now, s.speed_factor);
      for (const key of BOAT_PROBES) {
        const param = world.parameters.find((p) => p.key === key);
        if (!param?.enabled) continue;
        const value = modelValue(key, cp, rng, diurnal(key, now));
        const anomalous = limitStatus(value, param, settings.near_limit_pct) === 'out';
        readings.push({
          id: newId('C', now),
          source_type: 'boat',
          source_id: b.id,
          ts: nowIso,
          lat: pos[0],
          lon: pos[1],
          zone_id: cz?.id ?? null,
          parameter_key: key,
          value,
          edge_anomaly_flag: anomalous,
          trust_T: anomalous ? round(clamp01(0.92 + gaussian(rng) * 0.03), 2) : null,
          imputed: false,
          survey_id: null,
          confirmation: true,
        });
      }
    }
  }

  // ---- fixed stations (independent of the boat link)
  if ((now - s.last_station_at) / 1000 >= STATION_INTERVAL_S / s.speed_factor) {
    s.last_station_at = now;
    for (const st of world.stations) {
      const sp = pollutionIn(st.zone_id, s.injections, now, s.speed_factor);
      for (const key of STATION_PROBES) {
        const param = world.parameters.find((p) => p.key === key);
        if (!param?.enabled) continue;
        const value = modelValue(key, sp, rng, diurnal(key, now));
        const anomalous = limitStatus(value, param, settings.near_limit_pct) === 'out';
        readings.push({
          id: newId('S', now),
          source_type: 'station',
          source_id: st.id,
          ts: nowIso,
          lat: st.position[0],
          lon: st.position[1],
          zone_id: st.zone_id,
          parameter_key: key,
          value,
          edge_anomaly_flag: anomalous,
          trust_T: anomalous ? round(clamp01(0.85 + gaussian(rng) * 0.04), 2) : null,
          imputed: false,
          survey_id: null,
          confirmation: false,
        });
      }
    }
  }

  return { state: s, telemetry, readings, sensorHealth, events, commandUpdates, missionUpdates };
}

const MODE: Record<SimPhase, Boat['mode']> = {
  mission: 'AUTO',
  goto: 'AUTO',
  paused: 'IDLE',
  idle: 'IDLE',
  charging: 'IDLE',
  manual: 'MANUAL',
  returning: 'RETURNING',
  stopped: 'EMERGENCY_STOP',
};

function endMission(s: SimState, status: 'completed' | 'aborted', nowIso: string, out: MissionUpdate[], note: string | null) {
  const id = s.boat.mission_id;
  if (!id) return;
  if (status === 'aborted') for (const w of s.waypoints) if (w.status === 'pending') w.status = 'skipped';
  out.push({ mission_id: id, status, ended_at: nowIso, ...(note ? { note } : {}) });
  s.boat.mission_id = null;
}

/** Boat-side execution of one command. Returns ok=false with a reason when the boat refuses it. */
function execute(s: SimState, c: Command, world: SimWorld, now: number, missions: MissionUpdate[], sampleAt: LatLon[]): { ok: boolean; result?: string } {
  const nowIso = new Date(now).toISOString();
  const p = c.payload ?? {};
  const fail = (result: string) => ({ ok: false, result });
  switch (c.type) {
    case 'EMERGENCY_STOP':
      if (s.phase === 'mission') missions.push({ mission_id: s.boat.mission_id!, status: 'paused', note: 'Paused by emergency stop.' });
      s.phase = 'stopped';
      s.manual = null;
      s.goto_target = null;
      s.phase_reason = 'Emergency stop: motors off. Clear the stop or send Return home.';
      return { ok: true };
    case 'CLEAR_ESTOP':
      if (s.phase !== 'stopped') return fail('Not emergency-stopped.');
      s.phase = s.boat.mission_id ? 'paused' : 'idle';
      s.phase_reason = s.boat.mission_id ? 'Emergency stop cleared; mission paused.' : 'Emergency stop cleared.';
      return { ok: true };
    case 'RETURN_HOME':
      if (s.phase === 'mission' || s.phase === 'paused' || (s.phase === 'stopped' && s.boat.mission_id)) {
        endMission(s, 'aborted', nowIso, missions, 'Aborted: operator sent Return home.');
      }
      s.phase = 'returning';
      s.manual = null;
      s.goto_target = null;
      s.phase_reason = 'Returning home (operator command).';
      return { ok: true };
    case 'LOAD_MISSION': {
      if (!p.mission_id || !p.waypoints?.length) return fail('No route in the mission.');
      const outside = p.waypoints.find((w) => !pointInPolygon([w.lat, w.lon], world.waterBody.geofence));
      if (outside) return fail(`Waypoint ${outside.seq} is outside the onboard geofence.`);
      s.loaded = {
        mission_id: p.mission_id,
        waypoints: p.waypoints.map((w) => ({ mission_id: p.mission_id!, seq: w.seq, lat: w.lat, lon: w.lon, action: w.action, status: 'pending' as const })),
      };
      missions.push({ mission_id: p.mission_id, status: 'sent' });
      return { ok: true };
    }
    case 'START_MISSION':
      if (!s.loaded || s.loaded.mission_id !== p.mission_id) return fail('That mission is not loaded on the boat.');
      if (s.phase !== 'idle' && s.phase !== 'charging') return fail(`Boat is busy (${s.phase}).`);
      s.waypoints = s.loaded.waypoints;
      s.target_idx = 0;
      s.boat.mission_id = s.loaded.mission_id;
      s.loaded = null;
      s.phase = 'mission';
      s.phase_reason = null;
      missions.push({ mission_id: s.boat.mission_id, status: 'running', started_at: nowIso });
      return { ok: true };
    case 'PAUSE_MISSION':
      if (s.phase !== 'mission') return fail('No mission running.');
      s.phase = 'paused';
      s.phase_reason = 'Mission paused by operator; holding position.';
      missions.push({ mission_id: s.boat.mission_id!, status: 'paused' });
      return { ok: true };
    case 'RESUME_MISSION':
      if (s.phase !== 'paused') return fail('No paused mission.');
      s.phase = 'mission';
      s.phase_reason = null;
      missions.push({ mission_id: s.boat.mission_id!, status: 'running' });
      return { ok: true };
    case 'TAKE_SAMPLE':
      sampleAt.push(s.boat.position);
      return { ok: true };
    case 'GOTO':
      if (!p.target || !pointInPolygon(p.target, world.waterBody.geofence)) return fail('Target outside the onboard geofence.');
      if (s.phase !== 'idle' && s.phase !== 'paused' && s.phase !== 'charging') return fail(`Boat is busy (${s.phase}).`);
      if (s.phase === 'paused') {
        // Leaving the route: the paused mission is aborted so the boat does not resume from a stale position.
        endMission(s, 'aborted', nowIso, missions, 'Aborted: operator sent the boat to a point.');
      }
      s.phase = 'goto';
      s.goto_target = p.target;
      s.phase_reason = 'Going to the selected point.';
      return { ok: true };
    case 'ENTER_MANUAL':
      if (s.phase !== 'idle' && s.phase !== 'paused' && s.phase !== 'charging') return fail(`Boat is busy (${s.phase}).`);
      if (s.phase === 'paused') endMission(s, 'aborted', nowIso, missions, 'Aborted: operator took manual control.');
      s.phase = 'manual';
      s.manual = { heading_deg: s.boat.heading_deg, speed_mps: 0, last_input_at: now };
      s.phase_reason = 'Manual control.';
      return { ok: true };
    case 'MANUAL_DRIVE':
      if (s.phase !== 'manual' || !s.manual) return fail('Not in manual mode.');
      s.manual = {
        heading_deg: ((p.heading_deg ?? s.manual.heading_deg) + 360) % 360,
        speed_mps: Math.max(0, Math.min(p.speed_mps ?? 0, world.settings.manual_max_speed_mps)),
        last_input_at: now,
      };
      return { ok: true };
    case 'EXIT_MANUAL':
      if (s.phase !== 'manual') return fail('Not in manual mode.');
      s.phase = 'idle';
      s.manual = null;
      s.phase_reason = 'Left manual mode; holding position.';
      return { ok: true };
  }
  return fail(`Unknown command ${c.type}.`);
}

// ---------------------------------------------------------------- simulator controls (Settings)

export function injectDrift(s: SimState, parameter_key: string, now: number): SimState {
  return { ...s, injections: { ...s.injections, drift: { parameter_key, started_at: now } } };
}

export function injectPlume(s: SimState, zone_id: string, now: number): SimState {
  return { ...s, injections: { ...s.injections, plume: { zone_id, started_at: now } } };
}

/** Link drops are always 90 s of wall-clock time so the app's link-loss timeout is exercised. */
export function dropLink(s: SimState, now: number): SimState {
  return { ...s, injections: { ...s.injections, link_down_until: now + LINK_DROP_S * 1000 } };
}

export function drainBattery(s: SimState, settings: Settings): SimState {
  return { ...s, boat: { ...s.boat, battery_pct: Math.max(0, settings.low_battery_return_pct - 2) } };
}

export function clearInjections(s: SimState): SimState {
  return { ...s, injections: { drift: null, plume: null, link_down_until: null } };
}
