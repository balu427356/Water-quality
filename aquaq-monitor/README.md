# AquaQ Monitor

Operator app for quantum-assisted water-quality monitoring: an autonomous survey boat, fixed sensor
stations, and a server-side trust → risk → mission-planning chain. Responsive web app, installable as a PWA.

**Status: Phase 1 (monitoring).** Auth and roles, data model and seed data, dashboard, live map, analytics,
zone details, sensors page and simulator. Alerts (Phase 2), missions and boat control (Phase 3), and
real integrations, PDF reports and survey reports (Phase 4) come next. See [Roadmap](#roadmap).

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

In demo mode, parameter and threshold edits are saved in this browser's localStorage; everything else
resets when the page reloads.

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
| `SIM_CRON_SECRET` | Edge Function secret | Shared secret between pg_cron and the simulator function |

Never put the service-role key or email/SMS provider keys in a `VITE_` variable: anything prefixed
`VITE_` is shipped to the browser.

## Switching from mock to real services

**Demo → Supabase.**

1. Create a Supabase project and apply the migrations: `supabase db push` (or paste
   `supabase/migrations/*.sql` into the SQL editor in order).
2. Seed it: `SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… npm run seed:supabase`. This creates the
   demo lake, history and the three demo users.
3. Deploy the simulator: `supabase functions deploy simulator`, then
   `supabase secrets set SIM_CRON_SECRET=<random string>`.
4. Schedule it every minute with `supabase/cron.sql.example` (needs `pg_cron` and `pg_net`).
5. Set `VITE_DATA_SOURCE=supabase`, `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, and rebuild.

**Simulator → real boat gateway.** The production gateway (MQTT over 4G → bridge) writes the same rows the
simulator writes: one `boat_telemetry` row and one `readings` row per probe per message (contract in
section 9 of the brief), plus an update of the `boats` row. Unschedule the simulator
(`select cron.unschedule('aquaq-simulator')`) and point the bridge at the database with a service-role key
kept on the bridge. The app does not change.

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
│     │                types, geo, limits/scoring helpers, demo lake + history, simulator core (+ tests)
│     └─ simulator/    Edge Function running the simulator against the database
└─ scripts/seed-supabase.ts
```

The browser and the Edge Function run the same simulator code (`_shared/simCore.ts`), so demo mode and
Supabase mode behave the same.

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
| `readings` | Every measurement, indexed on `(zone_id, parameter_key, ts)`; `edge_anomaly_flag`, `"trust_T"`, `survey_id` |
| `boat_telemetry` | Position/battery/mode history (trail, replay) |
| `surveys`, `zone_scores` | Survey runs and per-zone R, T, tier, drivers and trust gate |
| `missions`, `mission_zones`, `waypoints` | Plans, per-zone sampling levels, routes |
| `commands`, `alerts`, `alert_rules` | Created now, used from Phases 2–3 |
| `audit_log` | Who did what, when, with details |
| `sim_state` | Simulator state between Edge Function runs (v1 only) |

**RLS:** every signed-in user can read. Configuration tables (`water_bodies`, `zones`, `parameters`,
`app_settings`, `alert_rules`, `stations`) are writable by admins only. Operational tables (`commands`,
`missions`, `mission_zones`, `waypoints`, `alerts`, `sensors`) by operators and admins. `audit_log` is
insert-only and a row must name the caller. The simulator and the gateway use the service-role key.

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

## Limits and safety notes

- Default safe limits are a starting point. Check them against the standard that applies to the water
  body (for example BIS IS 10500 for drinking water, CPCB criteria for surface water).
- The app is never the only safety layer: the boat keeps its own geofence, obstacle avoidance,
  low-battery return and link-loss failsafe. In Phase 1 the app sends no boat commands at all.

## Roadmap

1. **Phase 1, monitoring** (this release).
2. **Phase 2, alerts:** rule engine with the seeded rules, notification centre, acknowledge/resolve,
   escalation, web push.
3. **Phase 3, missions and control:** mock planner (with the section 10 unit test), plan review and
   approval, command flow with acknowledgements and timeouts, emergency stop, manual mode, geofence
   validation, pre-mission checklist, zone/geofence drawing.
4. **Phase 4, integration and reports:** real planner API and boat gateway, PDF survey reports, raw
   CSV export page.
