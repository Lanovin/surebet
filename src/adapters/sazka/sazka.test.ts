import { describe, expect, it } from 'vitest';
import { loadFixture } from '../fixtures.js';
import { validateRawOdds } from '../../core/validate.js';
import { isValidMarketKey, parseMarketKey } from '../../core/markets.js';
import type { RawEvent, RawOdds } from '../../core/types.js';
import type { ObEvent, ObEventsResponse, ObMarket } from './parse.js';
import { mapMarket, mergeListingAndDetail, parseEvents, parseState, setComplete } from './parse.js';
import { detailUrl, listingUrl } from './api.js';
import { applyMessage, decodeMessage, encodeConnect, encodeSubscribe, pushDecimal } from './push.js';

const NOW = Date.parse('2026-09-28T21:15:30Z');
const load = async (f: string) => ((await loadFixture<ObEventsResponse>('sazka', f)).data?.events ?? []) as ObEvent[];
const odds = (events: RawEvent[], strategy: string, scope: 'prematch' | 'live'): RawOdds => ({
  bookmaker: 'sazka',
  strategy,
  scope,
  fetchedAt: NOW,
  events,
});
const mk = (e: RawEvent, key: string) => e.markets.find((m) => m.key === key);
const price = (e: RawEvent, key: string, sel: string) => mk(e, key)?.selections.find((s) => s.key === sel)?.odds;

