// Database helpers shared by the `operations` and `alerts` Edge Functions (Deno only).

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { DEFAULT_ALERT_RULES, applyCandidates, emptyMemory, missionProposedCandidate, type Candidate } from '../_shared/alertEngine.ts';
import { buildPlannerRequest, proposeMission, scoreRequestFor, surveyFromMission, zoneScoresFrom, type OpsContext, type PlanInput } from '../_shared/operations.ts';
import { MockScoringClient, plannerClientFor, scoringClientFor } from '../_shared/plannerClient.ts';
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

/**
 * Close the loop: every completed mission without a survey becomes a survey; its boat and lab
 * readings are attached and scored (scoring service, or in-app scoring if it fails).
 */
export async function finalizeCompletedMissions(db: SupabaseClient): Promise<string[]> {
  const done = await rows<any>(db, 'missions', (q) => q.eq('status', 'completed'));
  if (!done.length) return [];
  const surveys = await rows<any>(db, 'surveys');
  const pending = done.filter((m) => !surveys.some((s) => s.mission_id === m.id));
  if (!pending.length) return [];
  const ctx = await loadOpsContext(db);
  const created: string[] = [];
  for (const m of pending) {
    const survey = surveyFromMission(m, [...surveys, ...created.map((id) => ({ id }))] as any, ctx.waterBody.id);
    const ins = await db.from('surveys').insert(survey);
    if (ins.error) throw new Error(`surveys: ${ins.error.message}`);
    created.push(survey.id);
    await db
      .from('readings')
      .update({ survey_id: survey.id })
      .is('survey_id', null)
      .in('source_type', ['boat', 'lab'])
      .gte('ts', survey.started_at)
      .lte('ts', survey.ended_at!);
    const readings = await rows<any>(db, 'readings', (q) => q.eq('survey_id', survey.id).limit(20000));
    const req = scoreRequestFor(survey, readings, ctx.zones, ctx.parameters, ctx.settings);
    const client = scoringClientFor(ctx.settings.planner_mode, ctx.settings.planner_url, Deno.env.get('PLANNER_API_KEY') ?? undefined);
    let res;
    try {
      res = await client.score(req);
    } catch (e) {
      res = await new MockScoringClient().score(req);
      await audit(db, null, 'survey.score_fallback', 'surveys', survey.id, { error: (e as Error).message });
    }
    await db.from('zone_scores').insert(zoneScoresFrom(res, new Date().toISOString()));
    await audit(db, null, 'survey.scored', 'surveys', survey.id, { mission: m.id, readings: readings.length, method: res.method, scorer: client.label });
  }
  return created;
}
