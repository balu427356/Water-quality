import { distanceM } from '@shared/geo.ts';
import type { Reading, Station } from '@shared/types.ts';

export interface CrossCheckRow {
  parameter_key: string;
  boat: Reading;
  station: Reading;
  diffPct: number;
  exceeds: boolean;
}

/**
 * Compare the boat's most recent readings taken within `maxDistanceM` of a station with
 * the station's reading closest in time. Differences above `tolerancePct` are flagged.
 */
export function crossCheck(station: Station, readings: Reading[], maxDistanceM: number, tolerancePct: number): CrossCheckRow[] {
  const near = readings.filter((r) => r.source_type === 'boat' && distanceM([r.lat, r.lon], station.position) <= maxDistanceM);
  const stationReadings = readings.filter((r) => r.source_type === 'station' && r.source_id === station.id);
  const latestBoat = new Map<string, Reading>();
  for (const r of near) if (!latestBoat.has(r.parameter_key) || latestBoat.get(r.parameter_key)!.ts < r.ts) latestBoat.set(r.parameter_key, r);
  const rows: CrossCheckRow[] = [];
  for (const [key, b] of latestBoat) {
    const candidates = stationReadings.filter((r) => r.parameter_key === key);
    if (!candidates.length) continue;
    const bt = new Date(b.ts).getTime();
    const s = candidates.reduce((best, r) => (Math.abs(new Date(r.ts).getTime() - bt) < Math.abs(new Date(best.ts).getTime() - bt) ? r : best));
    const ref = Math.abs(s.value) || 1;
    const diffPct = (Math.abs(b.value - s.value) / ref) * 100;
    rows.push({ parameter_key: key, boat: b, station: s, diffPct, exceeds: diffPct > tolerancePct });
  }
  return rows;
}
