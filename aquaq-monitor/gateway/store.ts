// Storage behind the gateway. Production uses Supabase (service role, on the gateway host only);
// tests use the in-memory store.
import type { Boat, BoatTelemetry, Command, Mission, Parameter, Reading, Sensor, Settings, Station, WaypointStatus, Zone } from '../supabase/functions/_shared/types.ts';

export type NewReading = Omit<Reading, 'id'>;

export interface GatewayContext {
  zones: Zone[];
  parameters: Parameter[];
  sensors: Sensor[];
  stations: Station[];
  settings: Settings;
}

export interface GatewayStore {
  loadContext(): Promise<GatewayContext>;
  writeTelemetry(t: BoatTelemetry, boat: Partial<Boat> & { id: string }): Promise<void>;
  writeReadings(rows: NewReading[]): Promise<void>;
  updateSensor(id: string, patch: Partial<Sensor>): Promise<void>;
  touchStation(id: string, ts: string): Promise<void>;
  /** Pending commands for these boats, oldest first. */
  pendingCommands(boatIds: string[]): Promise<Command[]>;
  updateCommand(id: string, patch: Partial<Command>): Promise<void>;
  updateMission(id: string, patch: Partial<Mission>): Promise<void>;
  updateWaypoint(missionId: string, seq: number, status: WaypointStatus): Promise<void>;
}

export class MemoryStore implements GatewayStore {
  telemetry: BoatTelemetry[] = [];
  boats = new Map<string, Partial<Boat>>();
  readings: NewReading[] = [];
  commands: Command[] = [];
  missions = new Map<string, Partial<Mission>>();
  waypoints = new Map<string, WaypointStatus>();
  sensorPatches: { id: string; patch: Partial<Sensor> }[] = [];
  stationsSeen = new Map<string, string>();

  constructor(private ctx: GatewayContext) {}
  async loadContext() {
    return this.ctx;
  }
  async writeTelemetry(t: BoatTelemetry, boat: Partial<Boat> & { id: string }) {
    this.telemetry.push(t);
    this.boats.set(boat.id, { ...(this.boats.get(boat.id) ?? {}), ...boat });
  }
  async writeReadings(rows: NewReading[]) {
    this.readings.push(...rows);
  }
  async updateSensor(id: string, patch: Partial<Sensor>) {
    this.sensorPatches.push({ id, patch });
  }
  async touchStation(id: string, ts: string) {
    this.stationsSeen.set(id, ts);
  }
  async pendingCommands(boatIds: string[]) {
    return this.commands.filter((c) => c.status === 'pending' && boatIds.includes(c.boat_id)).sort((a, b) => (a.issued_at < b.issued_at ? -1 : 1));
  }
  async updateCommand(id: string, patch: Partial<Command>) {
    this.commands = this.commands.map((c) => (c.id === id ? { ...c, ...patch } : c));
  }
  async updateMission(id: string, patch: Partial<Mission>) {
    this.missions.set(id, { ...(this.missions.get(id) ?? {}), ...patch });
  }
  async updateWaypoint(missionId: string, seq: number, status: WaypointStatus) {
    this.waypoints.set(`${missionId}|${seq}`, status);
  }
}
