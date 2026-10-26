# AquaQ Monitor

Operator app for quantum-assisted water-quality monitoring: an autonomous survey boat, fixed sensor
stations, and a server-side trust → risk → mission-planning chain. Responsive web app, installable as a PWA.

**Status: Phases 1–2 (monitoring and alerts).** Auth and roles, data model and seed data, dashboard, live
map, analytics, zone details, sensors page, simulator, and the alert rule engine with notification centre,
acknowledge/resolve, escalation and web push. Missions and boat control (Phase 3) and real integrations,
PDF reports and survey reports (Phase 4) come next. See [Roadmap](#roadmap).

## Quick start (no backend needed)

```bash
cd aquaq-monitor
npm install
npm run dev          # http://localhost:5173
```

Sign in with a demo account (password `demo1234`):

| Email | Role |
| --- | --- |
| `admin@aquaq.demo` | Admin: everything, including Settings and simulator controls |
| `operator@aquaq.demo` | Operator: all views (mission and boat controls arrive in Phase 3) |
| `viewer@aquaq.demo` | Viewer: read-only |

Demo mode runs entirely in the browser: a seeded demo lake (4 zones, 2 stations, 6 past surveys 15 days
apart, 90 days of hourly station data) and a simulator that moves the boat at 0.8 m/s along the running
mission, writes telemetry every 3 s and station readings every 5 minutes. On load it simulates the
previous 30 minutes so the trail and live readings are already populated.

Try the simulator in **Settings → Simulator** (admin):

- **Inject sensor drift** on a boat probe: readings drift, anomalies come in with low trust, and the probe is flagged `drift_suspected`.
- **Inject pollution plume** in a zone: trusted exceedances from the boat and that zone's station.
- **Drop link for 90 s**: the live map dims stale data and, after the 60 s link-loss timeout, shows "Boat following onboard failsafe".
- **Drain battery**: the boat's onboard failsafe returns it to the dock.
- **Simulation speed** ×1–×20 (demo only) so a full patrol loop doesn't take an hour.

Each of these raises the matching alert (see [Alerts](#alerts)). In demo mode, parameter, threshold and
alert-rule edits are saved in this browser's localStorage; everything else resets when the page reloads.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server |
| `npm run build` | Type-check and production build (with service worker) |
| `npm run preview` | Serve the production build |
| `npm test` | Unit tests (Vitest) |
| `npm run typecheck` | TypeScript only |
| `npm run seed:supabase` | Seed a Supabase project (see below) |

## Environment variables

Copy `.env.example` to `.env.local`.

| Variable | Where | Purpose |
| --- | --- | --- |
| `VITE_DATA_SOURCE` | browser | `demo` (default) or `supabase` |
| `VITE_SUPABASE_URL` | browser | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | browser | Supabase anon (public) key. RLS protects the data. |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | your machine | Used only by `scripts/seed-supabase.ts` |
| `VITE_VAPID_PUBLIC_KEY` | browser | Public VAPID key for web push (public by design) |
| `CRON_SECRET` | Edge Function secret | Shared secret between pg_cron and the `simulator` / `alerts` functions |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Edge Function secrets | Web push signing (`npx web-push generate-vapid-keys`) |
| `EMAIL_WEBHOOK_URL`, `SMS_WEBHOOK_URL` | Edge Function secrets | Optional HTTP endpoints of your email/SMS provider; empty in v1, so those channels are skipped |

Never put the service-role key or email/SMS provider keys in a `VITE_` variable: anything prefixed
`VITE_` is shipped to the browser.

## Switching from mock to real services

**Demo → Supabase.**

1. Create a Supabase project and apply the migrations: `supabase db push` (or paste
   `supabase/migrations/*.sql` into the SQL editor in order).
2. Seed it: `SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… npm run seed:supabase`. This creates the
   demo lake, history and the three demo users.
3. Deploy the functions: `supabase functions deploy simulator` and `supabase functions deploy alerts`, then
   `supabase secrets set CRON_SECRET=<random string>` (plus the VAPID secrets for web push).
4. Schedule both every minute with `supabase/cron.sql.example` (needs `pg_cron` and `pg_net`).
5. Set `VITE_DATA_SOURCE=supabase`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` and
   `VITE_VAPID_PUBLIC_KEY`, and rebuild.

**Simulator → real boat gateway.** The production gateway (MQTT over 4G → bridge) writes the same rows the
simulator writes: one `boat_telemetry` row and one `readings` row per probe per message (contract in
section 9 of the brief), plus an update of the `boats` row. Unschedule the simulator
(`select cron.unschedule('aquaq-simulator')`) and point the bridge at the database with a service-role key
kept on the bridge. Keep the `aquaq-alerts` schedule: the alert engine works on whatever writes readings.
Confirmation samples are written with `confirmation = true`. The app does not change.

**Mock planner → quantum planner service.** Phase 3 adds the planner client and the mock planner; the
planner URL and key will be set in Settings → Integrations and kept server-side.

## Project layout

```
aquaq-monitor/
├─ src/
│  ├─ data/            DataSource interface, demo (in-browser) and Supabase implementations, selectors
│  ├─ components/      UI primitives (shadcn-style), status badges, map, chart card
│  ├─ features/        one folder per feature: auth, dashboard, map, analytics, zones, sensors, missions, settings
│  └─ lib/             time (Asia/Kolkata), CSV export, helpers
├─ supabase/
│  ├─ migrations/      0001_schema.sql (tables), 0002_rls.sql (Row Level Security)
│  └─ functions/
│     ├─ _shared/      pure TypeScript shared by the app, the seed script and Edge Functions:
│     │                types, geo, limits/scoring helpers, demo lake + history, simulator core,
│     │                alert rule engine (+ tests)
│     ├─ simulator/    Edge Function running the simulator against the database
│     └─ alerts/       Edge Function running the alert engine, escalation and push/email/SMS dispatch
└─ scripts/seed-supabase.ts
```

The browser and the Edge Functions run the same simulator and alert-engine code (`_shared/simCore.ts`,
`_shared/alertEngine.ts`), so demo mode and Supabase mode behave the same.

## Database schema

Geometry is stored as JSON arrays of `[lat, lon]` pairs. `"risk_R"` and `"trust_T"` are quoted
mixed-case columns so the API matches the brief.

| Table | Purpose |
| --- | --- |
| `profiles` | One row per auth user: `role` is `admin`, `operator` or `viewer` (new sign-ups are viewers) |
| `water_bodies` | Name, type, `boundary`, `home_point`, `geofence` |
| `zones` | Zone code, name, `polygon` |
| `parameters` | Unit, `limit_type` (max/min/range/none), `limit_low`, `limit_high`, `hazard_weight`, `enabled` |
| `app_settings` | Single row of thresholds (trust threshold, tier cut-offs, low-battery level, link-loss timeout, survey interval…) |
| `boats` | Live boat state: mode, battery, link, position, heading, speed, current mission/waypoint |
| `stations` | Fixed stations with position and zone |
| `sensors` | Probe per owner and parameter: calibration date, health, maintenance flag |
| `readings` | Every measurement, indexed on `(zone_id, parameter_key, ts)`; `edge_anomaly_flag`, `"trust_T"`, `survey_id`, `confirmation`, `inserted_at` (alert-engine cursor) |
| `boat_telemetry` | Position/battery/mode history (trail, replay) |
| `surveys`, `zone_scores` | Survey runs and per-zone R, T, tier, drivers and trust gate |
| `missions`, `mission_zones`, `waypoints` | Plans, per-zone sampling levels, routes |
| `alerts` | Rule, dedup key, severity, category, title, message, suggested action, zone/source/parameter, value vs limit, status workflow, merge `count`, escalation |
| `alert_rules` | Enabled, base severity, channels, cooldown per rule (seeded with the section 7 rules) |
| `push_subscriptions` | Web-push subscriptions, one per device; each user manages their own |
| `engine_state` | Alert-engine memory and reading cursor between runs (service role only) |
| `commands` | Created now, used from Phase 3 |
| `audit_log` | Who did what, when, with details |
| `sim_state` | Simulator state between Edge Function runs (v1 only) |

**RLS:** every signed-in user can read. Configuration tables (`water_bodies`, `zones`, `parameters`,
`app_settings`, `alert_rules`, `stations`) are writable by admins only. Operational tables (`commands`,
`missions`, `mission_zones`, `waypoints`, `sensors`) by operators and admins. Alerts change only through
the engine (service role) and the `acknowledge_alert` / `resolve_alert` functions, which check the role,
the state transition and the required note, and write the audit log. `audit_log` is insert-only and a
row must name the caller. The simulator, alert engine and gateway use the service-role key.

## How values are classified

- **Near limit:** inside the limit but within 10 % (configurable) of it. The 10 % is of the limit value
  for max/min limits and of the range width for range limits (pH 6.5–8.5 → near below 6.7 or above 8.3).
- **Risk tier:** R ≥ 0.75 Critical, ≥ 0.5 High, ≥ 0.25 Medium, else Low (configurable).
- **Trust gate:** Lab review when T is below the trust threshold, or when R is within 0.03 of a tier
  cut-off; otherwise Auto-accept.
- **Drivers:** hazard weight × (mean ÷ limit − 0.75); positive pushes toward unsafe.
- **Estimated source (★)** on the map: location of the strongest trusted, hazard-weighted exceedance.

In Phase 1 the seeded zone scores stand in for the scoring service; the demo lake's latest survey
matches the table in section 10 (A 0.9/0.9, B 0.8/0.3, C 0.3/0.8, D 0.1/0.9). Every plan shows the
solver that produced it; the demo mission is labelled *mock planner*.

## Alerts

The rule engine (`_shared/alertEngine.ts`) runs on every new reading and on the boat, sensor, survey and
mission state. In demo mode it runs in the browser every 3 s; with Supabase the `alerts` function runs it
every minute.

| Rule | Fires when | Severity |
| --- | --- | --- |
| Limit exceeded | Trusted boat/lab reading (T ≥ threshold, or no anomaly) outside the limit | High; Critical above 2× the limit or in a Critical-tier zone |
| Near limit | Trusted reading inside the limit but in the near-limit band | Warning |
| Possible sensor fault | Anomaly with T below the threshold. Title: "Possible sensor fault: confirmation sample planned"; never worded as pollution | Warning |
| Confirmed pollution | The next confirmation sample in that zone is also outside the limit | High; Critical above 2× or in a Critical zone |
| Fault confirmed | The confirmation sample is inside the limit. After 3 in a row for the same probe, its maintenance flag is set | Info |
| Zone tier rose | A zone's tier is higher than in the previous survey | High |
| Station trigger | A fixed station reports a trusted exceedance; the alert proposes an early mission | High |
| Low battery | Battery below the return level (the boat returns by itself) | High |
| Link lost | No telemetry for longer than the link-loss timeout | Critical |
| Geofence | Boat within 10 m of the geofence / outside it | Warning / Critical |
| Command failed | A command times out or fails (wired up in Phase 3) | Warning |
| Fallback used | A mission was planned with the classical fallback | Info |
| Calibration due | Sensor not calibrated for more than 15 days (pre-mission check failures join in Phase 3) | Warning |

- **Noise control:** an alert that is still open or acknowledged absorbs repeats of the same rule, zone
  and parameter (count shown as ×N). After an alert is resolved, the rule's cooldown must pass before
  the same alert can open again. State rules (link lost, low battery, geofence, calibration) fire on the
  transition only.
- **Workflow:** Open → Acknowledged (who, when) → Resolved (note required). Operators and admins only;
  every step is in the audit log.
- **Escalation:** a Critical alert not acknowledged within 15 minutes (configurable) is re-sent to all
  operators and admins, and again every further 15 minutes until someone acknowledges it.
- **Channels:** in-app (notification centre, bell badge, toasts) always. Web push when the user turns on
  notifications on a device (Alerts page). Email/SMS through the provider webhooks when configured. In
  demo mode there is no push server, so the open app shows local browser notifications instead.
- **Confirmation samples:** the simulator takes an independent sample at each `confirm_sample` waypoint
  (probe drift does not apply to it), which is what turns a "Possible sensor fault" into "Confirmed
  pollution" or "Fault confirmed". In the demo route that waypoint is in zone B.

## Limits and safety notes

- Default safe limits are a starting point. Check them against the standard that applies to the water
  body (for example BIS IS 10500 for drinking water, CPCB criteria for surface water).
- The app is never the only safety layer: the boat keeps its own geofence, obstacle avoidance,
  low-battery return and link-loss failsafe. In Phase 1 the app sends no boat commands at all.

## Roadmap

1. **Phase 1, monitoring** (done).
2. **Phase 2, alerts** (done): rule engine with the seeded rules, notification centre,
   acknowledge/resolve, escalation, web push.
3. **Phase 3, missions and control:** mock planner (with the section 10 unit test), plan review and
   approval, command flow with acknowledgements and timeouts, emergency stop, manual mode, geofence
   validation, pre-mission checklist, zone/geofence drawing.
4. **Phase 4, integration and reports:** real planner API and boat gateway, PDF survey reports, raw
   CSV export page.