describe('sazka prematch (openbet-api / browser-fetch: listing + detail)', async () => {
  const listing = await load('prematch-listing.json');
  const detail = await load('prematch-detail.json');
  const events = parseEvents(mergeListingAndDetail(listing, detail), { scope: 'prematch', now: NOW });

  it('parses all four sports and validates', () => {
    const bySport: Record<string, number> = {};
    for (const e of events) bySport[e.sport] = (bySport[e.sport] ?? 0) + 1;
    expect(events.length).toBeGreaterThan(60);
    expect(bySport.football).toBeGreaterThan(20);
    expect(bySport.tennis).toBeGreaterThan(15);
    expect(bySport.basketball).toBeGreaterThan(10);
    expect(bySport.hockey).toBeGreaterThan(15);
    expect(events.every((e) => !e.live && !e.state)).toBe(true);
    const v = validateRawOdds(odds(events, 'openbet-api', 'prematch'), { minEvents: 5, maxAgeMs: 60_000, now: NOW });
    expect(v.ok).toBe(true);
    expect(v.stats.markets).toBeGreaterThan(500);
  });

  it('football: Česko – Anglie with exact scopes and AH from home perspective', () => {
    const e = events.find((x) => x.sourceId === '4059993')!;
    expect(e).toBeDefined();
    expect(e.sport).toBe('football');
    expect([e.home, e.away]).toEqual(['Česko', 'Anglie']);
    expect(e.competition).toBe('Liga národů');
    expect(e.country).toBe('Evropa');
    expect(e.startTime).toBe(Date.parse('2026-09-29T18:45:00Z'));
    expect(e.url).toBe('https://www.allwyn.cz/kurzove-sazky/kurzy/11/10525/4059993');
    expect(price(e, '1X2|REG', 'HOME')).toBe(8.5);
    expect(price(e, '1X2|REG', 'DRAW')).toBe(5.25);
    expect(price(e, '1X2|REG', 'AWAY')).toBe(1.36);
    expect(price(e, 'DNB|REG', 'HOME')).toBe(6.5);
    expect(price(e, 'OU|REG|2.5', 'OVER')).toBe(1.69);
    expect(price(e, 'OU|REG|2.5', 'UNDER')).toBe(2.2);
    expect(price(e, 'BTTS|REG', 'YES')).toBe(2);
    expect(price(e, '1X2|H1', 'DRAW')).toBe(2.7);
    // "Handicap 2.5": Česko +2.5 @1.29, Anglie −2.5 @3.4
    expect(price(e, 'AH|REG|2.5', 'HOME')).toBe(1.29);
    expect(price(e, 'AH|REG|2.5', 'AWAY')).toBe(3.4);
    // asijský total 3.0 (celá linie) je povolen, čtvrtinové linie ne
    expect(mk(e, 'OU|REG|3')).toBeDefined();
    for (const m of e.markets) {
      const p = parseMarketKey(m.key);
      expect(['REG', 'H1', 'H2']).toContain(p.scope);
      if (p.line !== undefined) expect(Math.abs(p.line * 2 - Math.round(p.line * 2))).toBeLessThan(1e-9);
    }
    // "Mega kurz (3+ ako)" nesmí přepsat standardní 1X2
    expect(e.markets.filter((m) => m.key === '1X2|REG')).toHaveLength(1);
  });

  it('hockey: 60 min vs. do rozhodnutí separated', () => {
    const e = events.find((x) => x.sourceId === '3814081')!;
    expect([e.home, e.away]).toEqual(['Carolina Hurricanes', 'Florida Panthers']);
    expect(e.competition).toBe('NHL');
    expect(price(e, '1X2|REG', 'HOME')).toBe(2.25);
    expect(price(e, '1X2|REG', 'DRAW')).toBe(3.75);
    expect(price(e, 'ML|MATCH', 'HOME')).toBe(1.73);
    expect(price(e, 'ML|MATCH', 'AWAY')).toBe(2.05);
    expect(price(e, 'OU|REG|4.5', 'OVER')).toBe(1.29); // Góly pod/nad (60 minut) 4.5
    expect(price(e, 'OU|MATCH|7.5', 'OVER')).toBe(3); // Počet gólů do rozhodnutí 7.5
    expect(price(e, 'AH|REG|-0.5', 'HOME')).toBe(2.2); // Handicap (60 minut) -0.5
    expect(price(e, 'AH|MATCH|-1.5', 'HOME')).toBe(2.7); // Handicap (do rozhodnutí) -1.5
    expect(price(e, 'DNB|REG', 'HOME')).toBe(1.71);
    expect(price(e, '1X2|P1', 'DRAW')).toBe(2.6);
    expect(mk(e, 'BTTS|REG')).toBeUndefined(); // nejasný rozsah → vynecháno
    for (const m of e.markets) expect(['REG', 'MATCH', 'P1', 'P2', 'P3']).toContain(parseMarketKey(m.key).scope);
  });

  it('basketball and tennis markets', () => {
    const b = events.find((x) => x.sourceId === '4066011')!;
    expect([b.home, b.away]).toEqual(['Anadolu Efes Istanbul', 'Real Madrid']);
    expect(price(b, 'ML|MATCH', 'HOME')).toBe(1.8);
    expect(price(b, '1X2|REG', 'DRAW')).toBe(11);
    expect(price(b, 'AH|MATCH|1.5', 'HOME')).toBe(1.71); // Handicap 1.5 (včetně prodloužení)
    expect(price(b, 'AH|MATCH|1.5', 'AWAY')).toBe(2.05);
    expect(price(b, 'OU|MATCH|173.5', 'OVER')).toBe(1.95);
    expect(price(b, 'OU|H1|86.5', 'UNDER')).toBe(1.83);
    const t = events.find((x) => x.sourceId === '4254169')!;
    expect(t.sport).toBe('tennis');
    expect([t.home, t.away]).toEqual(['Hubert Hurkacz', 'Alejandro Davidovich Fokina']);
    expect(price(t, 'ML|MATCH', 'HOME')).toBe(1.67);
    expect(price(t, 'AH|MATCH|-1.5', 'HOME')).toBe(1.83); // Hry: handicap −1.5 (Hurkacz −1.5)
    expect(price(t, 'AH|MATCH|-1.5', 'AWAY')).toBe(1.87);
    expect(price(t, 'AH_SETS|MATCH|1.5', 'HOME')).toBe(1.23);
    expect(price(t, 'OU_SETS|MATCH|2.5', 'UNDER')).toBe(1.59);
    expect(price(t, 'OU|MATCH|23.5', 'OVER')).toBe(1.87);
    expect(price(t, 'ML|S1', 'HOME')).toBe(1.69);
  });

  it('all keys are canonical', () => {
    for (const e of events) for (const m of e.markets) expect(isValidMarketKey(m.key)).toBe(true);
  });
});

