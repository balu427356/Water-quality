// Seed a Supabase project with the demo lake, 6 past surveys, 90 days of station history
// and three demo users. Run once after applying the migrations:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run seed:supabase
// Uses the service-role key, so run it from your machine only, never from the browser.

import { createClient } from '@supabase/supabase-js';
import {
  demoBoat,
  demoMission,
  demoParameters,
  demoSensors,
  demoStations,
  demoWaterBody,
  demoZones,
  generateHistory,
  generateStationHistory,
} from '../supabase/functions/_shared/demoLake.ts';
import { initialSimState } from '../supabase/functions/_shared/simCore.ts';
import { DEFAULT_SETTINGS } from '../supabase/functions/_shared/types.ts';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

async function upsert(table: string, rows: object[], onConflict?: string) {
  for (let i = 0; i < rows.length; i += 1000) {
    const { error } = await db.from(table).upsert(rows.slice(i, i + 1000), onConflict ? { onConflict } : undefined);
    if (error) throw new Error(`${table}: ${error.message}`);
  }
  console.log(`  ${table}: ${rows.length}`);
}

const USERS = [
  { email: 'admin@aquaq.demo', full_name: 'Asha Admin', role: 'admin' },
  { email: 'operator@aquaq.demo', full_name: 'Omar Operator', role: 'operator' },
  { email: 'viewer@aquaq.demo', full_name: 'Vani Viewer', role: 'viewer' },
];

async function main() {
  const now = Date.now();
  const iso = new Date(now).toISOString();
  const password = process.env.DEMO_PASSWORD ?? 'demo1234';
  console.log('Seeding demo lake…');

  await upsert('water_bodies', [demoWaterBody()]);
  await upsert('zones', demoZones());
  await upsert('parameters', demoParameters());
  await upsert('app_settings', [{ id: 1, value: DEFAULT_SETTINGS }]);
  const boat = demoBoat(iso);
  await upsert('boats', [boat]);
  await upsert('stations', demoStations(iso));
  await upsert('sensors', demoSensors(now));
  const mission = demoMission(iso);
  await upsert('missions', [mission.mission]);
  await upsert('mission_zones', mission.zones, 'mission_id,zone_id');
  await upsert('waypoints', mission.waypoints, 'mission_id,seq');

  const history = generateHistory(now);
  await upsert('surveys', history.surveys);
  await upsert('zone_scores', history.zoneScores);
  await upsert('readings', history.readings);
  await upsert('readings', generateStationHistory(now));
  await upsert('sim_state', [{ boat_id: boat.id, state: initialSimState(boat, mission.waypoints, now) }]);

  console.log('Creating demo users…');
  for (const u of USERS) {
    const { data, error } = await db.auth.admin.createUser({ email: u.email, password, email_confirm: true, user_metadata: { full_name: u.full_name } });
    const id = data.user?.id ?? (await db.from('profiles').select('id').eq('email', u.email).single()).data?.id;
    if (error && !id) throw error;
    await db.from('profiles').update({ role: u.role, full_name: u.full_name }).eq('id', id);
    console.log(`  ${u.email} (${u.role})`);
  }
  console.log('Done.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
