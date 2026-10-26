// Server-side boat command validation (section 8). The app, the `operations` Edge Function
// and the tests all use this; the boat keeps its own onboard checks as a second layer.

import { distanceToEdgeM, pointInPolygon } from './geo.ts';
import type { Boat, Command, CommandPayload, CommandType, Mission, Role, Sensor, Settings, WaterBody } from './types.ts';

export const COMMAND_LABEL: Record<CommandType, string> = {
  LOAD_MISSION: 'Send mission to boat',
  START_MISSION: 'Start mission',
  PAUSE_MISSION: 'Pause mission',
  RESUME_MISSION: 'Resume mission',
  RETURN_HOME: 'Return to home',
  TAKE_SAMPLE: 'Take sample here',
  GOTO: 'Go to point',
  ENTER_MANUAL: 'Enter manual mode',
  MANUAL_DRIVE: 'Manual drive',
  EXIT_MANUAL: 'Leave manual mode',
  EMERGENCY_STOP: 'Emergency stop',
  CLEAR_ESTOP: 'Clear emergency stop',
};

/** Always allowed for operators and admins, whatever the mode or pending commands. */
export const SAFETY_COMMANDS: CommandType[] = ['EMERGENCY_STOP', 'RETURN_HOME'];

// ------------------------------------------------------------------ pre-mission checklist

