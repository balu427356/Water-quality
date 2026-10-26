// Supabase-backed gateway store. Runs on the gateway host with the service-role key
// (never in a browser). Writes exactly the rows the simulator Edge Function writes.
import type { SupabaseClient } from '@supabase/supabase-js';
import { DEFAULT_SETTINGS, type Boat, type BoatTelemetry, type Command, type Mission, type Sensor, type Settings, type WaypointStatus } from '../supabase/functions/_shared/types.ts';
import type { GatewayContext, GatewayStore, NewReading } from './store.ts';

export class SupabaseStore implements GatewayStore {
  constructor(private db: SupabaseClient) {}

  private async all<T>(table: string): Promise<T[]> {
    const { data, error } = await this.db.from(table).select('*');
    if (error) throw new Error(`${table}: ${error.message}`);
    return (data ?? []) as T[];
  }

  private check(what: string, r: { error: { message: string } | null }) {
    if (r.error) throw new Error(`${what}: ${r.error.message}`);
  }

  async loadContext(): Promise<GatewayContext> {
    const [zones, parameters, sensors, stations, settings] = await Promise.all([
      this.all<any>('zones'),
      this.all<any>('parameters'),
      this.all<any>('sensors'),
      this.all<any>('stations'),
      this.db.from('app_settings').select('value').eq('id', 1).maybeSingle(),
    ]);
    return { zones, parameters, sensors, stations, settings: { ...DEFAULT_SETTINGS, ...((settings.data?.value as Partial<Settings>) ?? {}) } };
  }

  async writeTelemetry(t: BoatTelemetry, boat: Partial<Boat> & { id: string }) {
    const { id, ...patch } = boat;
    this.check('boat_telemetry', await this.db.from('boat_telemetry').insert(t));
    this.check('boats', await this.db.from('boats').update(patch).eq('id', id));
  }
  async writeReadings(rows: NewReading[]) {
    this.check('readings', await this.db.from('readings').insert(rows));
  }
  async updateSensor(id: string, patch: Partial<Sensor>) {
    this.check('sensors', await this.db.from('sensors').update(patch).eq('id', id));
  }
  async touchStation(id: string, ts: string) {
    this.check('stations', await this.db.from('stations').update({ last_seen: ts, status: 'online' }).eq('id', id));
  }
  async pendingCommands(boatIds: string[]) {
    const { data, error } = await this.db.from('commands').select('*').in('boat_id', boatIds).eq('status', 'pending').order('issued_at');
    if (error) throw new Error(`commands: ${error.message}`);
    return (data ?? []) as Command[];
  }
  async updateCommand(id: string, patch: Partial<Command>) {
    this.check('commands', await this.db.from('commands').update(patch).eq('id', id));
  }
  async updateMission(id: string, patch: Partial<Mission>) {
    this.check('missions', await this.db.from('missions').update(patch).eq('id', id));
  }
  async updateWaypoint(missionId: string, seq: number, status: WaypointStatus) {
    this.check('waypoints', await this.db.from('waypoints').update({ status }).eq('mission_id', missionId).eq('seq', seq));
  }
}
