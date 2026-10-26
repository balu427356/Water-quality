import { describe, expect, it } from 'vitest';
import { demoParameters } from './demoLake.ts';
import { computeDrivers, limitRatio, limitStatus, riskTier, trendOf, trustGate } from './limits.ts';
import { DEFAULT_SETTINGS } from './types.ts';

const P = Object.fromEntries(demoParameters().map((p) => [p.key, p]));

describe('limitStatus', () => {
  it('handles max limits with a 10% near band', () => {
    expect(limitStatus(4, P.turbidity)).toBe('ok');
    expect(limitStatus(4.5, P.turbidity)).toBe('near');
    expect(limitStatus(5, P.turbidity)).toBe('near');
    expect(limitStatus(5.1, P.turbidity)).toBe('out');
  });
  it('handles min limits', () => {
    expect(limitStatus(7, P.do)).toBe('ok');
    expect(limitStatus(5.4, P.do)).toBe('near');
    expect(limitStatus(4.9, P.do)).toBe('out');
  });
  it('handles range limits using 10% of the range width', () => {
    expect(limitStatus(7.5, P.ph)).toBe('ok');
    expect(limitStatus(8.35, P.ph)).toBe('near');
    expect(limitStatus(6.6, P.ph)).toBe('near');
    expect(limitStatus(8.6, P.ph)).toBe('out');
    expect(limitStatus(6.4, P.ph)).toBe('out');
  });
  it('returns none for trend-only parameters', () => {
    expect(limitStatus(30, P.temperature)).toBe('none');
    expect(limitRatio(30, P.temperature)).toBeNull();
  });
});

describe('limitRatio', () => {
  it('is 1 at the limit and 2 at twice the limit', () => {
    expect(limitRatio(5, P.turbidity)).toBe(1);
    expect(limitRatio(10, P.turbidity)).toBe(2);
    expect(limitRatio(2.5, P.do)).toBe(2);
    expect(limitRatio(8.5, P.ph)).toBe(1);
    expect(limitRatio(7.5, P.ph)).toBe(0);
  });
});

describe('riskTier and trustGate', () => {
  const c = DEFAULT_SETTINGS.tier_cutoffs;
  it('maps the demo lake R values to the expected tiers', () => {
    expect(riskTier(0.9, c)).toBe('Critical');
    expect(riskTier(0.8, c)).toBe('Critical');
    expect(riskTier(0.3, c)).toBe('Medium');
    expect(riskTier(0.1, c)).toBe('Low');
  });
  it('sends low trust to lab review', () => {
    const g = trustGate(0.8, 0.3, DEFAULT_SETTINGS);
    expect(g.gate).toBe('lab_review');
    expect(g.reason).toMatch(/Low agreement/);
  });
  it('sends borderline R to lab review', () => {
    const g = trustGate(0.51, 0.9, DEFAULT_SETTINGS);
    expect(g.gate).toBe('lab_review');
    expect(g.reason).toMatch(/Borderline/);
  });
  it('auto-accepts trusted, clear scores', () => {
    expect(trustGate(0.9, 0.9, DEFAULT_SETTINGS).gate).toBe('auto_accept');
  });
});

describe('computeDrivers', () => {
  it('ranks parameters closer to their limit as stronger unsafe drivers', () => {
    const d = computeDrivers({ turbidity: 9, do: 7, ph: 7.5, temperature: 28 }, demoParameters());
    expect(d[0].parameter_key).toBe('turbidity');
    expect(d[0].contribution).toBeGreaterThan(0);
    expect(d.find((x) => x.parameter_key === 'temperature')).toBeUndefined();
    expect(d[d.length - 1].contribution).toBeLessThan(0);
  });
});

describe('trendOf', () => {
  it('uses a 0.05 tolerance', () => {
    expect(trendOf(0.9, 0.8)).toBe('worsening');
    expect(trendOf(0.3, 0.38)).toBe('improving');
    expect(trendOf(0.1, 0.12)).toBe('stable');
    expect(trendOf(0.5, undefined)).toBe('stable');
  });
});
