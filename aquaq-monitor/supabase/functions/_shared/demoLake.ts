// Demo lake definition and seeded history (section 10 of the brief).
// Everything is generated deterministically from a fixed PRNG seed so the
// browser demo, the Supabase seed script and the tests all see the same data.

import { fromLocal, pointInPolygon } from './geo.ts';
import { computeDrivers, limitStatus, riskTier, round, trustGate } from './limits.ts';
import {
  DEFAULT_SETTINGS,
  type Boat,
  type LatLon,
  type Mission,
  type MissionZone,
  type Parameter,
  type Polygon,
  type Reading,
  type Sensor,
  type Station,
  type Survey,
  type WaterBody,
  type Waypoint,
  type Zone,
  type ZoneScore,
} from './types.ts';

export const LAKE_ORIGIN: LatLon = [12.9716, 79.1588];
const A_M = 350; // lake semi-axis east–west (m)
const B_M = 220; // lake semi-axis north–south (m)
const SPLIT_WEST = -180; // inflow channel | middle
const SPLIT_EAST = 120; // middle | outflow

export const BOAT_PROBES = ['ph', 'do', 'temperature', 'turbidity', 'conductivity', 'tds', 'orp'] as const;
export const STATION_PROBES = ['ph', 'do', 'temperature', 'turbidity', 'conductivity', 'orp'] as const;
export const LAB_PARAMS = ['hardness', 'chlorine', 'sulfate', 'organic_carbon', 'trihalomethanes'] as const;

// ---------------------------------------------------------------- PRNG

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(rng: () => number): number {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------------------------------------------------------------- geometry

const loc = (x: number, y: number) => fromLocal(LAKE_ORIGIN, x, y);
const ellipseY = (x: number, scale = 1) => B_M * scale * Math.sqrt(Math.max(0, 1 - (x / (A_M * scale)) ** 2));

function ellipse(scale: number, n = 48): Polygon {
  const pts: Polygon = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * 2 * Math.PI;
    pts.push(loc(A_M * scale * Math.cos(t), B_M * scale * Math.sin(t)));
  }
  return pts;
}

/** Part of the lake between x0 and x1 (local metres), optionally only north/south of y = 0. */
function strip(x0: number, x1: number, half: 'north' | 'south' | 'both', n = 16): Polygon {
  const xs = Array.from({ length: n + 1 }, (_, i) => x0 + ((x1 - x0) * i) / n);
  const top = xs.map((x) => loc(x, half === 'south' ? 0 : ellipseY(x)));
  const bottom = [...xs].reverse().map((x) => loc(x, half === 'north' ? 0 : -ellipseY(x)));
  return [...top, ...bottom];
}

// ---------------------------------------------------------------- reference data

export const WATER_BODY_ID = 'WB1';
export const BOAT_ID = 'B1';
export const DEMO_MISSION_ID = 'M-0012';

export function demoWaterBody(): WaterBody {
  return {
    id: WATER_BODY_ID,
    name: 'Demo Lake (Vellore)',
    type: 'lake',
    boundary: ellipse(1),
    geofence: ellipse(0.92),
    home_point: loc(200, -140),
  };
}

export function demoZones(): Zone[] {
  return [
    { id: 'A', water_body_id: WATER_BODY_ID, code: 'A', name: 'Near drain outlet', polygon: strip(SPLIT_WEST, SPLIT_EAST, 'north'), notes: 'Storm drain outfall on the north shore.' },
    { id: 'B', water_body_id: WATER_BODY_ID, code: 'B', name: 'Mid-lake', polygon: strip(SPLIT_WEST, SPLIT_EAST, 'south'), notes: 'Open water, deepest part of the lake.' },
    { id: 'C', water_body_id: WATER_BODY_ID, code: 'C', name: 'Inflow channel', polygon: strip(-A_M + 0.5, SPLIT_WEST, 'both'), notes: 'Feeder channel from upstream fields.' },
    { id: 'D', water_body_id: WATER_BODY_ID, code: 'D', name: 'Outflow', polygon: strip(SPLIT_EAST, A_M - 0.5, 'both'), notes: 'Weir and outflow; dock on the south-east shore.' },
  ];
}

