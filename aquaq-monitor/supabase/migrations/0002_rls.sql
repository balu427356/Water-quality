-- Row Level Security: every signed-in user can read; only operators/admins write
-- operational tables; only admins change configuration. The simulator and the boat
-- gateway write with the service-role key, which bypasses RLS.

do $$
declare t text;
begin
  foreach t in array array['profiles', 'water_bodies', 'zones', 'parameters', 'app_settings', 'boats', 'stations', 'sensors',
    'missions', 'mission_zones', 'waypoints', 'surveys', 'zone_scores', 'readings', 'boat_telemetry', 'sim_state',
    'commands', 'alerts', 'alert_rules', 'audit_log']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy "%s read" on %I for select to authenticated using (true)', t, t);
  end loop;
end $$;

-- Configuration: admin only.
do $$
declare t text;
begin
  foreach t in array array['water_bodies', 'zones', 'parameters', 'app_settings', 'alert_rules', 'stations']
  loop
    execute format('create policy "%s admin write" on %I for all to authenticated using (current_role_is(array[''admin'']::app_role[])) with check (current_role_is(array[''admin'']::app_role[]))', t, t);
  end loop;
end $$;

-- Operations: operator or admin.
do $$
declare t text;
begin
  foreach t in array array['commands', 'missions', 'mission_zones', 'waypoints', 'alerts', 'sensors']
  loop
    execute format('create policy "%s operator write" on %I for all to authenticated using (current_role_is(array[''operator'', ''admin'']::app_role[])) with check (current_role_is(array[''operator'', ''admin'']::app_role[]))', t, t);
  end loop;
end $$;

-- Users can see all profiles (names in the audit log) but only admins change roles.
create policy "profiles admin write" on profiles for update to authenticated
  using (current_role_is(array['admin']::app_role[])) with check (current_role_is(array['admin']::app_role[]));

-- Audit log is append-only for signed-in users, and the row must name the caller.
create policy "audit insert own" on audit_log for insert to authenticated with check (user_id = auth.uid());
