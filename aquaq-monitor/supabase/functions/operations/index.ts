// Operations Edge Function: every mission and boat-control write, validated server-side
// with the shared rules, as the signed-in user. POST {action, ...} with the user's JWT.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { checklistCandidates } from '../_shared/alertEngine.ts';
import { approveMission, changeZoneLevel, prepareCommand, validatePolygon, validateWaterBodyEdit } from '../_shared/operations.ts';
import type { Command, MissionZone, Profile, Waypoint } from '../_shared/types.ts';
import { audit, insertCandidates, loadOpsContext, planAndStore, rows } from '../_server/ops.ts';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

class Reject extends Error {
  constructor(message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}
const need = (u: Profile, roles: Profile['role'][]) => {
  if (!roles.includes(u.role)) throw new Reject(`This action needs the ${roles.join(' or ')} role.`);
};

async function storeMission(missionId: string, m: Record<string, unknown>, zones?: MissionZone[], wps?: Waypoint[]) {
  await db.from('missions').update(m).eq('id', missionId);
  if (zones) {
    await db.from('mission_zones').delete().eq('mission_id', missionId);
    await db.from('mission_zones').insert(zones);
  }
  if (wps) {
    await db.from('waypoints').delete().eq('mission_id', missionId);
    await db.from('waypoints').insert(wps);
  }
}

async function command(user: Profile, type: Command['type'], payload: Command['payload']) {
  const ctx = await loadOpsContext(db);
  const pending = await rows<Command>(db, 'commands', (q) => q.eq('boat_id', ctx.boat.id).in('status', ['pending', 'acknowledged']));
  const wps = payload.mission_id ? await rows<Waypoint>(db, 'waypoints', (q) => q.eq('mission_id', payload.mission_id).order('seq')) : [];
  try {
    const { command, checklist } = prepareCommand(user, ctx, pending, type, payload, () => wps, () => crypto.randomUUID());
    if (checklist && !checklist.passed) {
      await audit(db, user.id, 'checklist.override', 'missions', payload.mission_id ?? '-', { reason: payload.override_reason, failed: checklist.items.filter((i) => !i.ok) });
    }
    const { error } = await db.from('commands').insert(command);
    if (error) throw new Error(error.message);
    if (type !== 'MANUAL_DRIVE') await audit(db, user.id, 'command.issue', 'boats', command.boat_id, { command: command.id, type, payload: { ...payload, waypoints: undefined } });
    return command;
  } catch (e) {
    const err = e as Error & { checklist?: { passed: boolean; items: any[] } };
    if (err.checklist && !err.checklist.passed) await insertCandidates(db, checklistCandidates(ctx.boat.id, ctx.boat.name, err.checklist.items));
    await audit(db, user.id, 'command.rejected', 'boats', ctx.boat.id, { type, reason: err.message });
    throw new Reject(err.message, err.checklist ? { checklist: err.checklist } : {});
  }
}

async function handle(user: Profile, body: any) {
  const now = Date.now();
  switch (body.action) {
    case 'plan': {
      need(user, ['operator', 'admin']);
      if (!(body.energy_budget > 0)) throw new Reject('The energy budget must be more than 0.');
      const m = await planAndStore(db, user, {
        kind: body.kind ?? 'manual',
        energy_budget: Number(body.energy_budget),
        source_alert_id: body.source_alert_id ?? null,
        why: body.kind === 'early' ? 'A fixed station reported a trusted exceedance.' : undefined,
      });
      return { mission_id: m.id };
    }
    case 'propose_scheduled_now': {
      need(user, ['admin']);
      const ctx = await loadOpsContext(db);
      const m = await planAndStore(db, user, { kind: 'scheduled', energy_budget: ctx.settings.energy_budget, why: 'Proposed on request (scheduler run manually).' });
      return { mission_id: m.id };
    }
    case 'set_level': {
      need(user, ['operator', 'admin']);
      const ctx = await loadOpsContext(db);
      const mission = ctx.missions.find((m) => m.id === body.mission_id);
      if (!mission) throw new Reject('Mission not found.');
      const zones = await rows<MissionZone>(db, 'mission_zones', (q) => q.eq('mission_id', mission.id));
      const res = changeZoneLevel(ctx, mission, zones, body.zone_id, body.level);
      await storeMission(mission.id, { energy_planned: res.mission.energy_planned, objective: res.mission.objective, created_by: 'operator' }, res.zones, res.waypoints);
      await audit(db, user.id, 'mission.change_level', 'missions', mission.id, { zone: body.zone_id, level: body.level, energy: res.mission.energy_planned });
      return { ok: true };
    }
    case 'approve': {
      const { data: m } = await db.from('missions').select('*').eq('id', body.mission_id).single();
      if (!m) throw new Reject('Mission not found.');
      if (m.status === 'proposed') {
        const approved = approveMission(m, user, now);
        await storeMission(m.id, { status: approved.status, approved_by: approved.approved_by, approved_at: approved.approved_at });
        await audit(db, user.id, 'mission.approve', 'missions', m.id, { energy: m.energy_planned, budget: m.energy_budget, solver: m.solver });
      }
      try {
        await command(user, 'LOAD_MISSION', { mission_id: m.id });
      } catch (e) {
        throw new Reject(`Approved, but not sent to the boat yet: ${(e as Error).message} Use "Send to boat" when it is free.`);
      }
      return { ok: true };
    }
    case 'discard': {
      need(user, ['operator', 'admin']);
      const { data: m } = await db.from('missions').select('*').eq('id', body.mission_id).single();
      if (!m || (m.status !== 'proposed' && m.status !== 'approved')) throw new Reject('Only proposed or approved missions can be discarded.');
      await storeMission(m.id, { status: 'aborted', note: `Discarded by ${user.full_name}.`, ended_at: new Date(now).toISOString() });
      await audit(db, user.id, 'mission.discard', 'missions', m.id, {});
      return { ok: true };
    }
    case 'command':
      return { command: await command(user, body.type, body.payload ?? {}) };
    case 'maintenance_create': {
      need(user, ['operator', 'admin']);
      if (!String(body.title ?? '').trim()) throw new Reject('A task needs a title.');
      const { data, error } = await db.from('maintenance_tasks').insert({ sensor_id: body.sensor_id, title: body.title.trim(), notes: body.notes ?? '', assigned_to: body.assigned_to, created_by: user.id }).select().single();
      if (error) throw new Reject(error.message);
      await audit(db, user.id, 'maintenance.create', 'sensors', body.sensor_id, { task: data.id, title: data.title });
      return { ok: true };
    }
    case 'maintenance_close': {
      need(user, ['operator', 'admin']);
      const { data: t } = await db.from('maintenance_tasks').select('*').eq('id', body.id).single();
      if (!t || t.status === 'done') throw new Reject('Task not found or already closed.');
      const iso = new Date(now).toISOString();
      await db.from('maintenance_tasks').update({ status: 'done', closed_by: user.id, closed_at: iso }).eq('id', t.id);
      if (body.calibrated) await db.from('sensors').update({ last_calibrated_at: iso, health: 'ok', maintenance_flag: false }).eq('id', t.sensor_id);
      await audit(db, user.id, 'maintenance.close', 'sensors', t.sensor_id, { task: t.id, calibrated: !!body.calibrated });
      return { ok: true };
    }
    case 'water_body': {
      need(user, ['admin']);
      const { data: wb } = await db.from('water_bodies').select('*').limit(1).single();
      const next = validateWaterBodyEdit(wb, body.patch ?? {});
      await db.from('water_bodies').update({ boundary: next.boundary, geofence: next.geofence, home_point: next.home_point }).eq('id', wb.id);
      await audit(db, user.id, 'water_body.update', 'water_bodies', wb.id, { fields: Object.keys(body.patch ?? {}) });
      return { ok: true };
    }
    case 'zone_polygon': {
      need(user, ['admin']);
      validatePolygon(body.polygon, 'The zone');
      const { error } = await db.from('zones').update({ polygon: body.polygon }).eq('id', body.zone_id);
      if (error) throw new Reject(error.message);
      await audit(db, user.id, 'zone.update', 'zones', body.zone_id, { points: body.polygon.length });
      return { ok: true };
    }
  }
  throw new Reject(`Unknown action ${body.action}`);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
  const { data: u } = await db.auth.getUser(token);
  if (!u.user) return json({ error: 'Not signed in' }, 401);
  const { data: profile } = await db.from('profiles').select('id,email,full_name,role').eq('id', u.user.id).single();
  if (!profile) return json({ error: 'No profile for this user' }, 403);
  try {
    return json(await handle(profile as Profile, await req.json()));
  } catch (e) {
    const extra = e instanceof Reject ? e.extra : {};
    return json({ error: e instanceof Error ? e.message : String(e), ...extra }, 400);
  }
});