export interface ChecklistItem {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface ChecklistResult {
  passed: boolean;
  items: ChecklistItem[];
}

export function runChecklist(input: { boat: Boat; sensors: Sensor[]; settings: Settings; waterBody: WaterBody | null; now: number; parameterName?: (k: string) => string }): ChecklistResult {
  const { boat, sensors, settings, waterBody, now } = input;
  const name = input.parameterName ?? ((k: string) => k);
  const items: ChecklistItem[] = [];
  for (const s of sensors.filter((x) => x.owner_type === 'boat' && x.owner_id === boat.id)) {
    const days = Math.floor((now - new Date(s.last_calibrated_at).getTime()) / 86_400_000);
    const problems: string[] = [];
    if (days > settings.calibration_due_days) problems.push(`calibrated ${days} days ago (limit ${settings.calibration_due_days})`);
    if (s.health !== 'ok') problems.push(`health ${s.health.replace('_', ' ')}`);
    if (s.maintenance_flag) problems.push('maintenance flag set');
    items.push({
      key: `probe:${s.id}`,
      label: `Probe calibration: ${name(s.parameter_key)}`,
      ok: problems.length === 0,
      detail: problems.length ? problems.join('; ') : `calibrated ${days} days ago`,
    });
  }
  items.push({
    key: 'battery',
    label: `Battery ≥ ${settings.checklist_min_battery_pct}%`,
    ok: boat.battery_pct >= settings.checklist_min_battery_pct,
    detail: `${Math.round(boat.battery_pct)}%`,
  });
  const age = boat.last_seen ? (now - new Date(boat.last_seen).getTime()) / 1000 : Infinity;
  const linkOk = age <= settings.link_loss_timeout_s && boat.link_type !== 'none';
  items.push({ key: 'link', label: 'Link OK', ok: linkOk, detail: linkOk ? `${boat.link_type}, last telemetry ${Math.round(age)} s ago` : 'no recent telemetry' });
  const gfOk = !!waterBody && waterBody.geofence.length >= 3 && pointInPolygon(waterBody.home_point, waterBody.geofence);
  items.push({ key: 'geofence', label: 'Geofence loaded', ok: gfOk, detail: gfOk ? `${waterBody!.geofence.length} vertices, dock inside` : 'missing, or the dock is outside it' });
  return { passed: items.every((i) => i.ok), items };
}

// ------------------------------------------------------------------ validation

export interface CommandContext {
  role: Role;
  boat: Boat;
  now: number;
  settings: Settings;
  waterBody: WaterBody | null;
  /** The mission named in the payload (LOAD/START), if any. */
  mission?: Mission | null;
  /** Mission the boat is currently running or paused on, if any. */
  activeMission?: Mission | null;
  /** Result of the pre-mission checklist, required for START_MISSION. */
  checklist?: ChecklistResult;
  /** Commands for this boat that have not finished yet. */
  pending: Command[];
}

export type Validation = { ok: true } | { ok: false; reason: string };

const no = (reason: string): Validation => ({ ok: false, reason });
const yes: Validation = { ok: true };

export function linkLost(boat: Boat, now: number, settings: Settings): boolean {
  const age = boat.last_seen ? (now - new Date(boat.last_seen).getTime()) / 1000 : Infinity;
  return age > settings.link_loss_timeout_s;
}

export function validateCommand(type: CommandType, payload: CommandPayload, ctx: CommandContext): Validation {
  if (ctx.role !== 'operator' && ctx.role !== 'admin') return no('Boat commands need the operator or admin role.');
  const { boat, settings } = ctx;
  const mode = boat.mode;

  // Emergency stop and Return home are always allowed for operators, even during a mission.
  if (type === 'EMERGENCY_STOP') return yes;
  if (type === 'RETURN_HOME') return yes;

  if (linkLost(boat, ctx.now, settings)) return no('Link lost: the boat is following its onboard failsafe. Only Emergency stop and Return home can be sent.');
  if (mode === 'EMERGENCY_STOP' && type !== 'CLEAR_ESTOP') return no('The boat is emergency-stopped. Clear the stop (or send Return home) first.');
  if (ctx.pending.some((c) => !SAFETY_COMMANDS.includes(c.type) && c.type !== 'MANUAL_DRIVE') && type !== 'MANUAL_DRIVE') {
    return no('Another command is still waiting for the boat. Wait for it to finish or time out.');
  }

  switch (type) {
    case 'CLEAR_ESTOP':
      return mode === 'EMERGENCY_STOP' ? yes : no('The boat is not emergency-stopped.');

    case 'LOAD_MISSION': {
      const m = ctx.mission;
      if (!m) return no('Mission not found.');
      if (m.status !== 'approved') return no(`Only approved missions can be sent; this one is ${m.status}.`);
      if (m.energy_planned > m.energy_budget) return no('The plan exceeds its energy budget.');
      if (ctx.activeMission && (mode === 'AUTO' || mode === 'MANUAL')) return no(`The boat is busy with mission ${ctx.activeMission.id}. Pause or return it home first.`);
      return yes;
    }

    case 'START_MISSION': {
      const m = ctx.mission;
      if (!m) return no('Mission not found.');
      if (m.status !== 'sent') return no(`Send the approved mission to the boat first (it is ${m.status}).`);
      if (mode !== 'IDLE') return no(`The boat must be idle to start a mission (it is ${mode}).`);
      if (!ctx.checklist) return no('Run the pre-mission checklist first.');
      if (!ctx.checklist.passed) {
        if (ctx.role !== 'admin') return no('The pre-mission checklist failed. An admin can override it with a reason.');
        if (!payload.override_reason || payload.override_reason.trim().length < 5) return no('An override needs a reason (at least 5 characters).');
      }
      return yes;
    }

    case 'PAUSE_MISSION':
      return mode === 'AUTO' && ctx.activeMission?.status === 'running' ? yes : no('No running mission to pause.');

    case 'RESUME_MISSION':
      return ctx.activeMission?.status === 'paused' && mode === 'IDLE' ? yes : no('No paused mission to resume.');

    case 'TAKE_SAMPLE':
      return mode === 'RETURNING' ? no('The boat is returning home; send the sample request after it docks or stop the return first.') : yes;

    case 'GOTO': {
      const t = payload.target;
      if (!t || !Number.isFinite(t[0]) || !Number.isFinite(t[1])) return no('A target point is required.');
      if (!ctx.waterBody || !pointInPolygon(t, ctx.waterBody.geofence)) return no('Target is outside the geofence.');
      if (distanceToEdgeM(t, ctx.waterBody.geofence) < 2) return no('Target is on the geofence edge; pick a point further inside.');
      if (mode === 'MANUAL') return no('Leave manual mode before sending Go to point.');
      if (mode === 'AUTO' && ctx.activeMission?.status === 'running') return no('A mission is running. Pause it before sending Go to point.');
      if (mode === 'RETURNING') return no('The boat is returning home.');
      return yes;
    }

    case 'ENTER_MANUAL':
      if (mode === 'MANUAL') return no('Already in manual mode.');
      if (mode !== 'IDLE') return no(`Manual mode can only be entered from idle (the boat is ${mode}). Pause the mission first.`);
      return yes;

    case 'MANUAL_DRIVE': {
      if (mode !== 'MANUAL') return no('Not in manual mode.');
      const sp = payload.speed_mps;
      const hd = payload.heading_deg;
      if (sp == null || !Number.isFinite(sp) || sp < 0) return no('Speed is required.');
      if (sp > settings.manual_max_speed_mps + 1e-9) return no(`Speed above the manual limit of ${settings.manual_max_speed_mps} m/s.`);
      if (hd == null || !Number.isFinite(hd) || hd < 0 || hd >= 360) return no('Heading must be 0–359°.');
      return yes;
    }

    case 'EXIT_MANUAL':
      return mode === 'MANUAL' ? yes : no('Not in manual mode.');
  }
  return no(`Unknown command ${type}.`);
}
