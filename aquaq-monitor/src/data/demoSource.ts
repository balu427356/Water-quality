// In-browser data source: seeded demo lake + simulator ticking every 3 s.
// Lets the whole app run with no backend. Parameter and settings edits are kept in
// localStorage for this browser only; everything else resets on reload.

import {
  BOAT_ID,
  demoBoat,
  demoMission,
  demoParameters,
  demoSensors,
  demoStations,
  demoWaterBody,
  demoZones,
  generateHistory,
  generateStationHistory,
  mulberry32,
} from '@shared/demoLake.ts';
import {
  TELEMETRY_INTERVAL_S,
  clearInjections,
  drainBattery,
  dropLink,
  initialSimState,
  injectDrift,
  injectPlume,
  stepSim,
  type SimState,
} from '@shared/simCore.ts';
import {
  DEFAULT_ALERT_RULES,
  acknowledge,
  checklistCandidates,
  emptyMemory,
  missionProposedCandidate,
  resolve,
  runEngine,
  type Candidate,
  type EngineMemory,
} from '@shared/alertEngine.ts';
import {
  approveMission,
  buildPlannerRequest,
  changeZoneLevel,
  prepareCommand,
  proposeMission,
  scoreRequestFor,
  surveyFromMission,
  surveyReadings,
  zoneScoresFrom,
  timedOut,
  validatePolygon,
  validateWaterBodyEdit,
  type OpsContext,
} from '@shared/operations.ts';
import { scheduledProposalNeeded } from '@shared/planner.ts';
import {
  DEFAULT_SETTINGS,
  type Alert,
  type AlertRule,
  type AuditEntry,
  type CommandPayload,
  type CommandType,
  type LatLon,
  type MaintenanceTask,
  type MissionKind,
  type Parameter,
  type Polygon,
  type Profile,
  type Reading,
  type SamplingLevel,
  type Settings,
  type WaterBody,
  type Zone,
} from '@shared/types.ts';
import { MockScoringClient, plannerClientFor, scoringClientFor } from '@/api/plannerClient';
import { TRAIL_WINDOW_MS, emptySnapshot, matchesQuery, type DataSource, type ReadingQuery, type SimAction, type Snapshot } from './source';

export const DEMO_USERS: (Profile & { password: string })[] = [
  { id: 'u-admin', email: 'admin@aquaq.demo', full_name: 'Asha Admin', role: 'admin', password: 'demo1234' },
  { id: 'u-operator', email: 'operator@aquaq.demo', full_name: 'Omar Operator', role: 'operator', password: 'demo1234' },
  { id: 'u-viewer', email: 'viewer@aquaq.demo', full_name: 'Vani Viewer', role: 'viewer', password: 'demo1234' },
];

const LS_SESSION = 'aquaq.demo.session';
const LS_PARAMS = 'aquaq.demo.parameters';
const LS_SETTINGS = 'aquaq.demo.settings';
const LS_RULES = 'aquaq.demo.alertRules';
const LS_PUSH = 'aquaq.demo.pushEnabled';
const LS_GEOMETRY = 'aquaq.demo.geometry';
const MAX_COMMANDS = 100;
/** Actor for things the app does by itself (scheduled proposals). */
const SCHEDULER: Profile = { id: 'scheduler', email: 'scheduler', full_name: 'Scheduler', role: 'admin' };
const RESOLVED_RETENTION_MS = 7 * 86_400_000;
const PRE_ROLL_TICKS = (30 * 60) / TELEMETRY_INTERVAL_S; // simulate the last 30 min so the trail is populated
const MAX_LIVE_READINGS = 60_000;

function lsGet<T>(key: string): T | null {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}
function lsSet(key: string, value: unknown) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: keep in memory only */
  }
}

