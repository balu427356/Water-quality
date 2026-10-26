// Provisional trust for anomalous readings as they arrive (before survey scoring).
// Same rule the simulator applies: a reading from a probe whose edge health is not "ok"
// (drift or fouling suspected, failed) gets low trust; otherwise high trust.
import type { SensorHealth } from './types.ts';

export const TRUSTED_EDGE_T = 0.88;
export const SUSPECT_EDGE_T = 0.3;

export function provisionalTrust(health: SensorHealth | undefined): number {
  return health && health !== 'ok' ? SUSPECT_EDGE_T : TRUSTED_EDGE_T;
}
