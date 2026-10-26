import type {
  Alert,
  AlertRule,
  AuditEntry,
  Boat,
  BoatTelemetry,
  Mission,
  MissionZone,
  Parameter,
  Profile,
  Reading,
  Sensor,
  Settings,
  SourceType,
  Station,
  Survey,
  WaterBody,
  Waypoint,
  Zone,
  ZoneScore,
} from '@shared/types.ts';
import type { SimInjections, SimPhase } from '@shared/simCore.ts';

/** Everything the UI renders live. Small tables are kept fully in memory. */
export interface Snapshot {
  ready: boolean;
  waterBody: WaterBody | null;
  zones: Zone[];
  parameters: Parameter[];
  boats: Boat[];
  stations: Station[];
  sensors: Sensor[];
  surveys: Survey[]; // oldest first
  zoneScores: ZoneScore[];
  missions: Mission[];
  missionZones: MissionZone[];
  waypoints: Waypoint[];
  settings: Settings;
  /** Boat positions over the last 30 minutes, oldest first. */
  boatTrail: BoatTelemetry[];
  /** Live readings (boat + stations) from the last 30 minutes, oldest first. */
  recentReadings: Reading[];
  /** Latest reading per source and parameter. */
  latestBySource: Record<string, Record<string, Reading>>;
  /** Alerts, newest activity first. Resolved alerts older than 7 days are not loaded. */
  alerts: Alert[];
  alertRules: AlertRule[];
  /** Users, for showing who acknowledged or resolved an alert. */
  profiles: Profile[];
  /** Simulator state, when a simulator is running. */
  sim: { phase: SimPhase; phase_reason: string | null; injections: SimInjections; speed_factor: number } | null;
}

export interface ReadingQuery {
  zoneIds?: string[];
  parameterKeys?: string[];
  sourceTypes?: SourceType[];
  sourceIds?: string[];
  surveyIds?: string[];
  from?: string;
  to?: string;
  maxTrust?: number;
  limit?: number;
}

export type SimAction =
  | { action: 'inject_drift'; parameter_key: string }
  | { action: 'inject_plume'; zone_id: string }
  | { action: 'drop_link' }
  | { action: 'drain_battery' }
  | { action: 'clear_injections' }
  | { action: 'set_speed'; speed_factor: number }
  | { action: 'reset' };

export interface DataSource {
  readonly kind: 'demo' | 'supabase';
  init(): Promise<void>;
  getSnapshot(): Snapshot;
  subscribe(listener: () => void): () => void;

  getSession(): Promise<Profile | null>;
  signIn(email: string, password: string): Promise<Profile>;
  signOut(): Promise<void>;

  queryReadings(q: ReadingQuery): Promise<Reading[]>;
  updateParameter(user: Profile, id: string, patch: Partial<Parameter>): Promise<void>;
  updateSettings(user: Profile, patch: Partial<Settings>): Promise<void>;
  simControl(user: Profile, a: SimAction): Promise<void>;
  listAudit(limit?: number): Promise<AuditEntry[]>;

  acknowledgeAlert(user: Profile, id: string): Promise<void>;
  resolveAlert(user: Profile, id: string, note: string): Promise<void>;
  updateAlertRule(user: Profile, id: string, patch: Partial<AlertRule>): Promise<void>;
  /** Store or remove this device's web-push subscription for the user. */
  savePushSubscription(user: Profile, sub: PushSubscriptionJSON, enabled: boolean): Promise<void>;
}

export const TRAIL_WINDOW_MS = 30 * 60_000;

export function emptySnapshot(settings: Settings): Snapshot {
  return {
    ready: false,
    waterBody: null,
    zones: [],
    parameters: [],
    boats: [],
    stations: [],
    sensors: [],
    surveys: [],
    zoneScores: [],
    missions: [],
    missionZones: [],
    waypoints: [],
    settings,
    boatTrail: [],
    recentReadings: [],
    latestBySource: {},
    alerts: [],
    alertRules: [],
    profiles: [],
    sim: null,
  };
}

export function matchesQuery(r: Reading, q: ReadingQuery): boolean {
  if (q.zoneIds && (!r.zone_id || !q.zoneIds.includes(r.zone_id))) return false;
  if (q.parameterKeys && !q.parameterKeys.includes(r.parameter_key)) return false;
  if (q.sourceTypes && !q.sourceTypes.includes(r.source_type)) return false;
  if (q.sourceIds && !q.sourceIds.includes(r.source_id)) return false;
  if (q.surveyIds && (!r.survey_id || !q.surveyIds.includes(r.survey_id))) return false;
  if (q.from && r.ts < q.from) return false;
  if (q.to && r.ts > q.to) return false;
  if (q.maxTrust != null && (r.trust_T == null || r.trust_T >= q.maxTrust)) return false;
  return true;
}
