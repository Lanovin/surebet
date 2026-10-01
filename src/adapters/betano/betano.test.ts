import { describe, expect, it } from 'vitest';
import type { AdapterContext } from '../types.js';
import { createLogger } from '../../infra/logger.js';
import { validateRawOdds } from '../../core/validate.js';
import factory from './index.js';
import { parseBetano } from './parse.js';

describe('betano adapter', () => {
  it('uses the camoufox strategy', () => {
    const ctx = { bookmaker: 'betano', log: createLogger('test') } as unknown as AdapterContext;
    expect(factory(ctx).strategies.map((s) => [s.name, s.level])).toEqual([['camoufox', 5]]);
  });
});

describe('betano parse', () => {
  const ctx = { scope: 'prematch' as const, origin: 'https://www.betano.cz', sport: 'football' as const };
  // předpokládaný tvar Kaizen API (participants + markets[].selections[name, price]) – po prvním běhu
  // nahradit nahranou fixture (try-adapter betano prematch --save)
  const payload = {
    data: {
      blocks: [
        {
          events: [
            {
              id: '77001',
              sportId: 'FOOT',
              leagueName: 'Chance Liga',
              regionName: 'Česko',
              startTime: 1791100000000,
              url: '/zapas/sparta-slavia/77001/',
              participants: [{ name: 'Sparta Praha' }, { name: 'Slavia Praha' }],
              markets: [
                { id: 'm1', name: 'Výsledek zápasu', selections: [{ name: '1', price: 2.5 }, { name: 'X', price: 3.3 }, { name: '2', price: 2.75 }] },
                { id: 'm2', name: 'Dvojitá šance', selections: [{ name: '1X', price: 1.42 }, { name: '12', price: 1.3 }, { name: 'X2', price: 1.5 }] },
                { id: 'm3', name: '1. poločas - výsledek', selections: [{ name: '1', price: 3.1 }, { name: 'X', price: 2.1 }, { name: '2', price: 3.6 }] },
                { id: 'm4', name: 'Počet gólů', selections: [{ name: 'Více než 2.5', price: 1.8 }, { name: 'Méně než 2.5', price: 2.0 }] },
              ],
            },
            {
              id: '77002',
              sportId: 'ICEH',
              leagueName: 'Extraliga',
              startTime: 1791100000000,
              participants: [{ name: 'Sparta' }, { name: 'Třinec' }],
              markets: [{ name: 'Vítěz zápasu (vč. prodl.)', selections: [{ name: '1', price: 1.7 }, { name: '2', price: 2.1 }] }],
            },
          ],
        },
      ],
    },
  };

  it('maps 1X2 and DC, skips half-time, totals and 2-way hockey', () => {
    const ev = parseBetano(payload, ctx);
    expect(ev.map((e) => e.sourceId)).toEqual(['77001']);
    expect(ev[0]).toMatchObject({ sport: 'football', home: 'Sparta Praha', away: 'Slavia Praha', country: 'Česko', url: 'https://www.betano.cz/zapas/sparta-slavia/77001/' });
    expect(ev[0].markets.map((m) => m.key)).toEqual(['1X2|REG', 'DC|REG']);
    const v = validateRawOdds({ bookmaker: 'betano', strategy: 'camoufox', scope: 'prematch', fetchedAt: Date.now(), events: ev }, { minEvents: 1, maxAgeMs: 60_000 });
    expect(v.errors).toEqual([]);
  });
});