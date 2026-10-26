// Alert engine Edge Function. Called every minute by pg_cron:
//   POST {"action":"evaluate"} with header x-cron-secret: $CRON_SECRET
// Reads readings inserted since the last run plus the current boat/sensor/survey state,
// runs the shared rule engine, writes new/merged/escalated alerts, then sends web push,
// email and SMS for the rule's channels. Providers that are not configured are skipped.

import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';
import { emptyMemory, runEngine, type EngineMemory } from '../_shared/alertEngine.ts';
import { DEFAULT_SETTINGS, type Alert, type AlertRule, type Command, type Settings } from '../_shared/types.ts';
import { scheduledProposalNeeded } from '../_shared/planner.ts';
import { finalizeCompletedMissions, planAndStore } from '../_server/ops.ts';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC_KEY');
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY');
if (VAPID_PUBLIC && VAPID_PRIVATE) webpush.setVapidDetails(Deno.env.get('VAPID_SUBJECT') ?? 'mailto:alerts@example.org', VAPID_PUBLIC, VAPID_PRIVATE);
// Generic HTTP webhooks for email/SMS providers (keys stay in the provider config, never in the app).
const EMAIL_WEBHOOK = Deno.env.get('EMAIL_WEBHOOK_URL');
const SMS_WEBHOOK = Deno.env.get('SMS_WEBHOOK_URL');

async function all<T>(table: string, filter?: (q: any) => any): Promise<T[]> {
  let q = db.from(table).select('*');
  if (filter) q = filter(q);
  const { data, error } = await q;
  if (error) throw new Error(`${table}: ${error.message}`);
  return (data ?? []) as T[];
}

async function evaluate() {
  const now = Date.now();
  // New surveys first, so a tier change from a just-finished mission is alerted in this run.
  const surveysCreated = await finalizeCompletedMissions(db);
  const { data: st } = await db.from('engine_state').select('*').eq('id', 1).maybeSingle();
  const memory: EngineMemory = (st?.memory as EngineMemory) ?? emptyMemory();
  const cursor: string = st?.cursor ?? new Date(now - 60_000).toISOString();

  const readings = await all<any>('readings', (q) => q.gt('inserted_at', cursor).order('inserted_at').limit(5000));
  const [settingsRow, rules, parameters, zones, stations, sensors, boats, surveys, zoneScores, missions, wbs, open] = await Promise.all([
    db.from('app_settings').select('value').eq('id', 1).maybeSingle(),
    all<AlertRule>('alert_rules'),
    all('parameters'), all('zones'), all('stations'), all('sensors'), all('boats'),
    all('surveys'), all('zone_scores'), all('missions'), all('water_bodies'),
    all<Alert>('alerts', (q) => q.neq('status', 'resolved')),
  ]);
  const commands = await all<Command>('commands', (q) => q.gte('issued_at', new Date(now - 3_600_000).toISOString()));
  const settings: Settings = { ...DEFAULT_SETTINGS, ...((settingsRow.data?.value as Partial<Settings>) ?? {}) };

  const res = runEngine(
    { now, settings, rules, parameters, zones, stations, sensors, boats, surveys, zoneScores, missions, waterBody: wbs[0] ?? null, commands } as any,
    memory,
    open,
    readings,
    () => crypto.randomUUID(),
  );

  if (res.created.length) {
    const { error } = await db.from('alerts').insert(res.created);
    if (error) throw new Error(`insert alerts: ${error.message}`);
  }
  const changed = new Map<string, Alert>();
  for (const a of [...res.merged, ...res.escalated]) changed.set(a.id, res.alerts.find((x) => x.id === a.id) ?? a);
  for (const a of changed.values()) {
    if (res.created.some((c) => c.id === a.id)) continue;
    await db.from('alerts').update({ count: a.count, updated_at: a.updated_at, severity: a.severity, title: a.title, message: a.message, value: a.value, escalated_at: a.escalated_at, escalation_count: a.escalation_count }).eq('id', a.id);
  }
  for (const u of res.sensorUpdates) await db.from('sensors').update({ maintenance_flag: u.maintenance_flag }).eq('id', u.id);

  const newCursor = readings.length ? readings[readings.length - 1].inserted_at : cursor;
  await db.from('engine_state').upsert({ id: 1, memory: res.memory, cursor: newCursor, updated_at: new Date(now).toISOString() });

  // Scheduler: one day before the next scheduled survey, propose a mission and notify operators.
  let proposed: string | null = null;
  if (scheduledProposalNeeded(now, surveys as any, missions as any, settings) != null) {
    try {
      proposed = (await planAndStore(db, null, { kind: 'scheduled', energy_budget: settings.energy_budget, why: 'The next scheduled survey is due in about a day.' })).id;
    } catch (e) {
      console.error('scheduled proposal failed', e);
    }
  }

  // Escalations go to operators and admins only; new alerts follow the rule's channels.
  const escalatedNew = res.escalated.filter((e) => !res.created.some((c) => c.id === e.id));
  const sent = await dispatch(rules, res.created, escalatedNew);
  return { readings: readings.length, created: res.created.length, merged: res.merged.length, escalated: escalatedNew.length, sent, proposed, surveysCreated };
}

