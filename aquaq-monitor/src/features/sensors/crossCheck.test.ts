import { describe, expect, it } from 'vitest';
import type { Reading, Station } from '@shared/types.ts';
import { crossCheck } from './crossCheck';

const st: Station = { id: 'S1', name: 'S1', position: [12.97, 79.15], zone_id: 'A', status: 'online', last_seen: '' };
const r = (o: Partial<Reading>): Reading => ({
  id: Math.random().toString(), source_type: 'boat', source_id: 'B1', ts: '2026-10-26T04:00:00Z', lat: 12.97, lon: 79.15, zone_id: 'A',
  parameter_key: 'do', value: 5, edge_anomaly_flag: false, trust_T: null, imputed: false, survey_id: null, confirmation: false, ...o,
});

describe('crossCheck', () => {
  it('flags differences above tolerance for boat readings near the station', () => {
    const rows = crossCheck(st, [r({ value: 4 }), r({ source_type: 'station', source_id: 'S1', value: 5 })], 20, 15);
    expect(rows).toHaveLength(1);
    expect(rows[0].diffPct).toBeCloseTo(20);
    expect(rows[0].exceeds).toBe(true);
  });
  it('ignores boat readings farther than the distance', () => {
    const rows = crossCheck(st, [r({ lat: 12.971 }), r({ source_type: 'station', source_id: 'S1' })], 20, 15);
    expect(rows).toHaveLength(0);
  });
});
