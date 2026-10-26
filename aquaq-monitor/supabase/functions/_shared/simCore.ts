// Pure boat + station simulator. Used by the in-browser demo data source and by the
// `simulator` Edge Function, which persists SimState between invocations.

import { BASELINE, BOAT_PROBES, LIVE_POLLUTION, STATION_PROBES, clamp01, diurnal, gaussian, modelValue } from './demoLake.ts';
import { bearingDeg, distanceM, moveM, pointInPolygon } from './geo.ts';
import { limitStatus, round } from './limits.ts';
import type {
  Boat,
  BoatTelemetry,
  LatLon,
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

export type SimPhase = 'mission' | 'returning' | 'charging' | 'idle' | 'stopped';

export interface SimState {
  boat: Boat;
  waypoints: Waypoint[];
  target_idx: number;
  phase: SimPhase;
  /** Why the boat is returning/idle, shown in the boat panel. */
  phase_reason: string | null;
  link_down_since: number | null;
  last_station_at: number;
  injections: SimInjections;
  /** Simulated seconds per real second (demo only; the Edge Function always uses 1). */
  speed_factor: number;
  /** Cumulative distance travelled, for battery accounting. */
  odometer_m: number;
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
  | { type: 'mission_loop_completed' }
  | { type: 'low_battery_return'; battery_pct: number }
  | { type: 'docked' }
  | { type: 'link_lost' }
  | { type: 'link_restored' }
  | { type: 'failsafe_hold' };

export interface StepResult {
  state: SimState;
  telemetry: BoatTelemetry | null;
  readings: Reading[];
  sensorHealth: { id: string; health: Sensor['health'] }[];
  events: SimEvent[];
}

export function initialSimState(boat: Boat, waypoints: Waypoint[], now: number): SimState {
  return {
    boat: { ...boat },
    waypoints: waypoints.map((w) => ({ ...w })),
    target_idx: 0,
    phase: 'mission',
    phase_reason: null,
    link_down_since: null,
    last_station_at: now,
    injections: { drift: null, plume: null, link_down_until: null },
    speed_factor: 1,
    odometer_m: 0,
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
 */
export function stepSim(prev: SimState, world: SimWorld, now: number, rng: () => number): StepResult {
  const s: SimState = {
    ...prev,
    boat: { ...prev.boat },
    waypoints: prev.waypoints.map((w) => ({ ...w })),
    injections: { ...prev.injections },
  };
  const events: SimEvent[] = [];
  const dt = TELEMETRY_INTERVAL_S * s.speed_factor;
  const b = s.boat;
  const settings = world.settings;

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

  // ---- onboard low-battery failsafe
  if (b.battery_pct < settings.low_battery_return_pct && (s.phase === 'mission' || s.phase === 'idle')) {
    s.phase = 'returning';
    s.phase_reason = `Battery below ${settings.low_battery_return_pct}%: onboard failsafe returning to dock`;
    events.push({ type: 'low_battery_return', battery_pct: b.battery_pct });
  }

  // ---- movement
  let travelled = 0;
  const confirmAt: LatLon[] = [];
  if (!failsafeHold && (s.phase === 'mission' || s.phase === 'returning')) {
    let budget = CRUISE_SPEED_MPS * dt;
    while (budget > 0) {
      const target: LatLon =
        s.phase === 'mission' ? [s.waypoints[s.target_idx].lat, s.waypoints[s.target_idx].lon] : world.waterBody.home_point;
      const d = distanceM(b.position, target);
      b.heading_deg = round(bearingDeg(b.position, target), 0);
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
      const wp = s.waypoints[s.target_idx];
      wp.status = 'reached';
      events.push({ type: 'waypoint_reached', seq: wp.seq });
      if (wp.action === 'confirm_sample') confirmAt.push([wp.lat, wp.lon]);
      if (s.target_idx < s.waypoints.length - 1) {
        s.target_idx += 1;
      } else {
        events.push({ type: 'mission_loop_completed' });
        if (b.battery_pct < 60) {
          s.phase = 'charging';
          s.phase_reason = 'Patrol loop complete: charging at dock before the next loop';
          break;
        }
        restartLoop(s);
      }
    }
  }
  s.odometer_m += travelled;
  b.speed_mps = travelled > 0 ? round(CRUISE_SPEED_MPS * (travelled / (CRUISE_SPEED_MPS * dt)), 2) : 0;

  // ---- battery
  b.battery_pct -= (travelled / 100) * BATTERY_PCT_PER_100M + 0.0008 * dt;
  if (s.phase === 'charging') {
    b.battery_pct += CHARGE_PCT_PER_S * dt;
    const lowBatteryStop = (s.phase_reason ?? '').startsWith('Battery below');
    if (b.battery_pct >= 95) {
      b.battery_pct = 95;
      if (lowBatteryStop) {
        s.phase = 'idle';
        s.phase_reason = 'Charged after a low-battery return. Waiting for an operator to resume (Phase 3 controls).';
      } else {
        restartLoop(s);
      }
    }
  }
  // Keep full precision in state: per-tick drain is far below the 0.1 % display resolution.
  b.battery_pct = Math.max(0, Math.min(100, b.battery_pct));

  b.mode =
    s.phase === 'mission' ? 'AUTO' : s.phase === 'returning' ? 'RETURNING' : s.phase === 'stopped' ? 'EMERGENCY_STOP' : 'IDLE';
  b.waypoint_seq = s.phase === 'mission' ? s.waypoints[s.target_idx].seq : null;
  b.link_type = linkDown ? 'none' : '4G';

  // ---- readings
  const readings: Reading[] = [];
  const sensorHealth: StepResult['sensorHealth'] = [];
  let telemetry: BoatTelemetry | null = null;
  const nowIso = new Date(now).toISOString();
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

  return { state: s, telemetry, readings, sensorHealth, events };
}

function restartLoop(s: SimState) {
  s.target_idx = 0;
  s.phase = 'mission';
  s.phase_reason = null;
  for (const w of s.waypoints) w.status = 'pending';
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