async function dispatch(rules: AlertRule[], created: Alert[], escalated: Alert[]) {
  if (!created.length && !escalated.length) return {};
  const profiles = await all<{ id: string; email: string; role: string; phone: string | null }>('profiles');
  const subs = await all<{ endpoint: string; user_id: string; subscription: any }>('push_subscriptions');
  const staff = new Set(profiles.filter((p) => p.role === 'operator' || p.role === 'admin').map((p) => p.id));
  const counts = { push: 0, email: 0, sms: 0, skipped: [] as string[] };

  const jobs: { alert: Alert; channels: string[]; staffOnly: boolean; prefix: string }[] = [
    ...created.map((a) => ({ alert: a, channels: rules.find((r) => r.id === a.rule_id)?.channels ?? ['in_app'], staffOnly: false, prefix: '' })),
    ...escalated.map((a) => ({ alert: a, channels: ['push', 'email', 'sms'], staffOnly: true, prefix: `Escalated (not acknowledged in time): ` })),
  ];
  for (const j of jobs) {
    const title = `${j.prefix}${j.alert.title}`;
    const recipients = profiles.filter((p) => !j.staffOnly || staff.has(p.id));
    if (j.channels.includes('push')) {
      if (!VAPID_PUBLIC || !VAPID_PRIVATE) counts.skipped.push('push: VAPID keys not set');
      else {
        for (const s of subs.filter((x) => recipients.some((r) => r.id === x.user_id))) {
          try {
            await webpush.sendNotification(s.subscription, JSON.stringify({ title, body: j.alert.message, tag: j.alert.dedup_key, severity: j.alert.severity, url: `/alerts?id=${j.alert.id}` }));
            counts.push++;
          } catch (e: any) {
            if (e?.statusCode === 404 || e?.statusCode === 410) await db.from('push_subscriptions').delete().eq('endpoint', s.endpoint);
          }
        }
      }
    }
    if (j.channels.includes('email')) {
      if (!EMAIL_WEBHOOK) counts.skipped.push('email: EMAIL_WEBHOOK_URL not set');
      else {
        await fetch(EMAIL_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: recipients.map((r) => r.email), subject: `[AquaQ ${j.alert.severity}] ${title}`, text: `${j.alert.message}\n\nSuggested action: ${j.alert.suggested_action}` }) });
        counts.email++;
      }
    }
    if (j.channels.includes('sms')) {
      const phones = recipients.map((r) => r.phone).filter(Boolean);
      if (!SMS_WEBHOOK) counts.skipped.push('sms: SMS_WEBHOOK_URL not set');
      else if (phones.length) {
        await fetch(SMS_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: phones, text: `AquaQ ${j.alert.severity.toUpperCase()}: ${title}` }) });
        counts.sms++;
      }
    }
  }
  counts.skipped = [...new Set(counts.skipped)];
  return counts;
}

Deno.serve(async (req) => {
  if (req.headers.get('x-cron-secret') !== Deno.env.get('CRON_SECRET')) return json({ error: 'forbidden' }, 403);
  try {
    return json(await evaluate());
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