export class DemoSource implements DataSource {
  readonly kind = 'demo' as const;
  private snap: Snapshot = emptySnapshot(DEFAULT_SETTINGS);
  private listeners = new Set<() => void>();
  private history: Reading[] = [];
  private live: Reading[] = [];
  private sim!: SimState;
  private rng = mulberry32(2026);
  private timer: number | null = null;
  private audit: AuditEntry[] = [];
  private engineMemory: EngineMemory = emptyMemory();
  private alertSeq = 0;
  private commandSeq = 0;
  private taskSeq = 0;
  /** Alert candidates raised by actions (checklist failures, proposals), merged on the next engine run. */
  private extraCandidates: Candidate[] = [];
  private ready = false;

  async init() {
    if (this.snap.ready) return;
    this.reset(false);
    this.timer = window.setInterval(() => this.tick(Date.now()), TELEMETRY_INTERVAL_S * 1000);
  }

  private reset(emit = true) {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const settings: Settings = { ...DEFAULT_SETTINGS, ...(lsGet<Partial<Settings>>(LS_SETTINGS) ?? {}) };
    const savedParams = lsGet<Record<string, Partial<Parameter>>>(LS_PARAMS) ?? {};
    const parameters = demoParameters().map((p) => ({ ...p, ...(savedParams[p.id] ?? {}) }));
    const hist = generateHistory(now);
    const mission = demoMission(nowIso);
    this.history = [...hist.readings, ...generateStationHistory(now)].sort((a, b) => (a.ts < b.ts ? -1 : 1));
    this.live = [];
    this.rng = mulberry32(2026);
    this.engineMemory = emptyMemory();
    const savedRules = lsGet<Record<string, Partial<AlertRule>>>(LS_RULES) ?? {};
    const geometry = lsGet<{ waterBody?: Partial<WaterBody>; zones?: Record<string, Partial<Zone>> }>(LS_GEOMETRY) ?? {};
    this.extraCandidates = [];
    this.ready = false;
    const start = now - PRE_ROLL_TICKS * TELEMETRY_INTERVAL_S * 1000;
    mission.mission.started_at = new Date(start).toISOString();

    this.snap = {
      ...emptySnapshot(settings),
      ready: true,
      waterBody: { ...demoWaterBody(), ...(geometry.waterBody ?? {}) },
      zones: demoZones().map((z) => ({ ...z, ...(geometry.zones?.[z.id] ?? {}) })),
      parameters,
      boats: [demoBoat(nowIso)],
      stations: demoStations(nowIso),
      sensors: demoSensors(now),
      surveys: hist.surveys,
      zoneScores: hist.zoneScores,
      missions: [mission.mission],
      missionZones: mission.zones,
      waypoints: mission.waypoints,
      alertRules: DEFAULT_ALERT_RULES.map((r) => ({ ...r, ...(savedRules[r.id] ?? {}) })),
      profiles: DEMO_USERS.map(strip),
    };

    // Pre-roll: run the simulator over the last 30 minutes so the map has a trail and live data.
    this.sim = initialSimState(this.snap.boats[0], mission.waypoints, start);
    for (let i = 1; i <= PRE_ROLL_TICKS; i++) this.tick(start + i * TELEMETRY_INTERVAL_S * 1000, false);
    this.ready = true;
    if (emit) this.emit();
  }

