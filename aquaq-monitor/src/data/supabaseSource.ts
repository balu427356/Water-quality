// Supabase-backed data source: Postgres + Auth + RLS + Realtime.
// Small tables are loaded fully and refreshed on change; readings and telemetry stream in.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { DEFAULT_SETTINGS, type AuditEntry, type BoatTelemetry, type Parameter, type Profile, type Reading, type Settings } from '@shared/types.ts';
import type { SimState } from '@shared/simCore.ts';
import { TRAIL_WINDOW_MS, emptySnapshot, type DataSource, type ReadingQuery, type SimAction, type Snapshot } from './source';

const TABLES = {
  water_bodies: 'waterBody',
  zones: 'zones',
  parameters: 'parameters',
  boats: 'boats',
  stations: 'stations',
  sensors: 'sensors',
  surveys: 'surveys',
  zone_scores: 'zoneScores',
  missions: 'missions',
  mission_zones: 'missionZones',
  waypoints: 'waypoints',
} as const;
type TableName = keyof typeof TABLES;

const ORDER: Partial<Record<TableName, string>> = {
  surveys: 'started_at',
  zones: 'code',
  waypoints: 'seq',
  missions: 'created_at',
  zone_scores: 'computed_at',
};

export class SupabaseSource implements DataSource {
  readonly kind = 'supabase' as const;
  private client: SupabaseClient;
  private snap: Snapshot = emptySnapshot(DEFAULT_SETTINGS);
  private listeners = new Set<() => void>();
  private started = false;
  private profile: Profile | null = null;

  constructor(url: string, anonKey: string) {
    this.client = createClient(url, anonKey);
  }

  async init() {
    if (this.started) return;
    if (!(await this.client.auth.getSession()).data.session) return; // RLS needs a signed-in user
    this.started = true;
    await Promise.all((Object.keys(TABLES) as TableName[]).map((t) => this.loadTable(t)));
    await Promise.all([this.loadSettings(), this.loadLive(), this.loadSim()]);
    this.snap = { ...this.snap, ready: true };
    this.emit();
    this.subscribeRealtime();
  }

  private async loadTable(t: TableName) {
    let q = this.client.from(t).select('*');
    const order = ORDER[t];
    if (order) q = q.order(order, { ascending: true });
    const { data, error } = await q;
    if (error) throw error;
    const key = TABLES[t];
    this.snap = { ...this.snap, [key]: key === 'waterBody' ? (data?.[0] ?? null) : (data ?? []) };
  }

  private async loadSettings() {
    const { data } = await this.client.from('app_settings').select('value').eq('id', 1).maybeSingle();
    this.snap = { ...this.snap, settings: { ...DEFAULT_SETTINGS, ...((data?.value as Partial<Settings>) ?? {}) } };
  }

  private async loadSim() {
    const { data } = await this.client.from('sim_state').select('state').limit(1).maybeSingle();
    this.applySim(data?.state as SimState | undefined);
  }

  private applySim(s: SimState | undefined) {
    this.snap = {
      ...this.snap,
      sim: s ? { phase: s.phase, phase_reason: s.phase_reason, injections: s.injections, speed_factor: s.speed_factor } : null,
    };
  }

  private async loadLive() {
    const since = new Date(Date.now() - TRAIL_WINDOW_MS).toISOString();
    const [tel, rd] = await Promise.all([
      this.client.from('boat_telemetry').select('*').gte('ts', since).order('ts', { ascending: true }),
      this.client.from('readings').select('*').gte('ts', since).in('source_type', ['boat', 'station']).order('ts', { ascending: true }),
    ]);
    const readings = (rd.data ?? []) as Reading[];
    const latest: Snapshot['latestBySource'] = {};
    for (const r of readings) latest[r.source_id] = { ...(latest[r.source_id] ?? {}), [r.parameter_key]: r };
    this.snap = { ...this.snap, boatTrail: (tel.data ?? []) as BoatTelemetry[], recentReadings: readings, latestBySource: latest };
  }

