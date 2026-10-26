// Mission planning and command preparation shared by the browser demo and the `operations`
// Edge Function, so both apply the same rules: plans are only proposed, approval checks the
// budget, and every boat command goes through validateCommand.

import { runChecklist, validateCommand, type ChecklistResult } from './commands.ts';
import {
  DEFAULT_LEVEL_ENERGY,
  buildRoute,
  confirmPointsFrom,
  evaluatePlan,
  hotspotsFrom,
  levelReason,
  type PlannerRequest,
  type PlannerResponse,
} from './planner.ts';
import { pointInPolygon } from './geo.ts';
import type { ScoreRequest, ScoreResponse } from './scoring.ts';
import type {
  Boat,
  Command,
  CommandPayload,
  CommandType,
  LatLon,
  Mission,
  MissionKind,
  MissionZone,
  Parameter,
  Polygon,
  Profile,
  Reading,
  SamplingLevel,
  Sensor,
  Settings,
  Survey,
  WaterBody,
  Waypoint,
  Zone,
  ZoneScore,
} from './types.ts';

export interface OpsContext {
  now: number;
  settings: Settings;
  waterBody: WaterBody;
  zones: Zone[];
  parameters: Parameter[];
  boat: Boat;
  sensors: Sensor[];
  surveys: Survey[];
  zoneScores: ZoneScore[];
  missions: Mission[];
  /** Readings used to place hotspot and confirmation sampling (latest survey + recent live). */
  readings: Reading[];
}

/** Edge margin for planned waypoints: clear of the geofence warning distance. */
export const ROUTE_EDGE_MARGIN_M = (s: Settings) => s.geofence_warning_m + 2;

export function nextMissionId(missions: Mission[]): string {
  const max = missions.reduce((m, x) => Math.max(m, Number(/M-(\d+)/.exec(x.id)?.[1] ?? 0)), 0);
  return `M-${String(max + 1).padStart(4, '0')}`;
}

/** Zone scores from the latest completed survey. */
export function latestScores(ctx: Pick<OpsContext, 'surveys' | 'zoneScores'>): Record<string, ZoneScore> {
  const done = ctx.surveys.filter((s) => s.status === 'completed').sort((a, b) => (a.started_at < b.started_at ? -1 : 1));
  const last = done[done.length - 1];
  const out: Record<string, ZoneScore> = {};
  for (const z of ctx.zoneScores) if (z.survey_id === last?.id) out[z.zone_id] = z;
  return out;
}

export interface PlanInput {
  kind: MissionKind;
  energy_budget: number;
  /** Early mission: the station-trigger alert and the zone it concerns. */
  source_alert_id?: string | null;
  focus_zone_id?: string | null;
  focus_trust?: number | null;
}

/** Planner request from the latest zone scores. Early missions raise the triggering zone's R. */
export function buildPlannerRequest(ctx: OpsContext, input: PlanInput): { request: PlannerRequest; notes: string[] } {
  const scores = latestScores(ctx);
  const notes: string[] = [];
  const zones = ctx.zones.map((z) => {
    let R = scores[z.id]?.risk_R ?? 0;
    let T = scores[z.id]?.trust_T ?? ctx.settings.trust_threshold;
    if (input.kind === 'early' && input.focus_zone_id === z.id) {
      const raised = Math.max(R, ctx.settings.tier_cutoffs.critical);
      const trust = Math.max(T, input.focus_trust ?? 0.85);
      if (raised !== R || trust !== T) notes.push(`Zone ${z.code}: R raised from ${R} to ${raised} and T set to ${trust} after a trusted station exceedance.`);
      R = raised;
      T = trust;
    }
    return { zone_id: z.id, risk_R: R, trust_T: T };
  });
  return {
    request: { water_body_id: ctx.waterBody.id, boat_id: ctx.boat.id, energy_budget: input.energy_budget, zones, levels: { ...DEFAULT_LEVEL_ENERGY } },
    notes,
  };
}

function routeFor(ctx: OpsContext, plan: { zone_id: string; level: SamplingLevel }[]) {
  const thr = ctx.settings.trust_threshold;
  return buildRoute(plan, {
    waterBody: ctx.waterBody,
    zones: ctx.zones,
    hotspots: hotspotsFrom(ctx.readings, ctx.parameters, thr),
    confirmPoints: confirmPointsFrom(ctx.readings, thr),
    start: ctx.waterBody.home_point,
    edgeMarginM: ROUTE_EDGE_MARGIN_M(ctx.settings),
  });
}

