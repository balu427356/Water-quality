import { describe, expect, it } from 'vitest';
import { toCsv } from './csv';

describe('toCsv', () => {
  it('escapes commas, quotes and newlines and unions headers', () => {
    expect(toCsv([{ a: 1, b: 'x,y' }, { a: 'he said "hi"', c: true }])).toBe('a,b,c\n1,"x,y",\n"he said ""hi""",,true');
  });
  it('returns an empty string for no rows', () => {
    expect(toCsv([])).toBe('');
  });
});