describe('sazka live (openbet-api: listing + detail)', async () => {
  const listing = await load('live-listing.json');
  const detail = await load('live-detail.json');
  const events = parseEvents(mergeListingAndDetail(listing.filter((e) => e.liveNow), detail), { scope: 'live', now: NOW });

  it('parses live events with game state', () => {
    expect(events.length).toBe(23);
    expect(events.filter((e) => e.sport === 'tennis')).toHaveLength(13);
    expect(events.filter((e) => e.sport === 'football')).toHaveLength(10);
    expect(events.every((e) => e.live && e.state)).toBe(true);
    const v = validateRawOdds(odds(events, 'openbet-api', 'live'), { minEvents: 1, maxAgeMs: 60_000, now: NOW });
    expect(v.ok).toBe(true);
    // prematch scope nad live listingem nevrací nic
    expect(parseEvents(listing, { scope: 'prematch', now: NOW })).toHaveLength(0);
  });

  it('football state: 2nd half running clock', () => {
    const e = events.find((x) => x.sourceId === '4245369')!;
    expect([e.home, e.away]).toEqual(['CA Tembetary', 'Paraguari AC']);
    expect(e.state).toMatchObject({ score: [2, 1], periodScores: [[2, 0], [0, 1]], period: 2, statusText: 'SECOND_HALF', clockRunning: true });
    expect(e.state!.breakFlag).toBeUndefined();
    // 2. poločas: offset 0 k lastUpdate 21:05:12 → 45' + 10:18
    expect(e.state!.clockSec).toBe(2700 + 618);
    expect(e.url).toBe('https://www.allwyn.cz/kurzove-sazky/live/4245369');
    expect(mk(e, '1X2|REG')).toBeDefined();
  });

  it('tennis state: sets, games, points', () => {
    const e = events.find((x) => x.sourceId === '4245381')!;
    expect(e.state).toMatchObject({ score: [1, 0], periodScores: [[7, 6], [5, 4]], period: 2, games: [5, 4], statusText: 'SET_2' });
    expect(e.state!.breakFlag).toBeUndefined();
    const t2 = events.find((x) => x.sourceId === '4249894')!;
    expect(t2.state!.points).toBe('15:30');
    expect(price(t2, 'ML|MATCH', 'HOME')).toBeGreaterThan(1);
  });
});

