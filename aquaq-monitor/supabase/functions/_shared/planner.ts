// Mission planner contract (section 9) and the v1 mock planner.
// The real planner is a separate Python service (QUBO solved with QAOA/annealing or a
// classical fallback). The mock uses the same request/response format and is labelled
// "mock" everywhere; it makes no claim about quantum methods.

import { distanceM, distanceToEdgeM, fromLocal, pathLengthM, pointInPolygon, polygonCentroid, toLocal } from './geo.ts';
import { limitRatio, round } from './limits.ts';
import type { LatLon, Mission, Parameter, Reading, SamplingLevel, Settings, Solver, Survey, WaterBody, WaypointAction, Zone } from './types.ts';

export const LEVELS: SamplingLevel[] = ['skip', 'confirm', 'standard_25m', 'dense_10m', 'hotspot_5m'];
export const DEFAULT_LEVEL_ENERGY: Record<SamplingLevel, number> = { skip: 0, confirm: 1, standard_25m: 3, dense_10m: 6, hotspot_5m: 10 };
const GAIN: Record<SamplingLevel, number> = { skip: 0, confirm: 0, standard_25m: 1.0, dense_10m: 1.6, hotspot_5m: 2.2 };
export const LEVEL_SPACING_M: Partial<Record<SamplingLevel, number>> = { standard_25m: 25, dense_10m: 10, hotspot_5m: 5 };
export const LEVEL_LABEL: Record<SamplingLevel, string> = {
  skip: 'Skip',
  confirm: 'Confirm sample',
  standard_25m: 'Standard 25 m',
  dense_10m: 'Dense 10 m',
  hotspot_5m: 'Hotspot 5 m',
};
/** Up to this many zones the mock tries every combination (5^8 = 390 625). */
export const EXHAUSTIVE_MAX_ZONES = 8;

export interface PlannerRequest {
  water_body_id: string;
  boat_id: string;
  energy_budget: number;
  zones: { zone_id: string; risk_R: number; trust_T: number }[];
  levels: Record<SamplingLevel, number>;
}

export interface PlannedWaypoint {
  seq: number;
  lat: number;
  lon: number;
  action: WaypointAction;
}

export interface PlannerResponse {
  solver: Solver;
  energy_planned: number;
  objective: number;
  zones: { zone_id: string; level: SamplingLevel; energy: number; reason: string }[];
  waypoints: PlannedWaypoint[];
  note?: string;
}

/**
 * Value of one choice: sampling levels R × T × gain (1.0 / 1.6 / 2.2), a confirmation
 * sample R × (1 − T) × 1.2, skip 0.
 */
export function levelValue(level: SamplingLevel, R: number, T: number): number {
  if (level === 'skip') return 0;
  if (level === 'confirm') return R * (1 - T) * 1.2;
  return R * T * GAIN[level];
}

export function levelReason(level: SamplingLevel, R: number, T: number, trustThreshold = 0.5): string {
  switch (level) {
    case 'hotspot_5m':
      return 'High risk and high trust: map the hotspot at 5 m spacing.';
    case 'dense_10m':
      return 'High risk and trusted data: dense 10 m sampling.';
    case 'standard_25m':
      return R < 0.5 ? 'Moderate risk, trusted data: standard 25 m survey.' : 'Standard 25 m survey; the energy budget does not allow denser sampling.';
    case 'confirm':
      return T < trustThreshold
        ? 'High risk but low trust: one confirmation sample before chasing.'
        : 'One confirmation sample; the energy budget does not allow a survey here.';
    default:
      return R < 0.25 ? 'Low risk: skip this survey to save energy.' : 'Skipped: the energy budget is used on higher-value zones.';
  }
}