/** Turn a planner response into a proposed mission, its zone rows and its route. */
export function proposeMission(
  ctx: OpsContext,
  input: PlanInput,
  request: PlannerRequest,
  response: PlannerResponse,
  notes: string[],
): { mission: Mission; zones: MissionZone[]; waypoints: Waypoint[] } {
  const id = nextMissionId(ctx.missions);
  const nowIso = new Date(ctx.now).toISOString();
  const zoneName = (zid: string | null | undefined) => ctx.zones.find((z) => z.id === zid)?.code ?? zid;
  const name =
    input.kind === 'scheduled'
      ? `Scheduled survey ${nowIso.slice(0, 10)}`
      : input.kind === 'early'
        ? `Early mission: zone ${zoneName(input.focus_zone_id)} (station trigger)`
        : 'Operator-planned mission';
  const plannedWps = response.waypoints?.length ? response.waypoints : routeFor(ctx, response.zones);
  // A remote planner's route is still checked against the geofence before anyone can approve it.
  const outside = plannedWps.find((w) => !pointInPolygon([w.lat, w.lon], ctx.waterBody.geofence));
  if (outside) throw new Error(`Planner returned waypoint ${outside.seq} outside the geofence; plan rejected.`);
  const mission: Mission = {
    id,
    boat_id: ctx.boat.id,
    name,
    created_by: 'planner',
    solver: response.solver,
    energy_budget: request.energy_budget,
    energy_planned: response.energy_planned,
    status: 'proposed',
    approved_by: null,
    approved_at: null,
    created_at: nowIso,
    kind: input.kind,
    objective: response.objective,
    source_alert_id: input.source_alert_id ?? null,
    note: [...notes, response.note].filter(Boolean).join(' ') || null,
    started_at: null,
    ended_at: null,
  };
  const zones: MissionZone[] = response.zones.map((z) => {
    const rq = request.zones.find((x) => x.zone_id === z.zone_id)!;
    return { mission_id: id, zone_id: z.zone_id, level: z.level, risk_R: rq.risk_R, trust_T: rq.trust_T, energy: z.energy, reason: z.reason };
  });
  const waypoints: Waypoint[] = plannedWps.map((w) => ({ mission_id: id, seq: w.seq, lat: w.lat, lon: w.lon, action: w.action, status: 'pending' }));
  return { mission, zones, waypoints };
}

/** Operator changes one zone's level on a proposed plan: energy, value and route are recalculated. */
export function changeZoneLevel(
  ctx: OpsContext,
  mission: Mission,
  zones: MissionZone[],
  zoneId: string,
  level: SamplingLevel,
): { mission: Mission; zones: MissionZone[]; waypoints: Waypoint[] } {
  if (mission.status !== 'proposed') throw new Error('Only proposed plans can be changed.');
  const next = zones.map((z) =>
    z.zone_id === zoneId ? { ...z, level, energy: DEFAULT_LEVEL_ENERGY[level], reason: `Changed by operator: ${levelReason(level, z.risk_R, z.trust_T).toLowerCase()}` } : z,
  );
  const ev = evaluatePlan(next, DEFAULT_LEVEL_ENERGY, mission.energy_budget);
  const route = routeFor(ctx, next);
  return {
    mission: { ...mission, energy_planned: ev.energy, objective: ev.objective, created_by: 'operator' },
    zones: next,
    waypoints: route.map((w) => ({ mission_id: mission.id, seq: w.seq, lat: w.lat, lon: w.lon, action: w.action, status: 'pending' })),
  };
}

export function approveMission(mission: Mission, user: Profile, now: number): Mission {
  if (user.role !== 'operator' && user.role !== 'admin') throw new Error('Approving missions needs the operator or admin role.');
  if (mission.status !== 'proposed') throw new Error(`Only proposed missions can be approved; this one is ${mission.status}.`);
  if (mission.energy_planned > mission.energy_budget) {
    throw new Error(`The plan uses ${mission.energy_planned} energy units, over the budget of ${mission.energy_budget}. Lower some zone levels first.`);
  }
  return { ...mission, status: 'approved', approved_by: user.id, approved_at: new Date(now).toISOString() };
}

export function activeMissionOf(boat: Boat, missions: Mission[]): Mission | null {
  return missions.find((m) => m.id === boat.mission_id && (m.status === 'running' || m.status === 'paused')) ?? null;
}

/**
 * Validate a command and build the row to store. LOAD_MISSION carries the route;
 * START_MISSION runs the pre-mission checklist on the server side.
 */
