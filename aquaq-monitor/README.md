# AquaQ Monitor

Operator app for quantum-assisted water-quality monitoring: an autonomous survey boat, fixed sensor
stations, and a server-side trust → risk → mission-planning chain. Responsive web app, installable as a PWA.

**Status: Phases 1–4 complete.**

- **Monitoring:** auth and roles, dashboard, live map, analytics, zone details, sensors page, simulator.
- **Alerts:** the alert rule engine with notification centre, escalation and web push.
- **Missions and control:** mission planning, review and approval; boat commands with
  acknowledgements, emergency stop, manual mode, pre-mission checklist and geofence editing.
- **Integration:**
  - the Python planner service (QUBO solved with simulated QAOA or the classical fallback, plus
    zone scoring);
  - the MQTT boat gateway with a boat emulator;
  - finished missions become scored surveys automatically.
- **Reports:** PDF survey reports and raw CSV export.

See [Roadmap](#roadmap).

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
| `operator@aquaq.demo` | Operator: plans and approves missions, controls the boat, handles alerts and maintenance |
| `viewer@aquaq.demo` | Viewer: read-only |

Demo mode runs entirely in the browser: a seeded demo lake (4 zones, 2 stations, 6 past surveys 15 days
apart, 90 days of hourly station data) and a simulator that moves the boat at 0.8 m/s along the running
mission, writes telemetry every 3 s and station readings every 5 minutes. On load it simulates the
previous 30 minutes so the trail and live readings are already populated. The seeded mission M-0012 is
already running; when it ends (or you send Return home) the boat docks and waits for the next approved
mission.

A typical walk-through:

1. **Missions → Plan next mission** (budget 14): the mock planner proposes A hotspot 5 m, B confirm,
   C standard 25 m, D skip (energy 14, value 2.69). Change a level to see the energy recalculated;
   approval is blocked over budget.
2. **Approve and send to boat.** While M-0012 is still running the plan is approved but not sent; send
   **Return home** on the live map (it aborts M-0012), then **Send to boat**.
3. **Start mission**: the pre-mission checklist fails on the boat's dissolved-oxygen probe (20 days since
   calibration). Fix it on **Sensors** (create a maintenance task, close it as calibrated) or, as admin,
   override with a reason (logged).
4. On the **live map**: emergency stop, pause/resume, sample here, go to point (a point outside the
   geofence is rejected), manual mode with the hold-to-drive pad.
5. **Settings → Simulator → Drop link** then send Return home: it times out after 10 s with a Retry
   button and a "Command failed" alert.

Try the simulator in **Settings → Simulator** (admin):

- **Inject sensor drift** on a boat probe: readings drift, anomalies come in with low trust, and the probe is flagged `drift_suspected`.
- **Inject pollution plume** in a zone: trusted exceedances from the boat and that zone's station.
- **Drop link for 90 s**: the live map dims stale data and, after the 60 s link-loss timeout, shows "Boat following onboard failsafe".
- **Drain battery**: the boat's onboard failsafe returns it to the dock.
- **Simulation speed** ×1–×20 (demo only) so a full mission doesn't take an hour.
- **Run survey scheduler now**: proposes the scheduled-survey mission that normally appears one day
  before each survey, and notifies operators.

