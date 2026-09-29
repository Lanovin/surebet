import { describe, expect, it } from 'vitest';
import { marketKey, parseMarketKey, swapMarketKey, isValidMarketKey } from '../../src/core/markets.js';
import { validateRawOdds } from '../../src/core/validate.js';

describe('market keys', () => {
  it('builds and parses keys', () => {
    expect(marketKey('OU', 'REG', 2.5)).toBe('OU|REG|2.5');
    expect(marketKey('OU', 'REG', 2.50000001)).toBe('OU|REG|2.5');
    expect(marketKey('1X2', 'REG')).toBe('1X2|REG');
    expect(parseMarketKey('AH|MATCH|-4.5')).toEqual({ type: 'AH', scope: 'MATCH', line: -4.5 });
    expect(() => marketKey('OU', 'REG')).toThrow();
    expect(isValidMarketKey('1X2|REG|1')).toBe(false);
    expect(isValidMarketKey('XX|REG')).toBe(false);
  });
  it('swaps orientation', () => {
    expect(swapMarketKey('AH|REG|-1.5')).toBe('AH|REG|1.5');
    expect(swapMarketKey('OU_HOME|REG|1.5')).toBe('OU_AWAY|REG|1.5');
    expect(swapMarketKey('OU|REG|2.5')).toBe('OU|REG|2.5');
  });
});

describe('validateRawOdds', () => {
  const base = {
    bookmaker: 'tipsport',
    strategy: 'test',
    scope: 'prematch',
    fetchedAt: Date.now(),
    events: [
      {
        sourceId: '1', sport: 'football', competition: 'Liga', home: 'A', away: 'B', startTime: Date.now() + 3600e3, live: false,
        markets: [
          { key: '1X2|REG', open: true, selections: [{ key: 'HOME', odds: 2.1 }, { key: 'DRAW', odds: 3.3 }, { key: 'AWAY', odds: 3.5 }] },
          { key: 'OU|REG|2.5', open: true, selections: [{ key: 'OVER', odds: 0.5 }, { key: 'UNDER', odds: 1.8 }, { key: 'HOME', odds: 2 }] },
        ],
      },
    ],
  };
  it('drops out-of-range and foreign selections', () => {
    const v = validateRawOdds(base, { minEvents: 1, maxAgeMs: 60_000, maxDroppedRatio: 0.5 });
    expect(v.ok).toBe(true);
    expect(v.data!.events[0].markets[1].selections).toEqual([{ key: 'UNDER', odds: 1.8 }]);
    expect(v.stats.droppedOdds).toBe(2);
  });
  it('fails on stale data and too few events', () => {
    const v = validateRawOdds({ ...base, fetchedAt: Date.now() - 600_000 }, { minEvents: 2, maxAgeMs: 60_000 });
    expect(v.ok).toBe(false);
    expect(v.errors.length).toBe(3);
  });
  it('rejects invalid market keys via schema', () => {
    const bad = structuredClone(base);
    bad.events[0].markets[0].key = 'Zápas';
    expect(validateRawOdds(bad, { minEvents: 1, maxAgeMs: 60_000 }).ok).toBe(false);
  });
});
