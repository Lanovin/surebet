import { describe, expect, it } from 'vitest';
import { buildSegmentModel, kaplanMeier, lifetimeQuantile, predict, summarize, survivalAt } from '../../src/core/survival.js';

describe('Kaplan-Meier', () => {
  it('matches textbook example', () => {
    // časy 1,2,2(c),3,4(c),5 ; S(1)=5/6, S(2)=5/6*4/5=4/6, S(3)=4/6*2/3=0.444, S(5)=0
    const c = kaplanMeier([
      { durationMs: 1, event: true },
      { durationMs: 2, event: true },
      { durationMs: 2, event: false },
      { durationMs: 3, event: true },
      { durationMs: 4, event: false },
      { durationMs: 5, event: true },
    ]);
    expect(survivalAt(c, 0)).toBe(1);
    expect(survivalAt(c, 1)).toBeCloseTo(5 / 6);
    expect(survivalAt(c, 2)).toBeCloseTo(4 / 6);
    expect(survivalAt(c, 3)).toBeCloseTo((4 / 6) * (2 / 3));
    expect(survivalAt(c, 4.5)).toBeCloseTo((4 / 6) * (2 / 3));
    expect(survivalAt(c, 5)).toBe(0);
    expect(lifetimeQuantile(c, 0.5)).toBe(3);
  });

  it('censored-only data never reaches the median', () => {
    const c = kaplanMeier([{ durationMs: 10, event: false }, { durationMs: 20, event: false }]);
    expect(summarize(c).medianMs).toBeNull();
  });

  it('falls back to parent segment below min samples', () => {
    const rows = [];
    for (let i = 0; i < 40; i++)
      rows.push({ mode: 'LIVE', sport: 'football', marketType: '1X2', pair: i < 5 ? 'a|b' : 'c|d', marginBand: '1-2', durationMs: 1000 * (i + 1), event: true });
    const m = buildSegmentModel(rows, 30);
    const p = predict(m, { mode: 'LIVE', sport: 'football', marketType: '1X2', pair: 'a|b', marginBand: '1-2' })!;
    expect(p.level).toBe(2);
    expect(p.n).toBe(40);
    const p2 = predict(m, { mode: 'LIVE', sport: 'football', marketType: '1X2', pair: 'c|d', marginBand: '1-2' })!;
    expect(p2.level).toBe(0);
    expect(p2.n).toBe(35);
  });
});
