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
import { DEFAULT_ALERT_RULES, acknowledge, emptyMemory, resolve, runEngine, type EngineMemory } from '@shared/alertEngine.ts';
import { DEFAULT_SETTINGS, type Alert, type AlertRule, type AuditEntry, type Parameter, type Profile, type Reading, type Settings } from '@shared/types.ts';
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

    this.snap = {
      ...emptySnapshot(settings),
      ready: true,
      waterBody: demoWaterBody(),
      zones: demoZones(),
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
    const start = now - PRE_ROLL_TICKS * TELEMETRY_INTERVAL_S * 1000;
    this.sim = initialSimState(this.snap.boats[0], mission.waypoints, start);
    for (let i = 1; i <= PRE_ROLL_TICKS; i++) this.tick(start + i * TELEMETRY_INTERVAL_S * 1000, false);
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
    const res = stepSim(this.sim, world, now, this.rng);
    this.sim = res.state;
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
      waypoints: res.telemetry ? res.state.waypoints : this.snap.waypoints,
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
    this.runAlerts(now, res.readings);
    if (emit) this.emit();
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
      },
      this.engineMemory,
      s.alerts,
      readings,
      () => `AL-${String(++this.alertSeq).padStart(4, '0')}`,
    );
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