  private tick(now: number, emit = true) {
    const world = {
      waterBody: this.snap.waterBody!,
      zones: this.snap.zones,
      parameters: this.snap.parameters,
      stations: this.snap.stations,
      sensors: this.snap.sensors,
      settings: this.snap.settings,
    };
    // Commands the boat has not acknowledged within the timeout.
    const late = new Set(timedOut(this.snap.commands, now, this.snap.settings.command_timeout_s).map((c) => c.id));
    let commands = late.size
      ? this.snap.commands.map((c) =>
          late.has(c.id) ? { ...c, status: 'timed_out' as const, done_at: new Date(now).toISOString(), result: `No acknowledgement from the boat within ${this.snap.settings.command_timeout_s} s.` } : c,
        )
      : this.snap.commands;
    const unfinished = commands.filter((c) => c.status === 'pending' || c.status === 'acknowledged');

    const res = stepSim(this.sim, world, now, this.rng, unfinished);
    this.sim = res.state;
    if (res.commandUpdates.length) commands = commands.map((c) => ({ ...c, ...(res.commandUpdates.find((u) => u.id === c.id) ?? {}) }));
    const missions = res.missionUpdates.length
      ? this.snap.missions.map((m) => {
          const u = res.missionUpdates.filter((x) => x.mission_id === m.id);
          return u.length ? Object.assign({ ...m }, ...u.map(({ mission_id: _id, note, ...rest }) => ({ ...rest, ...(note ? { note } : {}) }))) : m;
        })
      : this.snap.missions;
    // Waypoint progress of the active mission comes from the boat (only while telemetry arrives).
    const activeId = res.state.boat.mission_id ?? this.sim.waypoints[0]?.mission_id;
    const waypoints =
      res.telemetry && activeId
        ? [...this.snap.waypoints.filter((w) => w.mission_id !== activeId), ...res.state.waypoints.filter((w) => w.mission_id === activeId)]
        : this.snap.waypoints;
    if (res.readings.length) {
      this.live.push(...res.readings);
      if (this.live.length > MAX_LIVE_READINGS) this.live.splice(0, this.live.length - MAX_LIVE_READINGS);
    }

    const cutoff = new Date(now - TRAIL_WINDOW_MS).toISOString();
    const latest = { ...this.snap.latestBySource };
    for (const r of res.readings) latest[r.source_id] = { ...(latest[r.source_id] ?? {}), [r.parameter_key]: r };

    const boat = res.telemetry ? { ...res.state.boat } : this.snap.boats[0]; // no telemetry while the link is down
    const stationIds = new Set(res.readings.filter((r) => r.source_type === 'station').map((r) => r.source_id));
    const sensors = res.sensorHealth.length
      ? this.snap.sensors.map((s) => {
          const u = res.sensorHealth.find((h) => h.id === s.id);
          return u ? { ...s, health: u.health } : s;
        })
      : this.snap.sensors;

    this.snap = {
      ...this.snap,
      boats: [boat],
      stations: stationIds.size
        ? this.snap.stations.map((s) => (stationIds.has(s.id) ? { ...s, last_seen: new Date(now).toISOString() } : s))
        : this.snap.stations,
      sensors,
      commands,
      missions,
      waypoints,
      boatTrail: res.telemetry
        ? [...this.snap.boatTrail.filter((t) => t.ts >= cutoff), res.telemetry]
        : this.snap.boatTrail.filter((t) => t.ts >= cutoff),
      recentReadings: res.readings.length
        ? [...this.snap.recentReadings.filter((r) => r.ts >= cutoff), ...res.readings]
        : this.snap.recentReadings,
      latestBySource: latest,
      sim: {
        phase: res.state.phase,
        phase_reason: res.state.phase_reason,
        injections: res.state.injections,
        speed_factor: res.state.speed_factor,
      },
    };
    for (const u of res.missionUpdates) if (u.status === 'completed') void this.finalizeMission(u.mission_id);
    if (this.ready) this.maybeProposeScheduled(now, false);
    this.runAlerts(now, res.readings);
    if (emit) this.emit();
  }

  /** The scheduler: one day before the next survey, plan a mission and notify operators. */
  private maybeProposeScheduled(now: number, force: boolean) {
    if (!force && scheduledProposalNeeded(now, this.snap.surveys, this.snap.missions, this.snap.settings) == null) return;
    void this.planMission(SCHEDULER, { kind: 'scheduled', energy_budget: this.snap.settings.energy_budget }).catch((e: unknown) => {
      this.log(SCHEDULER, 'mission.plan_failed', 'missions', '-', { error: e instanceof Error ? e.message : String(e) });
    });
  }

