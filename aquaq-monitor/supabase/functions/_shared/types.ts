// Row types mirroring supabase/migrations/0001_schema.sql.
// Shared by the web app, the seed script and the simulator Edge Function,
// so this file (and everything in _shared/) must stay free of npm imports.

export type LatLon = [number, number]; // [lat, lon]
export type Polygon = LatLon[];

export type Role = 'admin' | 'operator' | 'viewer';
export type WaterBodyType = 'river' | 'lake';
export type BoatMode = 'IDLE' | 'AUTO' | 'MANUAL' | 'RETURNING' | 'EMERGENCY_STOP';
export type LinkType = '4G' | '5G' | 'satellite' | 'none';
export type SourceType = 'boat' | 'station' | 'lab';
export type SensorHealth = 'ok' | 'drift_suspected' | 'fouling_suspected' | 'failed';
export type LimitType = 'max' | 'min' | 'range' | 'none';
export type RiskTier = 'Low' | 'Medium' | 'High' | 'Critical';
export type TrustGate = 'auto_accept' | 'lab_review';
export type SamplingLevel = 'skip' | 'standard_25m' | 'dense_10m' | 'hotspot_5m' | 'confirm';
export type Solver = 'quantum_qaoa' | 'quantum_annealer' | 'classical_fallback' | 'mock';
export type MissionStatus = 'proposed' | 'approved' | 'sent' | 'running' | 'paused' | 'completed' | 'aborted';
export type WaypointAction = 'transit' | 'sample' | 'confirm_sample';
export type WaypointStatus = 'pending' | 'reached' | 'skipped';

export interface Profile {
  id: string;
  email: string;
  full_name: string;
  role: Role;
}

export interface WaterBody {
  id: string;
  name: string;
  type: WaterBodyType;
  boundary: Polygon;
  home_point: LatLon;
  geofence: Polygon;
}

export interface Zone {
  id: string;
  water_body_id: string;
  code: string;
  name: string;
  polygon: Polygon;
  notes: string;
}

export interface Parameter {
  id: string;
  key: string;
  name: string;
  unit: string;
  limit_type: LimitType;
  limit_low: number | null;
  limit_high: number | null;
  hazard_weight: number;
  enabled: boolean;
}

export interface Boat {
  id: string;
  name: string;
  status: 'online' | 'offline';
  battery_pct: number;
  mode: BoatMode;
  last_seen: string;
  link_type: LinkType;
  position: LatLon;
  heading_deg: number;
  speed_mps: number;
  mission_id: string | null;
  waypoint_seq: number | null;
}

export interface Station {
  id: string;
  name: string;
  position: LatLon;
  zone_id: string;
  status: 'online' | 'offline';
  last_seen: string;
}

export interface Sensor {
  id: string;
  owner_type: 'boat' | 'station';
  owner_id: string;
  parameter_key: string;
  last_calibrated_at: string;
  health: SensorHealth;
  maintenance_flag: boolean;
}

export interface Reading {
  id: string;
  source_type: SourceType;
  source_id: string;
  ts: string;
  lat: number;
  lon: number;
  zone_id: string | null;
  parameter_key: string;
  value: number;
  edge_anomaly_flag: boolean;
  trust_T: number | null;
  imputed: boolean;
  survey_id: string | null;
  /** Independent confirmation sample (taken at a confirm_sample waypoint), not the routine probe reading. */
  confirmation: boolean;
}

export interface BoatTelemetry {
  boat_id: string;
  ts: string;
  lat: number;
  lon: number;
  heading_deg: number;
  speed_mps: number;
  battery_pct: number;
  mode: BoatMode;
  link: LinkType;
  mission_id: string | null;
  waypoint_seq: number | null;
}

export interface Survey {
  id: string;
  water_body_id: string;
  type: 'scheduled' | 'unscheduled';
  started_at: string;
  ended_at: string | null;
  status: 'planned' | 'running' | 'completed' | 'aborted';
  mission_id: string | null;
}

export interface Driver {
  parameter_key: string;
  value: number;
  limit: string;
  contribution: number; // > 0 pushes toward unsafe, < 0 toward safe
}

