// Simulator Edge Function (v1 only; replaced by the boat gateway in production).
//
//   POST {"action":"tick"}  with header x-cron-secret: $CRON_SECRET
//       Called every minute by pg_cron. Runs ~19 telemetry steps 3 s apart, writing
//       boat_telemetry, readings, boats, stations, sensors and waypoints, then saves sim_state.
//   POST {"action":"inject_drift" | "inject_plume" | "drop_link" | "drain_battery" | "clear_injections" | "reset", ...}
//       Called from Settings with the user's JWT. Admin only; written to audit_log.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { demoBoat, demoMission, mulberry32 } from '../_shared/demoLake.ts';
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
  type SimWorld,
} from '../_shared/simCore.ts';
import { DEFAULT_SETTINGS, type Settings } from '../_shared/types.ts';

const BOAT_ID = 'B1';
const STEPS_PER_INVOCATION = 19;

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
});

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

async function loadWorld(): Promise<SimWorld> {
  const [wb, zones, parameters, stations, sensors, settings] = await Promise.all([
    admin.from('water_bodies').select('*').limit(1).single(),
    admin.from('zones').select('*'),
    admin.from('parameters').select('*'),
    admin.from('stations').select('*'),
    admin.from('sensors').select('*'),
    admin.from('app_settings').select('value').eq('id', 1).maybeSingle(),
  ]);
  return {
    waterBody: wb.data,
    zones: zones.data ?? [],
    parameters: parameters.data ?? [],
    stations: stations.data ?? [],
    sensors: sensors.data ?? [],
    settings: { ...DEFAULT_SETTINGS, ...((settings.data?.value as Partial<Settings>) ?? {}) },
  };
}

async function loadState(): Promise<SimState> {
  const { data } = await admin.from('sim_state').select('state').eq('boat_id', BOAT_ID).maybeSingle();
  if (data?.state) return data.state as SimState;
  return freshState(Date.now());
}

function freshState(now: number): SimState {
  const iso = new Date(now).toISOString();
  return initialSimState(demoBoat(iso), demoMission(iso).waypoints, now);
}

const saveState = (state: SimState) =>
  admin.from('sim_state').upsert({ boat_id: BOAT_ID, state, updated_at: new Date().toISOString() });

async function tick() {
  let state = await loadState();
  const world = await loadWorld();
  const rng = mulberry32(Date.now() % 2 ** 31);
  for (let i = 0; i < STEPS_PER_INVOCATION; i++) {
    const res = stepSim(state, world, Date.now(), rng);
    state = res.state;
    const writes: PromiseLike<unknown>[] = [];
    if (res.telemetry) {
      const b = state.boat;
      writes.push(admin.from('boat_telemetry').insert(res.telemetry));
      writes.push(
        admin.from('boats').update({
          status: 'online', battery_pct: res.telemetry.battery_pct, mode: b.mode, last_seen: b.last_seen, link_type: b.link_type,
          position: b.position, heading_deg: b.heading_deg, speed_mps: b.speed_mps, mission_id: b.mission_id, waypoint_seq: b.waypoint_seq,
        }).eq('id', b.id),
      );
      for (const w of state.waypoints) {
        writes.push(admin.from('waypoints').update({ status: w.status }).eq('mission_id', w.mission_id).eq('seq', w.seq));
      }
    }
    if (res.readings.length) {
      writes.push(admin.from('readings').insert(res.readings.map(({ id: _id, ...r }) => r)));
      const stationIds = [...new Set(res.readings.filter((r) => r.source_type === 'station').map((r) => r.source_id))];
      if (stationIds.length) writes.push(admin.from('stations').update({ last_seen: new Date().toISOString(), status: 'online' }).in('id', stationIds));
    }
    for (const h of res.sensorHealth) {
      writes.push(admin.from('sensors').update({ health: h.health }).eq('id', h.id));
      world.sensors = world.sensors.map((s) => (s.id === h.id ? { ...s, health: h.health } : s));
    }
    await Promise.all(writes);
    await saveState(state);
    if (i < STEPS_PER_INVOCATION - 1) await new Promise((r) => setTimeout(r, TELEMETRY_INTERVAL_S * 1000));
  }
  return { phase: state.phase, battery_pct: state.boat.battery_pct };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const body = await req.json().catch(() => ({}));

  if (body.action === 'tick') {
    if (req.headers.get('x-cron-secret') !== Deno.env.get('CRON_SECRET')) return json({ error: 'forbidden' }, 403);
    return json(await tick());
  }

  // User-initiated controls: verify the caller is an admin.
  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
  const { data: userData } = await admin.auth.getUser(token);
  if (!userData.user) return json({ error: 'Not signed in' }, 401);
  const { data: profile } = await admin.from('profiles').select('role').eq('id', userData.user.id).single();
  if (profile?.role !== 'admin') return json({ error: 'Simulator controls need the admin role.' }, 403);

  const now = Date.now();
  let state = await loadState();
  const world = await loadWorld();
  switch (body.action) {
    case 'inject_drift': state = injectDrift(state, String(body.parameter_key), now); break;
    case 'inject_plume': state = injectPlume(state, String(body.zone_id), now); break;
    case 'drop_link': state = dropLink(state, now); break;
    case 'drain_battery': state = drainBattery(state, world.settings); break;
    case 'clear_injections': state = clearInjections(state); break;
    case 'reset': state = freshState(now); break;
    default: return json({ error: `Unknown action ${body.action}` }, 400);
  }
  await saveState(state);
  await admin.from('audit_log').insert({ user_id: userData.user.id, action: `simulator.${body.action}`, entity: 'boats', entity_id: BOAT_ID, details: body });
  return json({ ok: true, phase: state.phase });
});