  /** Close the loop: a completed mission becomes a survey, scored by the scoring service (or in-app scoring). */
  private async finalizeMission(missionId: string) {
    const m = this.snap.missions.find((x) => x.id === missionId);
    if (!m || m.status !== 'completed' || this.snap.surveys.some((x) => x.mission_id === missionId)) return;
    const survey = surveyFromMission(m, this.snap.surveys, this.snap.waterBody!.id);
    const rs = surveyReadings(this.live, survey);
    const ids = new Set(rs.map((r) => r.id));
    const tag = (r: Reading) => (ids.has(r.id) ? { ...r, survey_id: survey.id } : r);
    this.live = this.live.map(tag);
    this.snap = { ...this.snap, surveys: [...this.snap.surveys, survey], recentReadings: this.snap.recentReadings.map(tag) };
    const req = scoreRequestFor(survey, rs, this.snap.zones, this.snap.parameters, this.snap.settings);
    const client = scoringClientFor(this.snap.settings.planner_mode, this.snap.settings.planner_url);
    let res;
    try {
      res = await client.score(req);
    } catch (e) {
      // The survey still gets scores: fall back to in-app scoring and record why.
      res = await new MockScoringClient().score(req);
      this.log(SCHEDULER, 'survey.score_fallback', 'surveys', survey.id, { error: e instanceof Error ? e.message : String(e) });
    }
    this.snap = { ...this.snap, zoneScores: [...this.snap.zoneScores, ...zoneScoresFrom(res, new Date().toISOString())] };
    this.log(SCHEDULER, 'survey.scored', 'surveys', survey.id, { mission: missionId, readings: rs.length, method: res.method, scorer: client.label });
    this.emit();
  }

  private opsContext(now = Date.now()): OpsContext {
    const s = this.snap;
    const last = s.surveys.filter((x) => x.status === 'completed').slice(-1)[0];
    return {
      now,
      settings: s.settings,
      waterBody: s.waterBody!,
      zones: s.zones,
      parameters: s.parameters,
      boat: s.boats[0],
      sensors: s.sensors,
      surveys: s.surveys,
      zoneScores: s.zoneScores,
      missions: s.missions,
      readings: [...this.history.filter((r) => r.survey_id === last?.id), ...s.recentReadings],
    };
  }

  /** Run the alert rule engine on the readings that just arrived (the same engine the server runs). */
  private runAlerts(now: number, readings: Reading[]) {
    const s = this.snap;
    const res = runEngine(
      {
        now,
        settings: s.settings,
        rules: s.alertRules,
        parameters: s.parameters,
        zones: s.zones,
        stations: s.stations,
        sensors: s.sensors,
        boats: s.boats,
        surveys: s.surveys,
        zoneScores: s.zoneScores,
        missions: s.missions,
        waterBody: s.waterBody,
        commands: s.commands,
      },
      this.engineMemory,
      s.alerts,
      readings,
      () => `AL-${String(++this.alertSeq).padStart(4, '0')}`,
      this.extraCandidates,
    );
    this.extraCandidates = [];
    this.engineMemory = res.memory;
    if (!res.created.length && !res.merged.length && !res.escalated.length && !res.sensorUpdates.length) return;
    const keepAfter = new Date(now - RESOLVED_RETENTION_MS).toISOString();
    this.snap = {
      ...this.snap,
      alerts: sortAlerts(res.alerts.filter((a) => a.status !== 'resolved' || (a.resolved_at ?? '') >= keepAfter)),
      sensors: res.sensorUpdates.length
        ? this.snap.sensors.map((x) => ({ ...x, ...(res.sensorUpdates.find((u) => u.id === x.id) ?? {}) }))
        : this.snap.sensors,
    };
  }

  private updateAlert(id: string, fn: (a: Alert) => Alert) {
    const a = this.snap.alerts.find((x) => x.id === id);
    if (!a) throw new Error('Alert not found.');
    const next = fn(a);
    this.snap = { ...this.snap, alerts: sortAlerts(this.snap.alerts.map((x) => (x.id === id ? next : x))) };
    this.emit();
    return next;
  }