export function demoParameters(): Parameter[] {
  const p = (
    key: string,
    name: string,
    unit: string,
    limit_type: Parameter['limit_type'],
    limit_low: number | null,
    limit_high: number | null,
    hazard_weight: number,
  ): Parameter => ({ id: key, key, name, unit, limit_type, limit_low, limit_high, hazard_weight, enabled: true });
  return [
    p('ph', 'pH', 'pH units', 'range', 6.5, 8.5, 1.0),
    p('do', 'Dissolved oxygen', 'mg/L', 'min', 5, null, 1.2),
    p('temperature', 'Temperature', '°C', 'none', null, null, 0),
    p('turbidity', 'Turbidity', 'NTU', 'max', null, 5, 1.0),
    p('conductivity', 'Conductivity', 'µS/cm', 'max', null, 400, 0.8),
    p('tds', 'Total dissolved solids', 'mg/L', 'max', null, 1000, 0.8),
    p('hardness', 'Hardness', 'mg/L', 'max', null, 600, 0.5),
    p('chlorine', 'Chlorine', 'mg/L', 'max', null, 4, 0.7),
    p('sulfate', 'Sulfate', 'mg/L', 'max', null, 400, 0.6),
    p('organic_carbon', 'Organic carbon', 'mg/L', 'max', null, 4, 0.9),
    p('trihalomethanes', 'Trihalomethanes', 'µg/L', 'max', null, 80, 1.0),
    p('orp', 'ORP', 'mV', 'none', null, null, 0),
  ];
}

export function demoStations(nowIso: string): Station[] {
  return [
    { id: 'S1', name: 'S1 Drain outlet', position: loc(-50, 170), zone_id: 'A', status: 'online', last_seen: nowIso },
    { id: 'S2', name: 'S2 Inflow', position: loc(-280, 20), zone_id: 'C', status: 'online', last_seen: nowIso },
  ];
}

export function demoBoat(nowIso: string): Boat {
  const home = demoWaterBody().home_point;
  return {
    id: BOAT_ID,
    name: 'AquaQ-1',
    status: 'online',
    battery_pct: 92,
    mode: 'AUTO',
    last_seen: nowIso,
    link_type: '4G',
    position: home,
    heading_deg: 0,
    speed_mps: 0,
    mission_id: DEMO_MISSION_ID,
    waypoint_seq: 1,
  };
}

const DAY = 86_400_000;