/** Mock planner: exhaustive search up to 8 zones, greedy value-per-energy above. */
export function mockPlan(req: PlannerRequest): Omit<PlannerResponse, 'waypoints'> {
  const n = req.zones.length;
  const energy = req.levels;
  let choice: SamplingLevel[];
  let note: string | undefined;

  if (n <= EXHAUSTIVE_MAX_ZONES) {
    let best = { value: -1, energy: Infinity, pick: [] as number[] };
    const pick = new Array<number>(n).fill(0);
    const total = LEVELS.length ** n;
    for (let c = 0; c < total; c++) {
      let x = c;
      let e = 0;
      let v = 0;
      for (let i = 0; i < n; i++) {
        pick[i] = x % LEVELS.length;
        x = Math.floor(x / LEVELS.length);
        const lv = LEVELS[pick[i]];
        e += energy[lv];
        v += levelValue(lv, req.zones[i].risk_R, req.zones[i].trust_T);
      }
      if (e > req.energy_budget + 1e-9) continue;
      // Highest value wins; ties go to the cheaper plan, then to the first found (deterministic).
      if (v > best.value + 1e-9 || (Math.abs(v - best.value) <= 1e-9 && e < best.energy)) best = { value: v, energy: e, pick: [...pick] };
    }
    choice = best.pick.map((i) => LEVELS[i]);
  } else {
    // Greedy: best value per energy unit first, one level per zone.
    choice = new Array<SamplingLevel>(n).fill('skip');
    const options: { i: number; level: SamplingLevel; ratio: number }[] = [];
    req.zones.forEach((z, i) =>
      LEVELS.filter((l) => l !== 'skip' && energy[l] > 0).forEach((level) =>
        options.push({ i, level, ratio: levelValue(level, z.risk_R, z.trust_T) / energy[level] }),
      ),
    );
    options.sort((a, b) => b.ratio - a.ratio);
    let used = 0;
    for (const o of options) {
      if (choice[o.i] !== 'skip' || o.ratio <= 0) continue;
      if (used + energy[o.level] > req.energy_budget) continue;
      choice[o.i] = o.level;
      used += energy[o.level];
    }
    note = `More than ${EXHAUSTIVE_MAX_ZONES} zones: the mock used a greedy value-per-energy heuristic, which may not be optimal.`;
  }

  const zones = req.zones.map((z, i) => ({
    zone_id: z.zone_id,
    level: choice[i],
    energy: energy[choice[i]],
    reason: levelReason(choice[i], z.risk_R, z.trust_T),
  }));
  return {
    solver: 'mock',
    energy_planned: zones.reduce((s, z) => s + z.energy, 0),
    objective: round(zones.reduce((s, z, i) => s + levelValue(z.level, req.zones[i].risk_R, req.zones[i].trust_T), 0), 2),
    zones,
    note,
  };
}

/** Recalculate energy and value after an operator changes levels. */
export function evaluatePlan(
  zones: { zone_id: string; level: SamplingLevel; risk_R: number; trust_T: number }[],
  levels: Record<SamplingLevel, number>,
  budget: number,
): { energy: number; objective: number; overBudget: boolean } {
  const energy = zones.reduce((s, z) => s + levels[z.level], 0);
  const objective = round(zones.reduce((s, z) => s + levelValue(z.level, z.risk_R, z.trust_T), 0), 2);
  return { energy, objective, overBudget: energy > budget };
}

// ------------------------------------------------------------------ route building

export interface RouteContext {
  waterBody: WaterBody;
  zones: Zone[];
  /** Where to centre dense/hotspot sampling (strongest trusted exceedance), per zone. */
  hotspots: Record<string, LatLon | undefined>;
  /** Where to take a confirmation sample (location of the low-trust anomaly), per zone. */
  confirmPoints: Record<string, LatLon | undefined>;
  start: LatLon;
  /** Keep waypoints at least this far inside the geofence. */
  edgeMarginM: number;
}

const BOX_HALF_M: Partial<Record<SamplingLevel, number>> = { dense_10m: 60, hotspot_5m: 30 };