export interface ZoneScore {
  id: string;
  survey_id: string;
  zone_id: string;
  risk_R: number;
  trust_T: number;
  risk_tier: RiskTier;
  top_drivers: Driver[];
  trust_gate: TrustGate;
  trust_gate_reason: string | null;
  computed_at: string;
}

export interface Mission {
  id: string;
  boat_id: string;
  name: string;
  created_by: 'planner' | 'operator';
  solver: Solver;
  energy_budget: number;
  energy_planned: number;
  status: MissionStatus;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
}

export interface MissionZone {
  mission_id: string;
  zone_id: string;
  level: SamplingLevel;
  risk_R: number;
  trust_T: number;
  energy: number;
  reason: string;
}

export interface Waypoint {
  mission_id: string;
  seq: number;
  lat: number;
  lon: number;
  action: WaypointAction;
  status: WaypointStatus;
}

export type AlertSeverity = 'info' | 'warning' | 'high' | 'critical';
export type AlertCategory = 'water_quality' | 'sensor' | 'boat' | 'mission' | 'system';
export type AlertStatus = 'open' | 'acknowledged' | 'resolved';
export type AlertChannel = 'in_app' | 'push' | 'email' | 'sms';

export type AlertRuleId =
  | 'limit_exceeded'
  | 'near_limit'
  | 'possible_sensor_fault'
  | 'confirmed_pollution'
  | 'fault_confirmed'
  | 'zone_tier_rose'
  | 'station_trigger'
  | 'low_battery'
  | 'link_lost'
  | 'geofence'
  | 'command_failed'
  | 'fallback_used'
  | 'calibration_due';

export interface AlertRule {
  id: AlertRuleId;
  name: string;
  enabled: boolean;
  /** Human-readable condition plus any tunable values the engine reads. */
  condition: { description: string } & Record<string, unknown>;
  /** Base severity; some rules raise it (for example to critical above 2× the limit). */
  severity: AlertSeverity;
  channels: AlertChannel[];
  cooldown_minutes: number;
}

export interface Alert {
  id: string;
  rule_id: AlertRuleId;
  /** Alerts with the same key (rule + zone + parameter/source) are merged with a count. */
  dedup_key: string;
  severity: AlertSeverity;
  category: AlertCategory;
  title: string;
  message: string;
  suggested_action: string;
  zone_id: string | null;
  source_id: string | null;
  parameter_key: string | null;
  value: number | null;
  limit_text: string | null;
  created_at: string;
  /** Time of the latest merged occurrence. */
  updated_at: string;
  status: AlertStatus;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  count: number;
  escalated_at: string | null;
  escalation_count: number;
  /** Follow-up the app should offer, e.g. proposing an early mission. */
  action: 'propose_early_mission' | null;
}

export interface AuditEntry {
  id: string;
  user_id: string;
  action: string;
  entity: string;
  entity_id: string;
  details: Record<string, unknown>;
  ts: string;
}

export interface Settings {
  trust_threshold: number;
  tier_cutoffs: { medium: number; high: number; critical: number };
  low_battery_return_pct: number;
  link_loss_timeout_s: number;
  survey_interval_days: number;
  near_limit_pct: number;
  crosscheck_distance_m: number;
  crosscheck_tolerance_pct: number;
  /** Re-send unacknowledged critical alerts to all operators and admins after this long. */
  escalation_minutes: number;
  /** Boat within this distance of the geofence edge raises a warning. */
  geofence_warning_m: number;
  calibration_due_days: number;
}

export const DEFAULT_SETTINGS: Settings = {
  trust_threshold: 0.5,
  tier_cutoffs: { medium: 0.25, high: 0.5, critical: 0.75 },
  low_battery_return_pct: 25,
  link_loss_timeout_s: 60,
  survey_interval_days: 15,
  near_limit_pct: 10,
  crosscheck_distance_m: 20,
  crosscheck_tolerance_pct: 15,
  escalation_minutes: 15,
  geofence_warning_m: 10,
  calibration_due_days: 15,
};
