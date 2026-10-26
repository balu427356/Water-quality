-- Phase 2: alert engine, notification workflow and web push.

-- Confirmation samples are independent of the routine probe reading.
alter table readings add column confirmation boolean not null default false;
-- Insert time (not measurement time) is the alert engine's cursor, so late-arriving data is not skipped.
alter table readings add column inserted_at timestamptz not null default now();
create index readings_inserted_at on readings (inserted_at);

alter table profiles add column phone text;

alter table alerts
  add column rule_id text references alert_rules (id),
  add column dedup_key text not null default '',
  add column suggested_action text not null default '',
  add column parameter_key text,
  add column value double precision,
  add column limit_text text,
  add column updated_at timestamptz not null default now(),
  add column escalated_at timestamptz,
  add column escalation_count int not null default 0,
  add column action text check (action in ('propose_early_mission'));
create index alerts_open_dedup on alerts (dedup_key) where status <> 'resolved';
create index alerts_updated on alerts (updated_at desc);

alter table alert_rules add constraint alert_rules_severity check (severity in ('info', 'warning', 'high', 'critical'));

-- Alerts change only through the engine (service role) and the workflow functions below,
-- so the Open → Acknowledged → Resolved rules and the required note are enforced server-side.
drop policy "alerts operator write" on alerts;

create function acknowledge_alert(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare a alerts;
begin
  if not current_role_is(array['operator', 'admin']::app_role[]) then
    raise exception 'Acknowledging alerts needs the operator or admin role.';
  end if;
  select * into a from alerts where id = p_id for update;
  if not found then raise exception 'Alert not found.'; end if;
  if a.status <> 'open' then raise exception 'Only open alerts can be acknowledged.'; end if;
  update alerts set status = 'acknowledged', acknowledged_by = auth.uid(), acknowledged_at = now() where id = p_id;
  insert into audit_log (user_id, action, entity, entity_id, details)
    values (auth.uid(), 'alert.acknowledge', 'alerts', p_id::text, jsonb_build_object('title', a.title));
end $$;

create function resolve_alert(p_id uuid, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare a alerts;
begin
  if not current_role_is(array['operator', 'admin']::app_role[]) then
    raise exception 'Resolving alerts needs the operator or admin role.';
  end if;
  if coalesce(btrim(p_note), '') = '' then raise exception 'A resolution note is required.'; end if;
  select * into a from alerts where id = p_id for update;
  if not found then raise exception 'Alert not found.'; end if;
  if a.status = 'resolved' then raise exception 'This alert is already resolved.'; end if;
  update alerts set
    status = 'resolved',
    acknowledged_by = coalesce(acknowledged_by, auth.uid()),
    acknowledged_at = coalesce(acknowledged_at, now()),
    resolved_by = auth.uid(),
    resolved_at = now(),
    resolution_note = btrim(p_note)
  where id = p_id;
  insert into audit_log (user_id, action, entity, entity_id, details)
    values (auth.uid(), 'alert.resolve', 'alerts', p_id::text, jsonb_build_object('title', a.title, 'note', btrim(p_note)));
end $$;

revoke execute on function acknowledge_alert(uuid) from public, anon;
revoke execute on function resolve_alert(uuid, text) from public, anon;
grant execute on function acknowledge_alert(uuid) to authenticated;
grant execute on function resolve_alert(uuid, text) to authenticated;

-- Web-push subscriptions: each user manages their own devices.
create table push_subscriptions (
  endpoint text primary key,
  user_id uuid not null references profiles (id) on delete cascade,
  subscription jsonb not null,
  created_at timestamptz not null default now()
);
alter table push_subscriptions enable row level security;
create policy "push own read" on push_subscriptions for select to authenticated using (user_id = auth.uid());
create policy "push own insert" on push_subscriptions for insert to authenticated with check (user_id = auth.uid());
create policy "push own update" on push_subscriptions for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "push own delete" on push_subscriptions for delete to authenticated using (user_id = auth.uid());

-- Alert engine memory between runs (service role only: RLS on, no policies).
create table engine_state (
  id int primary key default 1 check (id = 1),
  memory jsonb not null,
  cursor timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table engine_state enable row level security;

alter publication supabase_realtime add table alert_rules;