function insideOk(p: LatLon, zone: Zone, ctx: RouteContext): boolean {
  return pointInPolygon(p, zone.polygon) && pointInPolygon(p, ctx.waterBody.geofence) && distanceToEdgeM(p, ctx.waterBody.geofence) >= ctx.edgeMarginM;
}

/** Point inside the zone and safely inside the geofence nearest to `p` (searching outward). */
export function nearestSafePoint(p: LatLon, zone: Zone, ctx: RouteContext): LatLon | null {
  if (insideOk(p, zone, ctx)) return p;
  for (let r = 5; r <= 400; r += 5) {
    for (let a = 0; a < 360; a += 15) {
      const q = fromLocal(p, r * Math.sin((a * Math.PI) / 180), r * Math.cos((a * Math.PI) / 180));
      if (insideOk(q, zone, ctx)) return q;
    }
  }
  return null;
}

/** North–south transects ("lawnmower") at `spacing` m, clipped to the zone, the geofence margin and an optional box. */
function transects(zone: Zone, ctx: RouteContext, spacing: number, box?: { centre: LatLon; half: number }): LatLon[][] {
  const origin = box?.centre ?? polygonCentroid(zone.polygon);
  const local = zone.polygon.map((p) => toLocal(origin, p));
  let xmin = Math.min(...local.map((q) => q[0]));
  let xmax = Math.max(...local.map((q) => q[0]));
  let ymin = Math.min(...local.map((q) => q[1]));
  let ymax = Math.max(...local.map((q) => q[1]));
  if (box) {
    xmin = Math.max(xmin, -box.half);
    xmax = Math.min(xmax, box.half);
    ymin = Math.max(ymin, -box.half);
    ymax = Math.min(ymax, box.half);
  }
  const lines: LatLon[][] = [];
  for (let x = xmin + spacing / 2; x <= xmax; x += spacing) {
    let run: LatLon[] = [];
    let best: LatLon[] = [];
    for (let y = ymin; y <= ymax; y += 1) {
      const p = fromLocal(origin, x, y);
      if (insideOk(p, zone, ctx)) run.push(p);
      else {
        if (run.length > best.length) best = run;
        run = [];
      }
    }
    if (run.length > best.length) best = run;
    if (best.length >= 2) lines.push([best[0], best[best.length - 1]]);
    else if (best.length === 1) lines.push([best[0]]);
  }
  return lines;
}

function zoneWaypoints(zoneId: string, level: SamplingLevel, ctx: RouteContext): { p: LatLon; action: WaypointAction }[] {
  const zone = ctx.zones.find((z) => z.id === zoneId);
  if (!zone || level === 'skip') return [];
  if (level === 'confirm') {
    const p = nearestSafePoint(ctx.confirmPoints[zoneId] ?? polygonCentroid(zone.polygon), zone, ctx);
    return p ? [{ p, action: 'confirm_sample' }] : [];
  }
  const spacing = LEVEL_SPACING_M[level]!;
  const half = BOX_HALF_M[level];
  const centre = half ? nearestSafePoint(ctx.hotspots[zoneId] ?? polygonCentroid(zone.polygon), zone, ctx) : null;
  const lines = transects(zone, ctx, spacing, centre && half ? { centre, half } : undefined);
  const out: { p: LatLon; action: WaypointAction }[] = [];
  lines.forEach((line, i) => {
    const ordered = i % 2 === 0 ? line : [...line].reverse(); // boustrophedon
    for (const p of ordered) out.push({ p, action: 'sample' });
  });
  return out;
}

/**
 * Build the route: zones visited nearest-first from the start, each zone's transects in
 * the direction that starts closest, then back to the dock. Every waypoint is inside the
 * zone and at least `edgeMarginM` inside the geofence.
 */
