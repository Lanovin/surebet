import { describe, expect, it } from 'vitest';
import { BookStore } from '../../src/services/ingest/bookStore.js';
import type { RawEvent } from '../../src/core/types.js';

const raw = (odds: number, extra: Partial<RawEvent> = {}): RawEvent => ({
  sourceId: 's1', sport: 'tennis', competition: 'ATP', home: 'A', away: 'B', startTime: 1, live: false,
  markets: [
    { key: 'ML|MATCH', open: true, selections: [{ key: 'HOME', odds }, { key: 'AWAY', odds: 2 }] },
    { key: 'AH|MATCH|-2.5', open: true, selections: [{ key: 'HOME', odds: 1.9 }, { key: 'AWAY', odds: 1.9 }] },
  ],
  ...extra,
});

describe('BookStore diff', () => {
  it('emits only changes and removals', () => {
    const s = new BookStore();
    const a = s.apply('betx', 'prematch', 1000, [{ eventId: 7, swapped: false, raw: raw(1.8) }]);
    expect(a.changes).toHaveLength(4);
    const b = s.apply('betx', 'prematch', 2000, [{ eventId: 7, swapped: false, raw: raw(1.8) }]);
    expect(b.changes).toHaveLength(0);
    expect(b.seen).toEqual([7]);
    const c = s.apply('betx', 'prematch', 3000, [{ eventId: 7, swapped: false, raw: raw(1.75) }]);
    expect(c.changes).toEqual([{ eventId: 7, market: 'ML|MATCH', sel: 'HOME', odds: 1.75, prev: 1.8, status: 'open' }]);
    const d = s.apply('betx', 'prematch', 4000, []);
    expect(d.removed).toEqual([7]);
    expect(d.changes.every((x) => x.status === 'removed')).toBe(true);
  });

  it('converts swapped bookmaker orientation into canonical orientation', () => {
    const s = new BookStore();
    s.apply('betx', 'prematch', 1000, [{ eventId: 7, swapped: true, raw: raw(1.8) }]);
    const st = s.get('betx').get(7)!;
    expect(st.markets['ML|MATCH'].sels.AWAY!.odds).toBe(1.8); // HOME u sázkovky = AWAY kanonicky
    expect(st.markets['AH|MATCH|2.5']).toBeDefined(); // handicap mění znaménko
  });
});