  private emit() {
    for (const l of this.listeners) l();
  }

  getSnapshot = () => this.snap;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  // ---------------------------------------------------------------- auth

  async getSession() {
    const email = lsGet<string>(LS_SESSION);
    const u = DEMO_USERS.find((x) => x.email === email);
    return u ? strip(u) : null;
  }

  async signIn(email: string, password: string) {
    const u = DEMO_USERS.find((x) => x.email.toLowerCase() === email.trim().toLowerCase());
    if (!u || u.password !== password) throw new Error('Wrong email or password.');
    lsSet(LS_SESSION, u.email);
    return strip(u);
  }

  async signOut() {
    lsSet(LS_SESSION, null);
  }

  // ---------------------------------------------------------------- queries & writes

  async queryReadings(q: ReadingQuery) {
    const out: Reading[] = [];
    for (const arr of [this.history, this.live]) {
      for (const r of arr) if (matchesQuery(r, q)) out.push(r);
    }
    return q.limit ? out.slice(-q.limit) : out;
  }

  async updateParameter(user: Profile, id: string, patch: Partial<Parameter>) {
    requireRole(user, ['admin']);
    const before = this.snap.parameters.find((p) => p.id === id);
    if (!before) throw new Error('Unknown parameter');
    this.snap = { ...this.snap, parameters: this.snap.parameters.map((p) => (p.id === id ? { ...p, ...patch } : p)) };
    const saved = lsGet<Record<string, Partial<Parameter>>>(LS_PARAMS) ?? {};
    lsSet(LS_PARAMS, { ...saved, [id]: { ...(saved[id] ?? {}), ...patch } });
    this.log(user, 'parameter.update', 'parameters', id, { before, patch });
    this.emit();
  }

  async updateSettings(user: Profile, patch: Partial<Settings>) {
    requireRole(user, ['admin']);
    const settings = { ...this.snap.settings, ...patch };
    this.snap = { ...this.snap, settings };
    lsSet(LS_SETTINGS, settings);
    this.log(user, 'settings.update', 'settings', 'global', { patch });
    this.emit();
  }

  async simControl(user: Profile, a: SimAction) {
    requireRole(user, ['admin']);
    const now = Date.now();
    switch (a.action) {
      case 'inject_drift':
        this.sim = injectDrift(this.sim, a.parameter_key, now);
        break;
      case 'inject_plume':
        this.sim = injectPlume(this.sim, a.zone_id, now);
        break;
      case 'drop_link':
        this.sim = dropLink(this.sim, now);
        break;
      case 'drain_battery':
        this.sim = drainBattery(this.sim, this.snap.settings);
        break;
      case 'clear_injections':
        this.sim = clearInjections(this.sim);
        break;
      case 'set_speed':
        this.sim = { ...this.sim, speed_factor: a.speed_factor };
        break;
      case 'reset':
        this.reset(false);
        this.alertSeq = 0;
        break;
      case 'propose_scheduled_now':
        this.maybeProposeScheduled(now, true);
        break;
    }
    this.log(user, `simulator.${a.action}`, 'boats', BOAT_ID, { ...a });
    this.tick(now);
  }

  async acknowledgeAlert(user: Profile, id: string) {
    requireRole(user, ['operator', 'admin']);
    const a = this.updateAlert(id, (x) => acknowledge(x, user.id, Date.now()));
    this.log(user, 'alert.acknowledge', 'alerts', id, { title: a.title });
  }

  async resolveAlert(user: Profile, id: string, note: string) {
    requireRole(user, ['operator', 'admin']);
    const a = this.updateAlert(id, (x) => resolve(x, user.id, note, Date.now()));
    this.log(user, 'alert.resolve', 'alerts', id, { title: a.title, note: a.resolution_note });
  }