export function demoSensors(now: number): Sensor[] {
  const out: Sensor[] = [];
  const calib: Record<string, number> = { ph: 6, do: 20, temperature: 12, turbidity: 6, conductivity: 6, tds: 6, orp: 9 };
  for (const k of BOAT_PROBES) {
    out.push({
      id: `B1-${k}`,
      owner_type: 'boat',
      owner_id: BOAT_ID,
      parameter_key: k,
      last_calibrated_at: new Date(now - calib[k] * DAY).toISOString(),
      // The boat DO probe caused zone B's low-trust anomaly in the latest survey; it is
      // overdue for calibration but currently reads plausibly (use "inject drift" to see drift).
      health: 'ok',
      maintenance_flag: false,
    });
  }
  for (const s of ['S1', 'S2']) {
    for (const k of STATION_PROBES) {
      const days = s === 'S2' && k === 'turbidity' ? 18 : s === 'S1' ? 4 : 11;
      out.push({
        id: `${s}-${k}`,
        owner_type: 'station',
        owner_id: s,
        parameter_key: k,
        last_calibrated_at: new Date(now - days * DAY).toISOString(),
        health: s === 'S2' && k === 'turbidity' ? 'fouling_suspected' : 'ok',
        maintenance_flag: false,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- the running demo mission

/** Sampling plan matching the expected planner output for the demo lake (section 10). */
export const DEMO_PLAN: { zone_id: string; level: MissionZone['level']; R: number; T: number; energy: number; reason: string }[] = [
  { zone_id: 'A', level: 'hotspot_5m', R: 0.9, T: 0.9, energy: 10, reason: 'High risk and high trust: map the hotspot at 5 m spacing.' },
  { zone_id: 'B', level: 'confirm', R: 0.8, T: 0.3, energy: 1, reason: 'High risk but low trust: one confirmation sample before chasing.' },
  { zone_id: 'C', level: 'standard_25m', R: 0.3, T: 0.8, energy: 3, reason: 'Moderate risk, trusted data: standard 25 m survey.' },
  { zone_id: 'D', level: 'skip', R: 0.1, T: 0.9, energy: 0, reason: 'Low risk: skip this survey to save energy.' },
];

const ROUTE: [number, number, Waypoint['action']][] = [
  [250, -40, 'transit'],
  [-20, -100, 'confirm_sample'],
  [-230, -60, 'sample'],
  [-290, 25, 'sample'],
  [-240, 90, 'sample'],
  [-150, 120, 'sample'],
  [-100, 150, 'sample'],
  [-60, 162, 'sample'],
  [-20, 140, 'sample'],
  [20, 170, 'sample'],
  [60, 140, 'sample'],
  [90, 110, 'sample'],
  [-40, 100, 'sample'],
  [150, 0, 'transit'],
  [200, -140, 'transit'],
];

export function demoMission(nowIso: string): { mission: Mission; zones: MissionZone[]; waypoints: Waypoint[] } {
  return {
    mission: {
      id: DEMO_MISSION_ID,
      boat_id: BOAT_ID,
      name: 'Survey patrol (demo, repeats)',
      created_by: 'planner',
      solver: 'mock',
      energy_budget: 14,
      energy_planned: 14,
      status: 'running',
      approved_by: 'operator@aquaq.demo',
      approved_at: nowIso,
      created_at: nowIso,
    },
    zones: DEMO_PLAN.map((z) => ({
      mission_id: DEMO_MISSION_ID,
      zone_id: z.zone_id,
      level: z.level,
      risk_R: z.R,
      trust_T: z.T,
      energy: z.energy,
      reason: z.reason,
    })),
    waypoints: ROUTE.map(([x, y, action], i) => {
      const [lat, lon] = loc(x, y);
      return { mission_id: DEMO_MISSION_ID, seq: i + 1, lat, lon, action, status: 'pending' as const };
    }),
  };
}

// ---------------------------------------------------------------- water chemistry model

/** Clean-water baseline for each parameter. */
export const BASELINE: Record<string, number> = {
  ph: 7.4, do: 7.0, temperature: 28, turbidity: 2.5, conductivity: 250, tds: 170, hardness: 180,
  chlorine: 0.8, sulfate: 120, organic_carbon: 2.2, trihalomethanes: 35, orp: 220,
};
/** Change at pollution level 1.0. */
export const POLLUTION_DELTA: Record<string, number> = {
  ph: 0.9, do: -3.6, temperature: 1.5, turbidity: 7, conductivity: 380, tds: 320, hardness: 150,
  chlorine: 0.6, sulfate: 150, organic_carbon: 3.2, trihalomethanes: 42, orp: -150,
};
/** Relative noise (σ as a fraction of the baseline). */
const NOISE: Record<string, number> = {
  ph: 0.01, do: 0.04, temperature: 0.01, turbidity: 0.08, conductivity: 0.04, tds: 0.04, hardness: 0.04,
  chlorine: 0.06, sulfate: 0.04, organic_carbon: 0.06, trihalomethanes: 0.05, orp: 0.03,
};

export function modelValue(key: string, pollution: number, rng: () => number, extra = 0): number {
  const v = BASELINE[key] + POLLUTION_DELTA[key] * pollution + extra + gaussian(rng) * NOISE[key] * BASELINE[key];
  return round(Math.max(0, v), key === 'ph' || key === 'do' ? 2 : 1);
}

/** Pollution level (0–1) used to drive the "true" water chemistry of each zone right now. */
export const LIVE_POLLUTION: Record<string, number> = { A: 0.9, B: 0.25, C: 0.3, D: 0.1 };

// ---------------------------------------------------------------- history

/** Seeded R/T per zone for the 6 past surveys, oldest first. */
export const HISTORY: Record<string, { R: number[]; T: number[]; pollution: number[] }> = {
  // Zone A worsens steadily.
  A: { R: [0.45, 0.55, 0.62, 0.7, 0.8, 0.9], T: [0.86, 0.88, 0.87, 0.9, 0.89, 0.9], pollution: [0.45, 0.55, 0.62, 0.7, 0.8, 0.9] },
  // Zone B: survey 3 is a false alarm from a drifting DO probe (low trust); the latest is a fresh low-trust anomaly.
  B: { R: [0.3, 0.32, 0.72, 0.33, 0.34, 0.8], T: [0.84, 0.85, 0.25, 0.86, 0.85, 0.3], pollution: [0.28, 0.3, 0.3, 0.3, 0.3, 0.3] },
  // Zone C improves after upstream controls.
  C: { R: [0.75, 0.66, 0.56, 0.46, 0.38, 0.3], T: [0.82, 0.8, 0.81, 0.8, 0.79, 0.8], pollution: [0.75, 0.66, 0.56, 0.46, 0.38, 0.3] },
  D: { R: [0.14, 0.12, 0.11, 0.12, 0.1, 0.1], T: [0.9, 0.9, 0.91, 0.9, 0.9, 0.9], pollution: [0.14, 0.12, 0.11, 0.12, 0.1, 0.1] },
};
/** Surveys where the boat DO probe was drifting while sampling zone B. */
const DRIFT_SURVEYS_ZONE_B = new Set([2, 5]);

export interface DemoHistory {
  surveys: Survey[];
  zoneScores: ZoneScore[];
  readings: Reading[];
}

function randomPointIn(poly: Polygon, rng: () => number): LatLon {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const [la, lo] of poly) {
    minLat = Math.min(minLat, la); maxLat = Math.max(maxLat, la);
    minLon = Math.min(minLon, lo); maxLon = Math.max(maxLon, lo);
  }
  for (let i = 0; i < 200; i++) {
    const p: LatLon = [minLat + rng() * (maxLat - minLat), minLon + rng() * (maxLon - minLon)];
    if (pointInPolygon(p, poly)) return p;
  }
  return poly[0];
}

export function surveyStartTimes(now: number, intervalDays = 15): number[] {
  // Latest survey 5 days ago at 09:00 IST, earlier ones every `intervalDays` days.
  const ist = 5.5 * 3_600_000;
  const day0 = Math.floor((now + ist) / DAY) * DAY - ist; // IST midnight today
  const latest = day0 - 5 * DAY + 9 * 3_600_000;
  return Array.from({ length: 6 }, (_, i) => latest - (5 - i) * intervalDays * DAY);
}

export function generateHistory(now: number, seed = 42): DemoHistory {
  const rng = mulberry32(seed);
  const params = demoParameters();
  const zones = demoZones();
  const starts = surveyStartTimes(now);
  const surveys: Survey[] = [];
  const zoneScores: ZoneScore[] = [];
  const readings: Reading[] = [];
  let rid = 0;

  starts.forEach((start, si) => {
    const surveyId = `SV-${String(si + 1).padStart(3, '0')}`;
    surveys.push({
      id: surveyId,
      water_body_id: WATER_BODY_ID,
      type: 'scheduled',
      started_at: new Date(start).toISOString(),
      ended_at: new Date(start + 2.5 * 3_600_000).toISOString(),
      status: 'completed',
      mission_id: null,
    });
    zones.forEach((zone, zi) => {
      const h = HISTORY[zone.id];
      const R = h.R[si];
      const T = h.T[si];
      const drift = zone.id === 'B' && DRIFT_SURVEYS_ZONE_B.has(si);
      const sums: Record<string, { s: number; n: number }> = {};
      const nPoints = 12;
      for (let k = 0; k < nPoints; k++) {
        const [lat, lon] = randomPointIn(zone.polygon, rng);
        const ts = new Date(start + (zi * 35 + k * 2.5) * 60_000).toISOString();
        const keys = k % 3 === 0 ? [...BOAT_PROBES, ...LAB_PARAMS] : [...BOAT_PROBES];
        for (const key of keys) {
          // A drifting DO probe reads ~2.6 mg/L low.
          const bias = drift && key === 'do' ? -2.6 : 0;
          const value = modelValue(key, h.pollution[si], rng, bias);
          const p = params.find((x) => x.key === key)!;
          const anomalous = limitStatus(value, p) === 'out';
          const t = anomalous ? clamp01(T + gaussian(rng) * 0.04) : null;
          readings.push({
            id: `R${++rid}`,
            source_type: (LAB_PARAMS as readonly string[]).includes(key) ? 'lab' : 'boat',
            source_id: (LAB_PARAMS as readonly string[]).includes(key) ? 'LAB' : BOAT_ID,
            ts,
            lat,
            lon,
            zone_id: zone.id,
            parameter_key: key,
            value,
            edge_anomaly_flag: anomalous,
            trust_T: t == null ? null : round(t, 2),
            imputed: false,
            survey_id: surveyId,
            confirmation: false,
          });
          sums[key] ??= { s: 0, n: 0 };
          sums[key].s += value;
          sums[key].n += 1;
        }
      }
      const means = Object.fromEntries(Object.entries(sums).map(([k, v]) => [k, v.s / v.n]));
      const gate = trustGate(R, T, DEFAULT_SETTINGS);
      zoneScores.push({
        id: `ZS-${surveyId}-${zone.id}`,
        survey_id: surveyId,
        zone_id: zone.id,
        risk_R: R,
        trust_T: T,
        risk_tier: riskTier(R, DEFAULT_SETTINGS.tier_cutoffs),
        top_drivers: computeDrivers(means, params),
        trust_gate: gate.gate,
        trust_gate_reason: gate.reason,
        computed_at: new Date(start + 3 * 3_600_000).toISOString(),
      });
    });
  });

  return { surveys, zoneScores, readings };
}

/** Linear interpolation of a zone's pollution level between survey dates (for station history). */
export function pollutionAt(zoneId: string, t: number, now: number): number {
  const starts = surveyStartTimes(now);
  const p = HISTORY[zoneId].pollution;
  if (t <= starts[0]) return p[0];
  for (let i = 1; i < starts.length; i++) {
    if (t <= starts[i]) {
      const f = (t - starts[i - 1]) / (starts[i] - starts[i - 1]);
      return p[i - 1] + f * (p[i] - p[i - 1]);
    }
  }
  const f = Math.min(1, (t - starts[starts.length - 1]) / (5 * DAY));
  return p[p.length - 1] + f * (LIVE_POLLUTION[zoneId] - p[p.length - 1]);
}

/** Diurnal adjustment: warmer afternoons, DO peaks mid-afternoon from photosynthesis. */
export function diurnal(key: string, t: number): number {
  const istHour = ((t / 3_600_000 + 5.5) % 24 + 24) % 24;
  const c = Math.cos(((istHour - 15) / 24) * 2 * Math.PI);
  if (key === 'temperature') return 1.8 * c;
  if (key === 'do') return 0.6 * c;
  return 0;
}

/** Hourly fixed-station readings for the last `days` days. */
export function generateStationHistory(now: number, days = 90, seed = 7): Reading[] {
  const rng = mulberry32(seed);
  const stations = demoStations(new Date(now).toISOString());
  const out: Reading[] = [];
  let rid = 0;
  const start = now - days * DAY;
  for (const st of stations) {
    for (let t = Math.ceil(start / 3_600_000) * 3_600_000; t <= now; t += 3_600_000) {
      const pol = pollutionAt(st.zone_id, t, now);
      for (const key of STATION_PROBES) {
        // S2's turbidity sensor is fouling: slow upward creep over the last 18 days.
        const fouling = st.id === 'S2' && key === 'turbidity' ? Math.max(0, (t - (now - 18 * DAY)) / DAY) * 0.08 : 0;
        const value = modelValue(key, pol, rng, diurnal(key, t) + fouling);
        out.push({
          id: `H${st.id}-${++rid}`,
          source_type: 'station',
          source_id: st.id,
          ts: new Date(t).toISOString(),
          lat: st.position[0],
          lon: st.position[1],
          zone_id: st.zone_id,
          parameter_key: key,
          value,
          edge_anomaly_flag: false,
          trust_T: null,
          imputed: false,
          survey_id: null,
          confirmation: false,
        });
      }
    }
  }
  return out;
}

export const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