describe('sazka break detection', async () => {
  const ev = await load('live-detail-halftime.json');
  it('HALF_TIME period → breakFlag', () => {
    const e = ev.find((x) => x.id === '4245369')!; // Tembetary v poločase (20:57 UTC)
    const st = parseState(e, 'football', Date.parse('2026-09-28T20:57:30Z'))!;
    expect(st).toMatchObject({ statusText: 'HALF_TIME', breakFlag: true, clockRunning: false, period: 1, score: [2, 0] });
  });
  it('HALF_TIME stays in list after 2nd half starts – latest period wins', () => {
    const e = ev.find((x) => x.id === '4249885')!; // Tunisko – Botswana, 2. poločas
    const st = parseState(e, 'football', Date.parse('2026-09-28T20:57:30Z'))!;
    expect(st.statusText).toBe('SECOND_HALF');
    expect(st.breakFlag).toBeUndefined();
    expect(st.score).toEqual([2, 2]);
  });
  it('hockey intermission: finished period without next one', () => {
    const e: ObEvent = {
      id: '1',
      name: 'A - B',
      startTime: '2026-09-28T18:00:00Z',
      liveNow: true,
      commentary: {
        participants: [
          { id: 'h', name: 'A', roleCode: 'HOME' },
          { id: 'a', name: 'B', roleCode: 'AWAY' },
        ],
        facts: [
          { type: 'SCORE', value: '1', participantId: 'h' },
          { type: 'SCORE', value: '0', participantId: 'a' },
        ],
        periods: [{ type: 'PERIOD_1', status: 'FINISHED', startTime: '2026-09-28T18:00:00Z', clock: { offset: 0, state: 'STOPPED' } }],
      },
    };
    expect(parseState(e, 'hockey', NOW)).toMatchObject({ period: 1, breakFlag: true, clockRunning: false, score: [1, 0] });
  });
  it('clock states from feed (samples from e-sport feed, same OpenBet structure)', async () => {
    const es = await load('live-esports-clock.json');
    const at = Date.parse('2026-09-28T21:34:33Z');
    // basket: QUARTER_2 offset 114 s @21:34:23, state COUNTING_DOWN → běží, zbývá 104 s
    const bb = parseState(es.find((x) => x.id === '4252976')!, 'basketball', at)!;
    expect(bb).toMatchObject({ period: 2, statusText: 'QUARTER_2', clockRunning: true, periodRemainingSec: 104, score: [28, 30] });
    expect(bb.breakFlag).toBeUndefined();
    // fotbal: SECOND_HALF založený (STOPPED, 0) ve stejném okamžiku jako HALF_TIME → pořád poločas
    const ht = parseState(es.find((x) => x.id === '4248710')!, 'football', at)!;
    expect(ht).toMatchObject({ breakFlag: true, clockRunning: false });
    // fotbal s absolutním offsetem (3323 s ve 2. poločase) → nepřičítat 45'
    const abs = parseState(es.find((x) => x.id === '4251189')!, 'football', at)!;
    expect(abs.statusText).toBe('SECOND_HALF');
    expect(abs.clockSec).toBe(3323 + 40);
    expect(abs.breakFlag).toBeUndefined();
  });

  it('quarter break: countdown stopped at 0, next quarter not yet created', () => {
    const e: ObEvent = {
      id: '2',
      name: 'A - B',
      startTime: '2026-09-28T18:00:00Z',
      liveNow: true,
      commentary: {
        participants: [
          { id: 'h', name: 'A', roleCode: 'HOME' },
          { id: 'a', name: 'B', roleCode: 'AWAY' },
        ],
        facts: [],
        periods: [
          { type: 'QUARTER_1', startTime: '2026-09-28T18:00:00Z', clock: { offset: 0, state: 'STOPPED', lastUpdate: '2026-09-28T18:14:00Z' } },
          { type: 'QUARTER_2', startTime: '2026-09-28T18:16:00Z', clock: { offset: 0, state: 'STOPPED', lastUpdate: '2026-09-28T18:31:00Z' } },
        ],
      },
    };
    expect(parseState(e, 'basketball', NOW)).toMatchObject({ period: 2, breakFlag: true, periodRemainingSec: 0 });
    // 3. čtvrtina založená, stojí na plné délce 10:00 → ještě přestávka
    e.commentary!.periods!.push({ type: 'QUARTER_3', startTime: '2026-09-28T18:45:00Z', clock: { offset: 600, state: 'STOPPED' } });
    expect(parseState(e, 'basketball', NOW)).toMatchObject({ period: 3, breakFlag: true });
    // ... a po rozehrání (COUNTING_DOWN) už ne
    e.commentary!.periods![2].clock = { offset: 590, state: 'COUNTING_DOWN', lastUpdate: new Date(NOW).toISOString() };
    expect(parseState(e, 'basketball', NOW)!.breakFlag).toBeUndefined();
  });

  it('tennis set break by game score', () => {
    expect(setComplete([6, 4])).toBe(true);
    expect(setComplete([7, 6])).toBe(true);
    expect(setComplete([6, 5])).toBe(false);
    expect(setComplete([5, 4])).toBe(false);
  });
});

