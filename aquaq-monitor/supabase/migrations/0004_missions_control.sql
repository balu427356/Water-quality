-- Phase 3: mission planning, boat commands, maintenance tasks.

alter table missions
  add column kind text not null default 'manual' check (kind in ('scheduled', 'early', 'manual')),
  add column objective double precision not null default 0,
  add column source_alert_id uuid references alerts (id),
  add column note text,
  add column started_at timestamptz,
  add column ended_at timestamptz;

alter table commands
  add column done_at timestamptz,
  add column result text,
  add constraint commands_type check (type in ('LOAD_MISSION', 'START_MISSION', 'PAUSE_MISSION', 'RESUME_MISSION', 'RETURN_HOME',
    'TAKE_SAMPLE', 'GOTO', 'ENTER_MANUAL', 'MANUAL_DRIVE', 'EXIT_MANUAL', 'EMERGENCY_STOP', 'CLEAR_ESTOP'));
create index commands_boat_status on commands (boat_id, status, issued_at desc);

create table maintenance_tasks (
  id uuid primary key default gen_random_uuid(),
  sensor_id text not null references sensors (id),
  title text not null,
  notes text not null default '',
  assigned_to uuid references profiles (id),
  status text not null default 'open' check (status in ('open', 'done')),
  created_by uuid references profiles (id),
  created_at timestamptz not null default now(),
  closed_by uuid references profiles (id),
  closed_at timestamptz
);
alter table maintenance_tasks enable row level security;
create policy "maintenance_tasks read" on maintenance_tasks for select to authenticated using (true);

-- Commands, missions, routes and sensor changes go through the `operations` Edge Function,
-- which validates them with the shared rules (role, geofence, mode conflicts, checklist,
-- energy budget) and writes the audit log. Clients can read but not write these tables.
drop policy "commands operator write" on commands;
drop policy "missions operator write" on missions;
drop policy "mission_zones operator write" on mission_zones;
drop policy "waypoints operator write" on waypoints;
drop policy "sensors operator write" on sensors;
-- Geometry edits are validated by the same function (dock inside geofence, geofence inside boundary).
drop policy "water_bodies admin write" on water_bodies;
drop policy "zones admin write" on zones;

alter publication supabase_realtime add table maintenance_tasks, mission_zones;
