import { describe, expect, it } from 'vitest';
import { EventTracker } from '../../src/services/ingest/eventTracker.js';
import { defaultSettings } from '../../src/core/settings.js';
import type { CanonEvent } from '../../src/services/matching/matcher.js';
import type { GameState, RawEvent } from '../../src/core/types.js';

const canon: CanonEvent = { id: 1, sport: 'hockey', competition: 'NL', homeId: 1, awayId: 2, home: 'Lugano', away: 'Kings', startTime: 0, isSim: false, linkedBooks: new Set() };
const raw = (live: boolean, state?: GameState): RawEvent => ({
  sourceId: 's', sport: 'hockey', competition: 'NL', home: 'Lugano', away: 'Kings', startTime: 0, live, state,
  markets: [{ key: '1X2|REG', open: true, selections: [{ key: 'HOME', odds: 2 }] }],
});

describe('EventTracker', () => {
  it('prematch hlášení téže sázkovky nepřepíše čerstvý live stav', () => {
    const t = new EventTracker(() => defaultSettings());
    t.report(canon, 'synot', raw(true, { statusText: '3. třetina', period: 3, score: [2, 1] }), false, 1000);
    t.report(canon, 'synot', raw(false), false, 2000);
    expect(t.get(1)!.mode).toBe('LIVE');
    expect(t.liveDemand('synot', 2000)).toBe('LIVE');
  });

  it('jediná sázkovka s "finished" zápas neukončí, když ho ostatní hlásí jako běžící', () => {
    const t = new EventTracker(() => defaultSettings());
    t.report(canon, 'fortuna', raw(true, { statusText: '3. třetina', period: 3 }), false, 1000);
    t.report(canon, 'kingsbet', raw(true, { statusText: '3. třetina', period: 3 }), false, 1000);
    t.report(canon, 'synot', raw(true, { statusText: 'Ukončeno', finished: true }), false, 1000);
    expect(t.get(1)!.finished).toBe(false);
    // většina hlásí konec → zápas skončil
    t.report(canon, 'fortuna', raw(true, { statusText: 'Konec', finished: true }), false, 2000);
    expect(t.get(1)!.finished).toBe(true);
  });

  it('jediná sázkovka, která zápas sleduje, ho ukončit může', () => {
    const t = new EventTracker(() => defaultSettings());
    t.report(canon, 'synot', raw(true, { statusText: 'Ukončeno', finished: true }), false, 1000);
    expect(t.get(1)!.finished).toBe(true);
  });
});