export function prepareCommand(
  user: Profile,
  ctx: OpsContext,
  pending: Command[],
  type: CommandType,
  payload: CommandPayload,
  waypointsOf: (missionId: string) => Waypoint[],
  newId: () => string,
): { command: Command; checklist?: ChecklistResult } {
  const mission = payload.mission_id ? ctx.missions.find((m) => m.id === payload.mission_id) ?? null : null;
  const checklist =
    type === 'START_MISSION'
      ? runChecklist({ boat: ctx.boat, sensors: ctx.sensors, settings: ctx.settings, waterBody: ctx.waterBody, now: ctx.now, parameterName: (k) => ctx.parameters.find((p) => p.key === k)?.name ?? k })
      : undefined;
  const v = validateCommand(type, payload, {
    role: user.role,
    boat: ctx.boat,
    now: ctx.now,
    settings: ctx.settings,
    waterBody: ctx.waterBody,
    mission,
    activeMission: activeMissionOf(ctx.boat, ctx.missions),
    checklist,
    pending,
  });
  if (!v.ok) {
    const err = new Error(v.reason) as Error & { checklist?: ChecklistResult };
    err.checklist = checklist;
    throw err;
  }
  const full: CommandPayload = { ...payload };
  if (type === 'LOAD_MISSION' && mission) {
    full.waypoints = waypointsOf(mission.id).map((w) => ({ seq: w.seq, lat: w.lat, lon: w.lon, action: w.action }));
  }
  if (type !== 'START_MISSION' || checklist?.passed) delete full.override_reason;
  return {
    command: {
      id: newId(),
      boat_id: ctx.boat.id,
      type,
      payload: full,
      issued_by: user.id,
      issued_at: new Date(ctx.now).toISOString(),
      status: 'pending',
      ack_at: null,
      done_at: null,
      result: null,
    },
    checklist,
  };
}

/** Pending commands the boat has not acknowledged within the timeout. */
export function timedOut(commands: Command[], now: number, timeoutS: number): Command[] {
  return commands.filter((c) => c.status === 'pending' && now - new Date(c.issued_at).getTime() > timeoutS * 1000);
}

// ------------------------------------------------------------------ geometry edits (Settings)

export function validatePolygon(poly: Polygon, what: string): void {
  if (!Array.isArray(poly) || poly.length < 3) throw new Error(`${what} needs at least 3 points.`);
  for (const p of poly) if (!Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite)) throw new Error(`${what} has an invalid point.`);
}

export function validateWaterBodyEdit(current: WaterBody, patch: { geofence?: Polygon; home_point?: LatLon; boundary?: Polygon }): WaterBody {
  const next = { ...current, ...patch };
  validatePolygon(next.boundary, 'The boundary');
  validatePolygon(next.geofence, 'The geofence');
  if (!pointInPolygon(next.home_point, next.geofence)) throw new Error('The home/dock point must be inside the geofence, or Return home would leave it.');
  const outside = next.geofence.filter((p) => !pointInPolygon(p, next.boundary)).length;
  if (outside > 0) throw new Error(`${outside} geofence point(s) are outside the water-body boundary.`);
  return next;
}

// ------------------------------------------------------------------ closing the loop: mission → survey → scores

/**
 * A completed mission becomes a survey: its boat and lab readings between start and end are
 * attached to it and scored. Aborted missions do not produce a survey.
 */
export function surveyFromMission(mission: Mission, surveys: Survey[], waterBodyId: string): Survey {
  if (mission.status !== 'completed' || !mission.started_at || !mission.ended_at) throw new Error('Only completed missions become surveys.');
  const max = surveys.reduce((m, x) => Math.max(m, Number(/SV-(\d+)/.exec(x.id)?.[1] ?? 0)), 0);
  return {
    id: `SV-${String(max + 1).padStart(3, '0')}`,
    water_body_id: waterBodyId,
    type: mission.kind === 'scheduled' ? 'scheduled' : 'unscheduled',
    started_at: mission.started_at,
    ended_at: mission.ended_at,
    status: 'completed',
    mission_id: mission.id,
  };
}

export function surveyReadings(readings: Reading[], survey: Survey): Reading[] {
  return readings.filter((r) => r.source_type !== 'station' && r.survey_id == null && r.ts >= survey.started_at && r.ts <= (survey.ended_at ?? r.ts));
}

export function scoreRequestFor(survey: Survey, readings: Reading[], zones: Zone[], parameters: Parameter[], settings: Settings): ScoreRequest {
  return {
    survey_id: survey.id,
    zones: zones.map((z) => z.id),
    readings: readings.map((r) => ({ zone_id: r.zone_id, parameter_key: r.parameter_key, value: r.value, edge_anomaly_flag: r.edge_anomaly_flag, trust_T: r.trust_T })),
    parameters,
    settings: { trust_threshold: settings.trust_threshold, tier_cutoffs: settings.tier_cutoffs, near_limit_pct: settings.near_limit_pct },
  };
}

export function zoneScoresFrom(res: ScoreResponse, computedAt: string): ZoneScore[] {
  return res.zone_scores.map((z) => ({ id: `ZS-${res.survey_id}-${z.zone_id}`, survey_id: res.survey_id, computed_at: computedAt, ...z }));
}