  async updateAlertRule(user: Profile, id: string, patch: Partial<AlertRule>) {
    requireRole(user, ['admin']);
    if (patch.cooldown_minutes != null && (patch.cooldown_minutes < 0 || !Number.isFinite(patch.cooldown_minutes))) throw new Error('Cooldown must be 0 or more minutes.');
    this.snap = { ...this.snap, alertRules: this.snap.alertRules.map((r) => (r.id === id ? { ...r, ...patch } : r)) };
    const saved = lsGet<Record<string, Partial<AlertRule>>>(LS_RULES) ?? {};
    lsSet(LS_RULES, { ...saved, [id]: { ...(saved[id] ?? {}), ...patch } });
    this.log(user, 'alert_rule.update', 'alert_rules', id, { patch });
    this.emit();
  }

  async savePushSubscription(user: Profile, _sub: PushSubscriptionJSON, enabled: boolean) {
    // Demo mode has no push server: notifications are shown locally by the service worker.
    lsSet(LS_PUSH, enabled ? user.email : null);
  }

  // ---------------------------------------------------------------- missions and boat control

  async planMission(user: Profile, input: { kind: MissionKind; energy_budget: number; source_alert_id?: string | null }) {
    requireRole(user, ['operator', 'admin']);
    if (!(input.energy_budget > 0)) throw new Error('The energy budget must be more than 0.');
    const ctx = this.opsContext();
    const alert = input.source_alert_id ? this.snap.alerts.find((a) => a.id === input.source_alert_id) : undefined;
    const reading = alert ? this.snap.recentReadings.filter((r) => r.source_id === alert.source_id && r.trust_T != null).slice(-1)[0] : undefined;
    const { request, notes } = buildPlannerRequest(ctx, {
      kind: input.kind,
      energy_budget: input.energy_budget,
      source_alert_id: input.source_alert_id,
      focus_zone_id: alert?.zone_id ?? null,
      focus_trust: reading?.trust_T ?? null,
    });
    const client = plannerClientFor(this.snap.settings.planner_mode, this.snap.settings.planner_url);
    const response = await client.plan(request);
    const ctx2 = this.opsContext(); // the plan may take a moment; build on the latest state
    const plan = proposeMission(ctx2, { ...input, focus_zone_id: alert?.zone_id ?? null }, request, response, notes);
    this.snap = {
      ...this.snap,
      missions: [...this.snap.missions, plan.mission],
      missionZones: [...this.snap.missionZones, ...plan.zones],
      waypoints: [...this.snap.waypoints, ...plan.waypoints],
    };
    if (plan.mission.kind !== 'manual') {
      const why = plan.mission.kind === 'early' ? `A fixed station reported a trusted exceedance (${alert?.title ?? 'station trigger'}).` : 'The next scheduled survey is due in about a day.';
      this.extraCandidates.push(missionProposedCandidate(plan.mission, why));
    }
    this.log(user, 'mission.plan', 'missions', plan.mission.id, { kind: input.kind, solver: response.solver, planner: client.label, energy: plan.mission.energy_planned, budget: input.energy_budget });
    this.emit();
    return plan.mission.id;
  }

  async setMissionZoneLevel(user: Profile, missionId: string, zoneId: string, level: SamplingLevel) {
    requireRole(user, ['operator', 'admin']);
    const m = this.snap.missions.find((x) => x.id === missionId);
    if (!m) throw new Error('Mission not found.');
    const res = changeZoneLevel(this.opsContext(), m, this.snap.missionZones.filter((z) => z.mission_id === missionId), zoneId, level);
    this.snap = {
      ...this.snap,
      missions: this.snap.missions.map((x) => (x.id === missionId ? res.mission : x)),
      missionZones: [...this.snap.missionZones.filter((z) => z.mission_id !== missionId), ...res.zones],
      waypoints: [...this.snap.waypoints.filter((w) => w.mission_id !== missionId), ...res.waypoints],
    };
    this.log(user, 'mission.change_level', 'missions', missionId, { zone: zoneId, level, energy: res.mission.energy_planned });
    this.emit();
  }