export function buildRoute(plan: { zone_id: string; level: SamplingLevel }[], ctx: RouteContext): PlannedWaypoint[] {
  let segments = plan
    .map((z) => ({ zone: z.zone_id, wps: zoneWaypoints(z.zone_id, z.level, ctx) }))
    .filter((s) => s.wps.length > 0);
  const route: { p: LatLon; action: WaypointAction }[] = [];
  let here = ctx.start;
  while (segments.length) {
    let bestIdx = 0;
    let bestRev = false;
    let bestD = Infinity;
    segments.forEach((s, i) => {
      const dFirst = distanceM(here, s.wps[0].p);
      const dLast = distanceM(here, s.wps[s.wps.length - 1].p);
      if (dFirst < bestD) [bestD, bestIdx, bestRev] = [dFirst, i, false];
      if (dLast < bestD) [bestD, bestIdx, bestRev] = [dLast, i, true];
    });
    const seg = segments[bestIdx];
    const wps = bestRev ? [...seg.wps].reverse() : seg.wps;
    route.push(...wps);
    here = wps[wps.length - 1].p;
    segments = segments.filter((_, i) => i !== bestIdx);
  }
  route.push({ p: ctx.waterBody.home_point, action: 'transit' });
  return route.map((w, i) => ({ seq: i + 1, lat: w.p[0], lon: w.p[1], action: w.action }));
}

export function routeLengthM(start: LatLon, wps: PlannedWaypoint[]): number {
  return pathLengthM([start, ...wps.map((w) => [w.lat, w.lon] as LatLon)]);
}

/** Strongest trusted, hazard-weighted exceedance per zone (centre of dense/hotspot sampling). */
export function hotspotsFrom(readings: Reading[], params: Parameter[], trustThreshold: number): Record<string, LatLon> {
  const best: Record<string, { score: number; p: LatLon }> = {};
  for (const r of readings) {
    if (!r.zone_id || !r.edge_anomaly_flag || r.trust_T == null || r.trust_T < trustThreshold || r.source_type === 'station') continue;
    const p = params.find((x) => x.key === r.parameter_key);
    const ratio = p ? limitRatio(r.value, p) : null;
    if (!p || ratio == null || !Number.isFinite(ratio)) continue;
    const score = ratio * p.hazard_weight;
    if (!best[r.zone_id] || score > best[r.zone_id].score) best[r.zone_id] = { score, p: [r.lat, r.lon] };
  }
  return Object.fromEntries(Object.entries(best).map(([k, v]) => [k, v.p]));
}

/** Location of the lowest-trust anomaly per zone (where to take the confirmation sample). */
export function confirmPointsFrom(readings: Reading[], trustThreshold: number): Record<string, LatLon> {
  const best: Record<string, { t: number; p: LatLon }> = {};
  for (const r of readings) {
    if (!r.zone_id || !r.edge_anomaly_flag || r.trust_T == null || r.trust_T >= trustThreshold || r.source_type === 'station') continue;
    if (!best[r.zone_id] || r.trust_T < best[r.zone_id].t) best[r.zone_id] = { t: r.trust_T, p: [r.lat, r.lon] };
  }
  return Object.fromEntries(Object.entries(best).map(([k, v]) => [k, v.p]));
}

// ------------------------------------------------------------------ scheduled surveys

export const DAY_MS = 86_400_000;

/**
 * A scheduled survey is due every `survey_interval_days` after the last completed survey.
 * One day before it, a proposed mission should exist; returns the survey time when one is
 * needed and none has been created yet.
 */
export function scheduledProposalNeeded(now: number, surveys: Survey[], missions: Mission[], settings: Pick<Settings, 'survey_interval_days'>): number | null {
  const done = surveys.filter((s) => s.status === 'completed').sort((a, b) => (a.started_at < b.started_at ? -1 : 1));
  const last = done[done.length - 1];
  if (!last) return null;
  const next = new Date(last.started_at).getTime() + settings.survey_interval_days * DAY_MS;
  if (now < next - DAY_MS) return null;
  const windowStart = new Date(next - 2 * DAY_MS).toISOString();
  const exists = missions.some((m) => m.kind === 'scheduled' && m.created_at >= windowStart && m.status !== 'aborted');
  return exists ? null : next;
}
