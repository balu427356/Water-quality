-- AquaQ Monitor schema.
-- Geometry is stored as JSON arrays of [lat, lon] pairs so the app, the simulator and RLS stay simple;
-- switch to PostGIS later if spatial queries are needed server-side.
-- Mixed-case columns ("risk_R", "trust_T") are quoted on purpose so the API matches the brief.

create extension if not exists pgcrypto;

-- ------------------------------------------------------------------ users

create type app_role as enum ('admin', 'operator', 'viewer');

create table profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text not null default '',
  role app_role not null default 'viewer',
  created_at timestamptz not null default now()
);

-- New sign-ups become viewers; an admin promotes them.
create function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, email, full_name) values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'full_name', ''));
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();

create function current_role_is(roles app_role[]) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = any (roles));
$$;

-- ------------------------------------------------------------------ water body

create table water_bodies (
  id text primary key,
  name text not null,
  type text not null check (type in ('river', 'lake')),
  boundary jsonb not null,
  home_point jsonb not null,
  geofence jsonb not null
);

create table zones (
  id text primary key,
  water_body_id text not null references water_bodies (id) on delete cascade,
  code text not null,
  name text not null,
  polygon jsonb not null,
  notes text not null default '',
  unique (water_body_id, code)
);

create table parameters (
  id text primary key,
  key text not null unique,
  name text not null,
  unit text not null,
  limit_type text not null check (limit_type in ('max', 'min', 'range', 'none')),
  limit_low double precision,
  limit_high double precision,
  hazard_weight double precision not null default 1,
  enabled boolean not null default true
);

-- Single-row global thresholds (section 6.9).
create table app_settings (
  id int primary key default 1 check (id = 1),
  value jsonb not null
);

-- ------------------------------------------------------------------ assets

create table boats (
  id text primary key,
  name text not null,
  status text not null default 'offline' check (status in ('online', 'offline')),
  battery_pct double precision not null default 0,
  mode text not null default 'IDLE' check (mode in ('IDLE', 'AUTO', 'MANUAL', 'RETURNING', 'EMERGENCY_STOP')),
  last_seen timestamptz,
  link_type text not null default 'none' check (link_type in ('4G', '5G', 'satellite', 'none')),
  position jsonb,
  heading_deg double precision not null default 0,
  speed_mps double precision not null default 0,
  mission_id text,
  waypoint_seq int
);

create table stations (
  id text primary key,
  name text not null,
  position jsonb not null,
  zone_id text references zones (id),
  status text not null default 'offline' check (status in ('online', 'offline')),
  last_seen timestamptz
);

create table sensors (
  id text primary key,
  owner_type text not null check (owner_type in ('boat', 'station')),
  owner_id text not null,
  parameter_key text not null references parameters (key),
  last_calibrated_at timestamptz,
  health text not null default 'ok' check (health in ('ok', 'drift_suspected', 'fouling_suspected', 'failed')),
  maintenance_flag boolean not null default false
);

-- ------------------------------------------------------------------ surveys & missions

create table missions (
  id text primary key,
  boat_id text not null references boats (id),
  name text not null default '',
  created_by text not null check (created_by in ('planner', 'operator')),
  solver text not null check (solver in ('quantum_qaoa', 'quantum_annealer', 'classical_fallback', 'mock')),
  energy_budget double precision not null,
  energy_planned double precision not null,
  status text not null check (status in ('proposed', 'approved', 'sent', 'running', 'paused', 'completed', 'aborted')),
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz not null default now()
);

create table mission_zones (
  mission_id text not null references missions (id) on delete cascade,
  zone_id text not null references zones (id),
  level text not null check (level in ('skip', 'standard_25m', 'dense_10m', 'hotspot_5m', 'confirm')),
  "risk_R" double precision not null,
  "trust_T" double precision not null,
  energy double precision not null,
  reason text not null default '',
  primary key (mission_id, zone_id)
);