  async approveMission(user: Profile, missionId: string) {
    const m = this.snap.missions.find((x) => x.id === missionId);
    if (!m) throw new Error('Mission not found.');
    if (m.status === 'proposed') {
      const approved = approveMission(m, user, Date.now());
      this.snap = { ...this.snap, missions: this.snap.missions.map((x) => (x.id === missionId ? approved : x)) };
      this.log(user, 'mission.approve', 'missions', missionId, { energy: m.energy_planned, budget: m.energy_budget, solver: m.solver });
      this.emit();
    }
    try {
      await this.issueCommand(user, 'LOAD_MISSION', { mission_id: missionId });
    } catch (e) {
      throw new Error(`Approved, but not sent to the boat yet: ${e instanceof Error ? e.message : String(e)} Use "Send to boat" when it is free.`);
    }
  }

  async discardMission(user: Profile, missionId: string) {
    requireRole(user, ['operator', 'admin']);
    const m = this.snap.missions.find((x) => x.id === missionId);
    if (!m) throw new Error('Mission not found.');
    if (m.status !== 'proposed' && m.status !== 'approved') throw new Error(`A ${m.status} mission cannot be discarded.`);
    this.snap = { ...this.snap, missions: this.snap.missions.map((x) => (x.id === missionId ? { ...x, status: 'aborted' as const, note: `Discarded by ${user.full_name}.`, ended_at: new Date().toISOString() } : x)) };
    this.log(user, 'mission.discard', 'missions', missionId, {});
    this.emit();
  }

  async issueCommand(user: Profile, type: CommandType, payload: CommandPayload = {}) {
    const ctx = this.opsContext();
    const pending = this.snap.commands.filter((c) => c.status === 'pending' || c.status === 'acknowledged');
    try {
      const { command, checklist } = prepareCommand(user, ctx, pending, type, payload, (id) => this.snap.waypoints.filter((w) => w.mission_id === id), () => `CMD-${String(++this.commandSeq).padStart(4, '0')}`);
      if (checklist && !checklist.passed) {
        this.log(user, 'checklist.override', 'missions', payload.mission_id ?? '-', { reason: payload.override_reason, failed: checklist.items.filter((i) => !i.ok).map((i) => `${i.label}: ${i.detail}`) });
      }
      this.snap = { ...this.snap, commands: [command, ...this.snap.commands].slice(0, MAX_COMMANDS) };
      if (type !== 'MANUAL_DRIVE') this.log(user, 'command.issue', 'boats', command.boat_id, { command: command.id, type, payload: { ...payload, waypoints: undefined } });
      this.emit();
      return command;
    } catch (e) {
      const err = e as Error & { checklist?: { passed: boolean; items: { key: string; label: string; ok: boolean; detail: string }[] } };
      if (err.checklist && !err.checklist.passed) this.extraCandidates.push(...checklistCandidates(ctx.boat.id, ctx.boat.name, err.checklist.items));
      this.log(user, 'command.rejected', 'boats', ctx.boat.id, { type, reason: err.message });
      throw err;
    }
  }

  async createMaintenanceTask(user: Profile, t: { sensor_id: string; title: string; notes: string; assigned_to: string | null }) {
    requireRole(user, ['operator', 'admin']);
    if (!t.title.trim()) throw new Error('A task needs a title.');
    const task: MaintenanceTask = {
      id: `MT-${String(++this.taskSeq).padStart(3, '0')}`,
      sensor_id: t.sensor_id,
      title: t.title.trim(),
      notes: t.notes.trim(),
      assigned_to: t.assigned_to,
      status: 'open',
      created_by: user.id,
      created_at: new Date().toISOString(),
      closed_by: null,
      closed_at: null,
    };
    this.snap = { ...this.snap, maintenanceTasks: [task, ...this.snap.maintenanceTasks] };
    this.log(user, 'maintenance.create', 'sensors', t.sensor_id, { task: task.id, title: task.title, assigned_to: t.assigned_to });
    this.emit();
  }

