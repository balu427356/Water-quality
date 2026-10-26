// Database helpers shared by the `operations` and `alerts` Edge Functions (Deno only).

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { DEFAULT_ALERT_RULES, applyCandidates, emptyMemory, missionProposedCandidate, type Candidate } from '../_shared/alertEngine.ts';
import { buildPlannerRequest, proposeMission, type OpsContext, type PlanInput } from '../_shared/operations.ts';
import { plannerClientFor } from '../_shared/plannerClient.ts';
import { DEFAULT_SETTINGS, type AlertRule, type Profile, type Settings } from '../_shared/types.ts';

export async function rows<T>(db: SupabaseClient, table: string, filter?: (q: any) => any): Promise<T[]> {
  let q = db.from(table).select('*');
  if (filter) q = filter(q);
  const { data, error } = await q;
  if (error) throw new Error(`${table}: ${error.message}`);
  return (data ?? []) as T[];
}

export async function loadOpsContext(db: SupabaseClient, now = Date.now()): Promise<OpsContext> {
  const [settingsRow, wbs, zones, parameters, boats, sensors, surveys, zoneScores, missions] = await Promise.all([
    db.from('app_settings').select('value').eq('id', 1).maybeSingle(),
    rows<any>(db, 'water_bodies'),
    rows<any>(db, 'zones', (q) => q.order('code')),
    rows<any>(db, 'parameters'),
    rows<any>(db, 'boats'),
    rows<any>(db, 'sensors'),
    rows<any>(db, 'surveys', (q) => q.order('started_at')),
    rows<any>(db, 'zone_scores'),
    rows<any>(db, 'missions', (q) => q.order('created_at')),
  ]);
  const settings: Settings = { ...DEFAULT_SETTINGS, ...((settingsRow.data?.value as Partial<Settings>) ?? {}) };
  const last = surveys.filter((s: any) => s.status === 'completed').slice(-1)[0];
  const since = new Date(now - 30 * 60_000).toISOString();
  const [surveyReadings, recent] = await Promise.all([
    last ? rows<any>(db, 'readings', (q) => q.eq('survey_id', last.id).limit(5000)) : Promise.resolve([]),
    rows<any>(db, 'readings', (q) => q.gte('ts', since).eq('source_type', 'boat').limit(5000)),
  ]);
  if (!wbs[0] || !boats[0]) throw new Error('Water body or boat not configured.');
  return { now, settings, waterBody: wbs[0], zones, parameters, boat: boats[0], sensors, surveys, zoneScores, missions, readings: [...surveyReadings, ...recent] };
}

/** Insert alerts produced outside the engine run (proposals, checklist failures), merging with open ones. */
export async function insertCandidates(db: SupabaseClient, candidates: Candidate[]) {
  if (!candidates.length) return;
  const rules = await rows<AlertRule>(db, 'alert_rules');
  const enabled = new Set((rules.length ? rules : DEFAULT_ALERT_RULES).filter((r) => r.enabled).map((r) => r.id));
  const open = await rows<any>(db, 'alerts', (q) => q.neq('status', 'resolved').in('dedup_key', candidates.map((c) => c.dedup_key)));
  const res = applyCandidates(open, candidates.filter((c) => enabled.has(c.rule_id)), rules, emptyMemory(), Date.now(), () => crypto.randomUUID());
  if (res.created.length) await db.from('alerts').insert(res.created);
  for (const m of res.merged) await db.from('alerts').update({ count: m.count, updated_at: m.updated_at, message: m.message }).eq('id', m.id);
}

export async function audit(db: SupabaseClient, userId: string | null, action: string, entity: string, entityId: string, details: Record<string, unknown>) {
  await db.from('audit_log').insert({ user_id: userId, action, entity, entity_id: entityId, details });
}

/** Ask the planner (mock or the configured service) and store the result as a proposed mission. */
export async function planAndStore(db: SupabaseClient, actor: Profile | null, input: PlanInput & { why?: string }) {
  const ctx = await loadOpsContext(db);
  let focus_trust: number | null = null;
  if (input.source_alert_id) {
    const { data: alert } = await db.from('alerts').select('*').eq('id', input.source_alert_id).maybeSingle();
    if (alert) {
      input.focus_zone_id = alert.zone_id;
      const { data: r } = await db.from('readings').select('"trust_T"').eq('source_id', alert.source_id).not('trust_T', 'is', null).order('ts', { ascending: false }).limit(1).maybeSingle();
      focus_trust = (r as any)?.trust_T ?? null;
    }
  }
  const { request, notes } = buildPlannerRequest(ctx, { ...input, focus_trust });
  const client = plannerClientFor(ctx.settings.planner_mode, ctx.settings.planner_url, Deno.env.get('PLANNER_API_KEY') ?? undefined);
  const response = await client.plan(request);
  const plan = proposeMission(ctx, input, request, response, notes);
  const ins = await db.from('missions').insert(plan.mission);
  if (ins.error) throw new Error(`missions: ${ins.error.message}`);
  await db.from('mission_zones').insert(plan.zones);
  await db.from('waypoints').insert(plan.waypoints);
  if (plan.mission.kind !== 'manual') await insertCandidates(db, [missionProposedCandidate(plan.mission, input.why ?? '')]);
  await audit(db, actor?.id ?? null, 'mission.plan', 'missions', plan.mission.id, { kind: input.kind, solver: response.solver, planner: client.label, energy: plan.mission.energy_planned, budget: input.energy_budget });
  return plan.mission;
}