create table waypoints (
  mission_id text not null references missions (id) on delete cascade,
  seq int not null,
  lat double precision not null,
  lon double precision not null,
  action text not null check (action in ('transit', 'sample', 'confirm_sample')),
  status text not null default 'pending' check (status in ('pending', 'reached', 'skipped')),
  primary key (mission_id, seq)
);

create table surveys (
  id text primary key,
  water_body_id text not null references water_bodies (id),
  type text not null check (type in ('scheduled', 'unscheduled')),
  started_at timestamptz not null,
  ended_at timestamptz,
  status text not null check (status in ('planned', 'running', 'completed', 'aborted')),
  mission_id text references missions (id)
);

create table zone_scores (
  id text primary key,
  survey_id text not null references surveys (id) on delete cascade,
  zone_id text not null references zones (id),
  "risk_R" double precision not null,
  "trust_T" double precision not null,
  risk_tier text not null check (risk_tier in ('Low', 'Medium', 'High', 'Critical')),
  top_drivers jsonb not null default '[]',
  trust_gate text not null check (trust_gate in ('auto_accept', 'lab_review')),
  trust_gate_reason text,
  computed_at timestamptz not null default now()
);

-- ------------------------------------------------------------------ data

create table readings (
  id text primary key default gen_random_uuid()::text,
  source_type text not null check (source_type in ('boat', 'station', 'lab')),
  source_id text not null,
  ts timestamptz not null,
  lat double precision,
  lon double precision,
  zone_id text references zones (id),
  parameter_key text not null references parameters (key),
  value double precision not null,
  edge_anomaly_flag boolean not null default false,
  "trust_T" double precision,
  imputed boolean not null default false,
  survey_id text references surveys (id)
);
create index readings_zone_param_ts on readings (zone_id, parameter_key, ts);
create index readings_source_ts on readings (source_id, ts);
create index readings_ts on readings (ts);

create table boat_telemetry (
  id bigint generated always as identity primary key,
  boat_id text not null references boats (id),
  ts timestamptz not null,
  lat double precision not null,
  lon double precision not null,
  heading_deg double precision not null,
  speed_mps double precision not null,
  battery_pct double precision not null,
  mode text not null,
  link text not null,
  mission_id text,
  waypoint_seq int
);
create index boat_telemetry_boat_ts on boat_telemetry (boat_id, ts desc);

-- Simulator state, persisted between Edge Function invocations (v1 only).
create table sim_state (
  boat_id text primary key references boats (id),
  state jsonb not null,
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------------ commands, alerts, audit (used from Phase 2/3)

create table commands (
  id uuid primary key default gen_random_uuid(),
  boat_id text not null references boats (id),
  type text not null,
  payload jsonb not null default '{}',
  issued_by uuid references profiles (id),
  issued_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'acknowledged', 'executed', 'failed', 'timed_out')),
  ack_at timestamptz
);

create table alerts (
  id uuid primary key default gen_random_uuid(),
  severity text not null check (severity in ('info', 'warning', 'high', 'critical')),
  category text not null,
  title text not null,
  message text not null,
  zone_id text references zones (id),
  source_id text,
  created_at timestamptz not null default now(),
  status text not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  acknowledged_by uuid references profiles (id),
  acknowledged_at timestamptz,
  resolved_by uuid references profiles (id),
  resolved_at timestamptz,
  resolution_note text,
  count int not null default 1
);

create table alert_rules (
  id text primary key,
  name text not null,
  enabled boolean not null default true,
  condition jsonb not null,
  severity text not null,
  channels text[] not null default array['in_app'],
  cooldown_minutes int not null default 30
);

create table audit_log (
  id bigint generated always as identity primary key,
  user_id uuid references profiles (id),
  action text not null,
  entity text not null,
  entity_id text,
  details jsonb not null default '{}',
  ts timestamptz not null default now()
);

-- ------------------------------------------------------------------ realtime

alter publication supabase_realtime add table boats, stations, sensors, readings, boat_telemetry, zone_scores,
  missions, waypoints, alerts, commands, parameters, app_settings, sim_state;
