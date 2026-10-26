import type { ChecklistResult } from '@shared/commands.ts';
import type {
  Alert,
  Command,
  CommandPayload,
  CommandType,
  LatLon,
  MaintenanceTask,
  MissionKind,
  Polygon,
  SamplingLevel,
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
  /** Recent boat commands, newest first. */
  commands: Command[];
  maintenanceTasks: MaintenanceTask[];
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
  | { action: 'reset' }
  /** Demo: run the "1 day before the next survey" scheduler now instead of waiting. */
  | { action: 'propose_scheduled_now' };

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
  /** Alerts created in a time window (reports), including resolved ones older than the live list keeps. */
  listAlerts(from: string, to: string): Promise<Alert[]>;

  acknowledgeAlert(user: Profile, id: string): Promise<void>;
  resolveAlert(user: Profile, id: string, note: string): Promise<void>;
  updateAlertRule(user: Profile, id: string, patch: Partial<AlertRule>): Promise<void>;
  /** Store or remove this device's web-push subscription for the user. */
  savePushSubscription(user: Profile, sub: PushSubscriptionJSON, enabled: boolean): Promise<void>;

  // ---- missions and boat control (Phase 3)
  /** Ask the planner for a plan; it is stored as a proposed mission and never sent automatically. */
  planMission(user: Profile, input: { kind: MissionKind; energy_budget: number; source_alert_id?: string | null }): Promise<string>;
  setMissionZoneLevel(user: Profile, missionId: string, zoneId: string, level: SamplingLevel): Promise<void>;
  /** Approve a proposed plan and send it to the boat (LOAD_MISSION). */
  approveMission(user: Profile, missionId: string): Promise<void>;
  discardMission(user: Profile, missionId: string): Promise<void>;
  /** Validated on the server side; throws with the reason if rejected. */
  issueCommand(user: Profile, type: CommandType, payload?: CommandPayload): Promise<Command>;

  createMaintenanceTask(user: Profile, t: { sensor_id: string; title: string; notes: string; assigned_to: string | null }): Promise<void>;
  closeMaintenanceTask(user: Profile, id: string, calibrated: boolean): Promise<void>;
  updateWaterBody(user: Profile, patch: { geofence?: Polygon; home_point?: LatLon; boundary?: Polygon }): Promise<void>;
  updateZonePolygon(user: Profile, zoneId: string, polygon: Polygon): Promise<void>;
}

/** Error thrown when START_MISSION is rejected because the checklist failed. */
export type CommandError = Error & { checklist?: ChecklistResult };

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
    commands: [],
    maintenanceTasks: [],
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
