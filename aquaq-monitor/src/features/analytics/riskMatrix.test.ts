import { describe, expect, it } from 'vitest';
import { probabilityLevel, severityLevel } from './riskMatrix';

describe('risk matrix levels', () => {
  it('maps probability to 1–5', () => {
    expect(probabilityLevel(0)).toBe(1);
    expect(probabilityLevel(0.3)).toBe(2);
    expect(probabilityLevel(0.9)).toBe(5);
  });
  it('maps severity ratios to 1–5', () => {
    expect(severityLevel(0.2)).toBe(1);
    expect(severityLevel(0.95)).toBe(3);
    expect(severityLevel(2)).toBe(5);
  });
});