  private subscribeRealtime() {
    const ch = this.client.channel('aquaq-live');
    for (const t of Object.keys(TABLES) as TableName[]) {
      ch.on('postgres_changes', { event: '*', schema: 'public', table: t }, () => {
        void this.loadTable(t).then(() => this.emit());
      });
    }
    ch.on('postgres_changes', { event: '*', schema: 'public', table: 'app_settings' }, () => {
      void this.loadSettings().then(() => this.emit());
    });
    ch.on('postgres_changes', { event: '*', schema: 'public', table: 'sim_state' }, (p) => {
      this.applySim((p.new as { state?: SimState })?.state);
      this.emit();
    });
    ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'boat_telemetry' }, (p) => {
      const cutoff = new Date(Date.now() - TRAIL_WINDOW_MS).toISOString();
      this.snap = { ...this.snap, boatTrail: [...this.snap.boatTrail.filter((x) => x.ts >= cutoff), p.new as BoatTelemetry] };
      this.emit();
    });
    ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'readings' }, (p) => {
      const r = p.new as Reading;
      if (r.source_type === 'lab') return;
      const cutoff = new Date(Date.now() - TRAIL_WINDOW_MS).toISOString();
      this.snap = {
        ...this.snap,
        recentReadings: [...this.snap.recentReadings.filter((x) => x.ts >= cutoff), r],
        latestBySource: {
          ...this.snap.latestBySource,
          [r.source_id]: { ...(this.snap.latestBySource[r.source_id] ?? {}), [r.parameter_key]: r },
        },
      };
      this.emit();
    });
    ch.subscribe();
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

  private async loadProfile(userId: string): Promise<Profile> {
    const { data, error } = await this.client.from('profiles').select('id,email,full_name,role').eq('id', userId).single();
    if (error) throw error;
    this.profile = data as Profile;
    return this.profile;
  }

  async getSession() {
    const { data } = await this.client.auth.getSession();
    return data.session ? this.loadProfile(data.session.user.id) : null;
  }

  async signIn(email: string, password: string) {
    const { data, error } = await this.client.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);
    const profile = await this.loadProfile(data.user.id);
    await this.init();
    return profile;
  }

  async signOut() {
    await this.client.auth.signOut();
    this.profile = null;
  }

  // ---------------------------------------------------------------- queries & writes

  async queryReadings(q: ReadingQuery) {
    const pageSize = 1000;
    const max = q.limit ?? 50_000;
    const out: Reading[] = [];
    for (let offset = 0; offset < max; offset += pageSize) {
      let req = this.client.from('readings').select('*');
      if (q.zoneIds) req = req.in('zone_id', q.zoneIds);
      if (q.parameterKeys) req = req.in('parameter_key', q.parameterKeys);
      if (q.sourceTypes) req = req.in('source_type', q.sourceTypes);
      if (q.sourceIds) req = req.in('source_id', q.sourceIds);
      if (q.surveyIds) req = req.in('survey_id', q.surveyIds);
      if (q.from) req = req.gte('ts', q.from);
      if (q.to) req = req.lte('ts', q.to);
      if (q.maxTrust != null) req = req.lt('trust_T', q.maxTrust);
      const { data, error } = await req.order('ts', { ascending: true }).range(offset, offset + pageSize - 1);
      if (error) throw error;
      out.push(...((data ?? []) as Reading[]));
      if (!data || data.length < pageSize) break;
    }
    return out;
  }

  async updateParameter(user: Profile, id: string, patch: Partial<Parameter>) {
    const { error } = await this.client.from('parameters').update(patch).eq('id', id);
    if (error) throw error;
    await this.audit(user, 'parameter.update', 'parameters', id, { patch });
  }

  async updateSettings(user: Profile, patch: Partial<Settings>) {
    const value = { ...this.snap.settings, ...patch };
    const { error } = await this.client.from('app_settings').upsert({ id: 1, value });
    if (error) throw error;
    await this.audit(user, 'settings.update', 'settings', 'global', { patch });
  }

  async simControl(_user: Profile, a: SimAction) {
    // The Edge Function checks the caller's role from their JWT and writes the audit entry.
    const { error } = await this.client.functions.invoke('simulator', { body: a });
    if (error) throw error;
  }

  async listAudit(limit = 100) {
    const { data, error } = await this.client.from('audit_log').select('*').order('ts', { ascending: false }).limit(limit);
    if (error) throw error;
    return (data ?? []) as AuditEntry[];
  }

  private async audit(user: Profile, action: string, entity: string, entity_id: string, details: Record<string, unknown>) {
    await this.client.from('audit_log').insert({ user_id: user.id, action, entity, entity_id, details });
  }
}