  async closeMaintenanceTask(user: Profile, id: string, calibrated: boolean) {
    requireRole(user, ['operator', 'admin']);
    const task = this.snap.maintenanceTasks.find((x) => x.id === id);
    if (!task || task.status === 'done') throw new Error('Task not found or already closed.');
    const nowIso = new Date().toISOString();
    this.snap = {
      ...this.snap,
      maintenanceTasks: this.snap.maintenanceTasks.map((x) => (x.id === id ? { ...x, status: 'done' as const, closed_by: user.id, closed_at: nowIso } : x)),
      sensors: calibrated
        ? this.snap.sensors.map((x) => (x.id === task.sensor_id ? { ...x, last_calibrated_at: nowIso, health: 'ok' as const, maintenance_flag: false } : x))
        : this.snap.sensors,
    };
    this.log(user, 'maintenance.close', 'sensors', task.sensor_id, { task: id, calibrated });
    this.emit();
  }

  async updateWaterBody(user: Profile, patch: { geofence?: Polygon; home_point?: LatLon; boundary?: Polygon }) {
    requireRole(user, ['admin']);
    const next = validateWaterBodyEdit(this.snap.waterBody!, patch);
    this.snap = { ...this.snap, waterBody: next };
    const saved = lsGet<{ waterBody?: Partial<WaterBody>; zones?: Record<string, Partial<Zone>> }>(LS_GEOMETRY) ?? {};
    lsSet(LS_GEOMETRY, { ...saved, waterBody: { ...(saved.waterBody ?? {}), ...patch } });
    this.log(user, 'water_body.update', 'water_bodies', next.id, { fields: Object.keys(patch) });
    this.emit();
  }

  async updateZonePolygon(user: Profile, zoneId: string, polygon: Polygon) {
    requireRole(user, ['admin']);
    validatePolygon(polygon, 'The zone');
    if (!this.snap.zones.some((z) => z.id === zoneId)) throw new Error('Zone not found.');
    this.snap = { ...this.snap, zones: this.snap.zones.map((z) => (z.id === zoneId ? { ...z, polygon } : z)) };
    const saved = lsGet<{ waterBody?: Partial<WaterBody>; zones?: Record<string, Partial<Zone>> }>(LS_GEOMETRY) ?? {};
    lsSet(LS_GEOMETRY, { ...saved, zones: { ...(saved.zones ?? {}), [zoneId]: { polygon } } });
    this.log(user, 'zone.update', 'zones', zoneId, { points: polygon.length });
    this.emit();
  }

  async listAlerts(from: string, to: string) {
    return this.snap.alerts.filter((a) => a.created_at >= from && a.created_at <= to);
  }

  async listAudit(limit = 100) {
    return this.audit.slice(-limit).reverse();
  }

  private log(user: Profile, action: string, entity: string, entity_id: string, details: Record<string, unknown>) {
    this.audit.push({ id: `AU-${this.audit.length + 1}`, user_id: user.email, action, entity, entity_id, details, ts: new Date().toISOString() });
  }

  dispose() {
    if (this.timer != null) window.clearInterval(this.timer);
  }
}

function strip(u: Profile & { password: string }): Profile {
  return { id: u.id, email: u.email, full_name: u.full_name, role: u.role };
}

/** Open first, then acknowledged, then resolved; newest activity first within each. */
export function sortAlerts(alerts: Alert[]): Alert[] {
  const rank = { open: 0, acknowledged: 1, resolved: 2 } as const;
  return [...alerts].sort((a, b) => rank[a.status] - rank[b.status] || (a.updated_at < b.updated_at ? 1 : -1));
}

export function requireRole(user: Profile, roles: Profile['role'][]) {
  if (!roles.includes(user.role)) throw new Error(`This action needs the ${roles.join(' or ')} role.`);
}