Each of these raises the matching alert (see [Alerts](#alerts)). In demo mode, parameter, threshold,
alert-rule, integration and geometry edits are saved in this browser's localStorage; everything else
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
| `npm run gateway` | MQTT ↔ Supabase boat gateway (see [Boat gateway](#boat-gateway)) |
| `npm run boat-emulator` | Demo-lake boat and stations speaking the gateway's MQTT protocol |
| `npm run fixtures` | Regenerate the planner-service parity fixtures from the TypeScript code |

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
| `PLANNER_API_KEY` | Edge Function secret + planner service | Bearer key between the `operations`/`alerts` functions and the planner service |
| `MQTT_URL`, `MQTT_USERNAME`, `MQTT_PASSWORD`, `BOAT_IDS` | gateway host | Broker connection and boats the gateway serves |

Never put the service-role key or email/SMS provider keys in a `VITE_` variable: anything prefixed
`VITE_` is shipped to the browser.

## Switching from mock to real services

**Demo → Supabase.**

1. Create a Supabase project and apply the migrations: `supabase db push` (or paste
   `supabase/migrations/*.sql` into the SQL editor in order).
2. Seed it: `SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… npm run seed:supabase`. This creates the
   demo lake, history and the three demo users.
3. Deploy the functions: `supabase functions deploy simulator`, `supabase functions deploy alerts` and
   `supabase functions deploy operations`, then `supabase secrets set CRON_SECRET=<random string>`
   (plus the VAPID secrets for web push, and `PLANNER_API_KEY` if you use a planner service).
4. Schedule both every minute with `supabase/cron.sql.example` (needs `pg_cron` and `pg_net`).
5. Set `VITE_DATA_SOURCE=supabase`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` and
   `VITE_VAPID_PUBLIC_KEY`, and rebuild.

**Simulator → real boat gateway.** Run `gateway/` (see [Boat gateway](#boat-gateway)) next to your MQTT
broker, unschedule the simulator (`select cron.unschedule('aquaq-simulator')`) and keep the
`aquaq-alerts` schedule. The gateway writes the same rows the simulator writes, so the app does not
change.

**Mock planner → planner service.** Deploy `planner-service/` (FastAPI; see its
[README](planner-service/README.md)). In **Settings → Integrations** choose *Planner service URL* and
enter its base URL; the app calls `POST <url>/plan` with the section 9 request, and `POST <url>/score`
when a mission finishes. With Supabase the
`operations` function makes the call and adds `Authorization: Bearer $PLANNER_API_KEY` (a function
secret, never sent to browsers). The response is validated (known zones and levels, within budget,
route inside the geofence) before it becomes a proposed mission, and the solver it reports
(`quantum_qaoa`, `quantum_annealer`, `classical_fallback`) is shown on the plan. If the service returns no
waypoints the app builds the route itself. In demo mode the browser calls the URL directly without a key,
which is only suitable for a local planner during development.

## Project layout

```
aquaq-monitor/
├─ src/
│  ├─ api/             typed external-service clients (planner and scoring)
│  ├─ data/            DataSource interface, demo (in-browser) and Supabase implementations, selectors
│  ├─ components/      UI primitives (shadcn-style), status badges, map, chart card
│  ├─ features/        one folder per feature: auth, dashboard, map, control, missions, alerts, analytics,
│  │                   zones, sensors, settings
│  └─ lib/             time (Asia/Kolkata), CSV export, helpers
├─ supabase/
│  ├─ migrations/      0001 schema, 0002 RLS, 0003 alerts, 0004 missions/commands/maintenance
│  └─ functions/
│     ├─ _shared/      pure TypeScript shared by the app, the seed script and Edge Functions:
│     │                types, geo, limits/scoring helpers, demo lake + history, simulator core,
│     │                alert rule engine, mock planner + route builder, command validation and
│     │                pre-mission checklist, mission operations, planner client (+ tests)
│     ├─ _server/      database helpers used only by Edge Functions
│     ├─ simulator/    Edge Function running the simulator (boat + stations, commands) against the database
│     ├─ alerts/       Edge Function: alert engine, escalation, scheduled-survey proposals, push/email/SMS
│     └─ operations/   Edge Function: planning, approval, boat commands, maintenance and geometry edits,
│                      validated with the shared rules as the signed-in user
├─ gateway/           MQTT ↔ database bridge, Supabase store, boat emulator (+ end-to-end test)
├─ planner-service/   Python FastAPI planner: /plan (QUBO, simulated QAOA, classical fallback) and /score
└─ scripts/           seed-supabase.ts, make-fixtures.ts
```

The browser and the Edge Functions run the same simulator, alert-engine, planner and command-validation
code (`_shared/`), so demo mode and Supabase mode behave the same.

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
| `missions`, `mission_zones`, `waypoints` | Plans (`kind` scheduled / early / manual, solver, energy, objective, status), per-zone sampling levels and reasons, routes |
| `alerts` | Rule, dedup key, severity, category, title, message, suggested action, zone/source/parameter, value vs limit, status workflow, merge `count`, escalation |
| `alert_rules` | Enabled, base severity, channels, cooldown per rule (seeded with the section 7 rules) |
| `push_subscriptions` | Web-push subscriptions, one per device; each user manages their own |
| `engine_state` | Alert-engine memory and reading cursor between runs (service role only) |
| `commands` | Boat commands: type, payload, issued by/at, status (pending → acknowledged → executed / failed / timed_out), `ack_at`, `done_at`, `result` |
| `maintenance_tasks` | Sensor maintenance: title, notes, assignee, open/done, who closed it |
| `audit_log` | Who did what, when, with details |
| `sim_state` | Simulator state between Edge Function runs (v1 only) |

**RLS:** every signed-in user can read. Configuration tables (`water_bodies`, `zones`, `parameters`,
`app_settings`, `alert_rules`, `stations`) are writable by admins only. Operational tables (`commands`,
`missions`, `mission_zones`, `waypoints`, `sensors`, `water_bodies`, `zones`) are read-only for clients:
they change only through the `operations` Edge Function, which re-runs the shared validation (role,
geofence, mode conflicts, pre-mission checklist, energy budget, polygon checks) and writes the audit log.
Alerts change only through
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

**Scoring (`/score`, method `classical_v1`).** Every new survey is scored the same way in the app
(`_shared/scoring.ts`) and in the planner service, which a shared fixture checks:

- **Per parameter:** s_p = (0.75 × exceedance + 0.25 × share of readings outside the limit) × hazard
  weight ÷ largest weight, where exceedance runs from 0 (at 60 % of the limit) to 1 (at 140 %).
- **R** = 0.7 × max s_p + 0.3 × mean s_p. It uses every reading, so a high-risk, low-trust zone keeps
  its high R and gets a confirmation sample first.
- **T** = mean trust of the zone's anomalous readings, or 0.9 if there were none.

**The six seeded surveys use the hand-set values from the brief** (latest: A 0.9/0.9, B 0.8/0.3,
C 0.3/0.8, D 0.1/0.9), so the demo plan matches section 10. Surveys created from missions are scored
by `classical_v1`, which reads the same seeded data a little lower (A ≈ 0.76 for the latest survey). So
the first new survey can show zones as "improving" partly because the method changed.

**Closing the loop.** When a mission completes, it becomes a survey:

1. its boat and lab readings from start to end are attached;
2. they are scored (by the planner service, or in-app scoring if the service fails, which is logged);
3. the new scores drive the dashboard, the "zone tier rose" alert, the next plan and the next
   scheduled date.

In demo mode the seeded mission M-0012 completes a minute or two after loading, which creates SV-007.

**Provisional trust.** Live anomalous readings get a provisional T before survey scoring: 0.3 if the
probe's edge health is not "ok", otherwise 0.88. Confirmation samples get 0.92, and station readings
0.85.

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
| Command failed | A command is not acknowledged within 10 s, or the boat reports it failed | Warning |
| Fallback used | A mission was planned with the classical fallback | Info |
| Calibration due | Sensor not calibrated for more than 15 days, or a probe failed the pre-mission check | Warning |
| Mission proposed | A scheduled-survey or early mission waits for approval (added rule) | Info |

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

## Missions and boat control

**Planning.** The planner request uses the latest zone scores (section 9 format). The mock planner values
each choice as R × T × gain (1.0 / 1.6 / 2.2 for 25 / 10 / 5 m), a confirmation sample as R × (1 − T) × 1.2,
skip 0, tries every combination up to 8 zones and keeps the best within the budget; above 8 zones it
uses a greedy value-per-energy pass and says so on the plan. The route builder lays north–south
transects at the level's spacing (standard over the whole zone, dense in a 120 m box and hotspot in a
60 m box around the strongest trusted exceedance), puts a confirmation sample at the lowest-trust
anomaly, keeps every waypoint at least 12 m inside the geofence, visits zones nearest-first and ends at
the dock.

**Approval.** Plans are only ever *proposed*. An operator reviews the map, the zone table (with reasons),
the solver, energy against budget and level counts, can change any zone's level (energy, value and route
are recalculated; approval is blocked over budget), then presses **Approve and send to boat**. Scheduled
surveys are proposed one day before they are due; a station trigger alert offers **Plan early mission**,
which raises that zone's risk and marks the plan *Early mission*.

**Commands.** Every command is validated on the server: operator/admin only; Go to point must be inside
the geofence; commands that conflict with the current mode are rejected (for example Go to point during a
running mission); while the link is lost only Emergency stop and Return home can be sent. Emergency stop
and Return home are always allowed. Each command shows pending → acknowledged → executed (or failed /
timed out after 10 s, with Retry), and conflicting buttons are disabled while one is pending.

**Manual mode** needs a confirmation, is limited to the manual max speed (default 1 m/s), stops when no
drive input arrives for 4 s (deadman), and leaves manual mode after 2 minutes without input. The boat
refuses to drive out of its onboard geofence.

**Pre-mission checklist:** every boat probe calibrated within the interval, healthy and not flagged;
battery ≥ 80 %; link OK; geofence loaded with the dock inside. A mission cannot start until it passes
unless an admin overrides it with a reason, which is written to the audit log.

## Boat gateway

`gateway/` bridges an MQTT broker (boats on 4G/5G/satellite) and the database.

| Topic | Direction | Payload |
| --- | --- | --- |
| `aquaq/boats/{id}/telemetry` | boat → server, every 2–5 s | Section 9 telemetry message (`readings`, `edge.anomaly`, `edge.sensor_health`) |
| `aquaq/boats/{id}/samples` | boat → server | `{ts, lat, lon, kind: "confirmation" \| "manual", readings}` |
| `aquaq/boats/{id}/events` | boat → server | `{type: "mission_status", mission_id, status}` or `{type: "waypoint", mission_id, seq, status}` |
| `aquaq/boats/{id}/commands` | server → boat (QoS 1) | `{id, type, payload, issued_at}`; `LOAD_MISSION` carries the route |
| `aquaq/boats/{id}/acks` | boat → server | `{id, ts, status: "acknowledged" \| "executed" \| "failed", result?}` |
| `aquaq/stations/{id}/readings` | station → server | `{station_id, ts, readings}` |

Every incoming message is validated, then written as the rows the app already reads:

| From | Written to |
| --- | --- |
| Telemetry | `boat_telemetry` and `boats`; one `readings` row per probe (zone from the position, anomaly from the limits, provisional trust); sensor-health changes |
| Samples | `readings` (confirmation samples flagged) |
| Events | `missions`, `waypoints` |
| Acks | `commands` |

The gateway forwards each pending command once, and marks it `timed_out` if the boat does not
acknowledge it within the command timeout. It needs the service-role key, so run it on a server
you control, never in a browser.

```bash
MQTT_URL=mqtts://broker:8883 MQTT_USERNAME=… MQTT_PASSWORD=… \
SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… BOAT_IDS=B1 npm run gateway
# Without hardware: a boat + stations speaking the same protocol
MQTT_URL=mqtt://localhost:1883 npm run boat-emulator
```

`gateway/gateway.test.ts` runs the emulator, the gateway and an in-process MQTT broker end to end:
telemetry rows, command acknowledgements, a full mission, timeouts and probe drift.

## Reports

- **Survey report** (Reports → Open report), one per survey:
  - summary with comparison to the previous survey;
  - zone table (R, T, tier, change, trust gate, top driver);
  - map with sampling points, and an R-by-zone chart against the previous survey;
  - parameter means against limits;
  - missions run with their solver, and alerts raised in the period.

  **Export PDF** opens the print dialog with an A4 print layout; choose *Save as PDF*. The report
  says when it shows demo data.
- **Raw data export:** readings filtered by date range (IST), zones, parameters, sources, survey,
  anomalies only, or low trust only. Each CSV row includes UTC and IST time, the limit and the
  within/near/outside status. Every analytics chart also has its own CSV export.

## Limits and safety notes

- Default safe limits are a starting point. Check them against the standard that applies to the water
  body (for example BIS IS 10500 for drinking water, CPCB criteria for surface water).
- The app is never the only safety layer: the boat keeps its own geofence, obstacle avoidance,
  low-battery return and link-loss failsafe. The app shows these states and cannot turn them off; the
  simulator models them (geofence hold in manual mode, low-battery return, link-loss hold).

## Roadmap

1. **Phase 1, monitoring** (done).
2. **Phase 2, alerts** (done): rule engine with the seeded rules, notification centre,
   acknowledge/resolve, escalation, web push.
3. **Phase 3, missions and control** (done): mock planner (with the section 10 unit test), plan review
   and approval, command flow with acknowledgements and timeouts, emergency stop, manual mode, geofence
   validation, pre-mission checklist, maintenance tasks, zone/geofence drawing, audit log.
4. **Phase 4, integration and reports** (done): planner service with QUBO/QAOA and the classical
   fallback, `/score` parity, mission → survey → scores loop, MQTT boat gateway and emulator, PDF
   survey reports, raw CSV export.
