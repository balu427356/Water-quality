import type { Reading } from '@shared/types.ts';
import { fmtShortDate, fmtTime } from '@/lib/time';

export const SERIES_COLORS: Record<string, string> = {
  A: '#0e7490',
  B: '#7c3aed',
  C: '#b45309',
  D: '#475569',
  S1: '#be185d',
  S2: '#15803d',
};
const FALLBACK = ['#0369a1', '#9333ea', '#c2410c', '#4d7c0f', '#be123c', '#0f766e'];
export const seriesColor = (key: string, i = 0) => SERIES_COLORS[key] ?? FALLBACK[i % FALLBACK.length];

export interface Point {
  t: number;
  v: number;
}

/** Mean of readings per time bucket. */
export function bucketMean(readings: Reading[], bucketMs: number): Point[] {
  const m = new Map<number, { s: number; n: number }>();
  for (const r of readings) {
    const t = Math.floor(new Date(r.ts).getTime() / bucketMs) * bucketMs;
    const e = m.get(t) ?? { s: 0, n: 0 };
    e.s += r.value;
    e.n += 1;
    m.set(t, e);
  }
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([t, e]) => ({ t: t + bucketMs / 2, v: Math.round((e.s / e.n) * 100) / 100 }));
}

export function timeTick(rangeMs: number) {
  return (t: number) => (rangeMs <= 2 * 86_400_000 ? fmtTime(t).slice(0, 5) : fmtShortDate(t));
}

export function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}
