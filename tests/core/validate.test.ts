import { describe, expect, it } from 'vitest';
import { validateRawOdds } from '../../src/core/validate.js';
import type { RawOdds } from '../../src/core/types.js';

const raw = (markets: RawOdds['events'][number]['markets']): RawOdds => ({
  bookmaker: 'fortuna',
  strategy: 't',
  scope: 'prematch',
  fetchedAt: 1_000_000,
  events: [{ sourceId: '1', sport: 'football', competition: 'L', home: 'A', away: 'B', startTime: 2_000_000, live: false, markets }],
});

describe('validateRawOdds', () => {
  it('zahodí čtvrtinové linie (dělené sázky), celé a půlové ponechá', () => {
    const v = validateRawOdds(
      raw([
        { key: 'AH|REG|-0.25', open: true, selections: [{ key: 'HOME', odds: 1.9 }, { key: 'AWAY', odds: 1.9 }] },
        { key: 'OU|REG|2.75', open: true, selections: [{ key: 'OVER', odds: 1.9 }, { key: 'UNDER', odds: 1.9 }] },
        { key: 'AH|REG|0', open: true, selections: [{ key: 'HOME', odds: 1.9 }, { key: 'AWAY', odds: 1.9 }] },
        { key: 'OU|REG|2.5', open: true, selections: [{ key: 'OVER', odds: 1.9 }, { key: 'UNDER', odds: 1.9 }] },
      ]),
      { minEvents: 1, maxAgeMs: 60_000, now: 1_000_000 },
    );
    expect(v.ok).toBe(true);
    expect(v.data!.events[0].markets.map((m) => m.key)).toEqual(['AH|REG|0', 'OU|REG|2.5']);
    expect(v.stats.droppedMarkets).toBe(2);
    expect(v.stats.droppedOdds).toBe(0);
  });

  it('odmítne kurzy mimo rozsah a duplicitní výběry', () => {
    const v = validateRawOdds(
      raw([{ key: '1X2|REG', open: true, selections: [{ key: 'HOME', odds: 1.0 }, { key: 'DRAW', odds: 3.4 }, { key: 'DRAW', odds: 3.5 }, { key: 'AWAY', odds: 4 }] }]),
      { minEvents: 1, maxAgeMs: 60_000, now: 1_000_000, maxDroppedRatio: 1 },
    );
    expect(v.data!.events[0].markets[0].selections.map((s) => `${s.key}@${s.odds}`)).toEqual(['DRAW@3.4', 'AWAY@4']);
  });
});