describe('sazka push (openbet-push)', async () => {
  const msgs = await loadFixture<string[]>('sazka', 'push-messages.json');
  const detail = await load('live-detail.json');

  it('encodes protocol frames', () => {
    expect(encodeConnect()).toBe('C02P0000');
    expect(encodeSubscribe(['4245369'])).toBe('S0001SEVENT================0004245369!!!!!!!!!!');
  });

  it('decodes messages and applies price updates to snapshot', () => {
    const decoded = msgs.map(decodeMessage).filter((m) => m !== null);
    expect(decoded.length).toBeGreaterThan(100);
    expect(new Set(decoded.map((m) => m!.subjectType))).toEqual(new Set(['sPRICE', 'sSELCN', 'sEVMKT', 'sCLOCK']));
    const state = new Map(detail.map((e) => [String(e.id), structuredClone(e)]));
    const first = decoded.find((m) => m!.subjectType === 'sPRICE' && state.has(String(m!.body.ev_id)))!;
    const r = applyMessage(state, first);
    expect(r.changed).toBe(true);
    const ev = state.get(String(first.body.ev_id))!;
    const o = ev.markets!.find((m) => m.id === String(first.body.ev_mkt_id))!.outcomes.find((x) => x.id === first.subjectId)!;
    expect(o.prices![0].decimal).toBe(pushDecimal(first.body));
    let changed = 0;
    for (const m of decoded) if (applyMessage(state, m!).changed) changed++;
    expect(changed).toBeGreaterThan(50);
    const events = parseEvents([...state.values()], { scope: 'live', now: NOW });
    const v = validateRawOdds(odds(events, 'openbet-push', 'live'), { minEvents: 1, maxAgeMs: 60_000, now: NOW });
    expect(v.ok).toBe(true);
  });
});

describe('sazka push clock (sCLOCK)', async () => {
  const es = await load('live-esports-clock.json');
  const clock = await loadFixture<string[]>('sazka', 'push-clock-messages.json');
  it('countdown "C" → running; end of quarter → break; new HALF_TIME period → resync', () => {
    const state = new Map([[ '4252976', structuredClone(es.find((x) => x.id === '4252976')!) ]]);
    const msgs = clock.map(decodeMessage).filter((m) => m !== null);
    const first = msgs.find((m) => m!.body.period_code === 'QUARTER_2')!;
    expect(applyMessage(state, first)).toEqual({ changed: true });
    const ev = state.get('4252976')!;
    let st = parseState(ev, 'basketball', Date.parse('2026-09-28T21:36:30Z'))!;
    expect(st).toMatchObject({ clockRunning: true, periodRemainingSec: 3 });
    const resyncs = msgs.map((m) => applyMessage(state, m!)).filter((r) => r.resync).length;
    expect(resyncs).toBeGreaterThan(0); // HALF_TIME ve snapshotu chybí → REST detail
    st = parseState(ev, 'basketball', Date.parse('2026-09-28T21:36:50Z'))!;
    expect(st).toMatchObject({ statusText: 'QUARTER_2', periodRemainingSec: 0, breakFlag: true, clockRunning: false });
  });
});

describe('sazka helpers', () => {
  it('builds URLs (live = cache-busted)', () => {
    const l = listingUrl(['football', 'tennis', 'basketball', 'hockey'], 'live');
    expect(l).toMatch(/sazkaEventsDrilldownList\?drilldownTagIds=11,12,5,8&liveNowOrSoon=true&_=\d+$/);
    expect(listingUrl(['hockey'], 'prematch')).toMatch(/drilldownTagIds=8&eventState=OPEN_EVENT$/);
    expect(listingUrl(['football'], 'prematch')).toContain('marketGroupTypesIncluded=CUSTOM_GROUP,DRAW_NO_BET');
    expect(detailUrl(['1', '2'])).toMatch(/eventIds=1,2$/);
    expect(detailUrl(['1'], true)).toMatch(/eventIds=1&_=\d+$/);
  });

  it('skips quarter lines and non-mirrored handicaps', () => {
    const m = (hl: string, ha: string): ObMarket => ({
      id: 'm',
      name: 'Handicap',
      groupCode: 'ASIAN_HANDICAP',
      status: 'ACTIVE',
      outcomes: [
        { id: '1', name: 'A', subType: 'H', status: 'ACTIVE', prices: [{ decimal: 1.9, handicapLow: hl, handicapHigh: hl }] },
        { id: '2', name: 'B', subType: 'A', status: 'ACTIVE', prices: [{ decimal: 1.9, handicapLow: ha, handicapHigh: ha }] },
      ],
    });
    expect(mapMarket('football', m('-1.5', '+1.5'), 'A', 'B')?.key).toBe('AH|REG|-1.5');
    expect(mapMarket('football', m('-1.25', '+1.25'), 'A', 'B')).toBeNull();
    expect(mapMarket('football', m('-1.5', '-1.5'), 'A', 'B')).toBeNull();
  });
});
