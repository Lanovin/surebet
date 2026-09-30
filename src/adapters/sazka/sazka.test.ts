import { describe, expect, it } from 'vitest';
import { loadFixture } from '../fixtures.js';
import { validateRawOdds } from '../../core/validate.js';
import { isValidMarketKey, parseMarketKey } from '../../core/markets.js';
import type { RawEvent, RawOdds } from '../../core/types.js';
import type { ObEvent, ObEventsResponse, ObMarket, ObOutcome } from './parse.js';
import { isMappedMarketCode, mapMarket, mergeListingAndDetail, parseEvent, parseEvents, parseState, setComplete } from './parse.js';
import { detailUrl, listingUrl, prematchListingGroups } from './api.js';
import type { PushMessage } from './push.js';
import { applyMessage, decodeMessage, encodeConnect, encodeSubscribe, pushDecimal } from './push.js';
import { PushState, REPLAY_MS, SazkaCore } from './strategies.js';
import type { AdapterContext } from '../types.js';

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

// ---------------------------------------------------------------------------------------------
// Audit live dat 30. 9. 2026 – regresní testy nad reálnými výřezy (fixtures/sazka/live-audit-2026-09-30.json)

interface AuditFixture {
  reopen: { event: ObEvent; messages: { t: number; s: string }[] };
  race: { event: ObEvent; messages: { t: number; s: string }[] };
  listingExtra: { listing: ObEvent; detail: ObEvent };
  tiedAfterRegulation: ObEvent;
  hockeyPeriods: ObEvent;
  basketQuarters: ObEvent;
}

describe('sazka live audit 2026-09-30', async () => {
  const fx = await loadFixture<AuditFixture>('sazka', 'live-audit-2026-09-30.json');
  const at = (iso: string) => Date.parse(iso);
  const parse1 = (e: ObEvent, now = at('2026-09-30T19:40:00Z')) => parseEvent(e, { scope: 'live', now })!;
  const msg = (subjectType: string, subjectId: string, body: Record<string, unknown>): PushMessage => ({
    channelType: 'SEVENT',
    channelId: String(body.ev_id),
    messageId: '!!!!!!!!!!',
    subjectType,
    subjectId,
    body,
  });

  it('push sEVMKT st=A reopens a market that REST delivered suspended (active=false)', () => {
    const st = new PushState();
    st.events.set('4169252', structuredClone(fx.reopen.event));
    expect(mk(parse1(st.events.get('4169252')!), '1X2|REG')!.open).toBe(false);
    for (const m of fx.reopen.messages) st.onMessage(decodeMessage(m.s)!, m.t);
    const e = parse1(st.events.get('4169252')!);
    const m = mk(e, '1X2|REG')!;
    // dřív: status ACTIVE, ale active=false zůstalo → trh navždy zavřený
    expect(m.open).toBe(true);
    expect(m.selections.every((s) => s.open !== false)).toBe(true);
    expect(price(e, '1X2|REG', 'HOME')).toBe(1.14); // 7/50 @19:27:26.901
    expect(price(e, '1X2|REG', 'DRAW')).toBe(7); // 6/1 @19:27:06.382
    expect(price(e, '1X2|REG', 'AWAY')).toBe(13); // 12/1 @19:27:26.922
  });

  /** Simulace REST refreshe: REST vznikl v `restAt`, do stavu se dostal v `installAt`. */
  const raceScenario = (restAt: number, installAt: number) => {
    const st = new PushState();
    st.events.set('4261983', structuredClone(fx.race.event));
    const live = fx.race.messages.map((m) => ({ t: m.t, m: decodeMessage(m.s)! }));
    for (const x of live) if (x.t <= restAt) st.onMessage(x.m, x.t);
    const rest = structuredClone(st.events.get('4261983')!); // stav, který vrátí REST (vznik restAt)
    for (const x of live) if (x.t > restAt && x.t <= installAt) st.onMessage(x.m, x.t);
    return { st, rest };
  };

  it('delta received while a REST refresh is in flight is not lost (hidden line 12.5, 19:37:14.589)', () => {
    const { st, rest } = raceScenario(at('2026-09-30T19:37:14.300Z'), at('2026-09-30T19:37:15.200Z'));
    // původní chování: prosté nahrazení událostí REST daty → skrytá linie zůstane "otevřená"
    const naive = parse1({ ...rest });
    expect(mk(naive, 'OU|S1|12.5')?.open).toBe(true);
    st.install([rest], at('2026-09-30T19:37:14.300Z'));
    const e = parse1(st.events.get('4261983')!);
    expect(mk(e, 'OU|S1|12.5')).toBeUndefined(); // sEVMKT st=S disp=N přehrán
    expect(mk(e, 'OU|MATCH|25.5')).toBeUndefined();
    expect(price(e, 'ML|S1', 'HOME')).toBe(2.4); // 7/5 @19:37:14.594
    expect(price(e, 'ML|S1', 'AWAY')).toBe(1.49); // 49/100 @19:37:14.607
  });

  it('price delta during REST refresh is replayed (ML|S1 19:39:14.602)', () => {
    const restAt = at('2026-09-30T19:39:14.400Z');
    const { st, rest } = raceScenario(restAt, at('2026-09-30T19:39:15.200Z'));
    expect(price(parse1({ ...rest }), 'ML|S1', 'HOME')).toBe(1.83); // REST ještě se starou cenou
    st.install([rest], restAt);
    const e = parse1(st.events.get('4261983')!);
    expect(price(e, 'ML|S1', 'HOME')).toBe(2.35); // 27/20
    expect(price(e, 'ML|S1', 'AWAY')).toBe(1.5); // 1/2
    expect(REPLAY_MS).toBeGreaterThanOrEqual(1000);
  });

  it('fresh detail is authoritative: markets missing in it are dropped, not taken from the older listing', () => {
    const merged = mergeListingAndDetail([fx.listingExtra.listing], [fx.listingExtra.detail]);
    const e = parse1(merged[0], at('2026-09-30T19:25:35Z'));
    expect(mk(e, 'OU|MATCH|145.5')).toBeUndefined(); // jen v listingu (posunutá linie)
    expect(mk(e, 'OU|MATCH|146.5')).toBeDefined();
    expect(mk(e, 'ML|MATCH')).toBeDefined();
    expect(mk(e, 'AH|MATCH|3.5')).toBeDefined();
  });

  it('hockey: tie after regulation = intermission before OT; OT with a winner is not a break', () => {
    const ev = structuredClone(fx.tiedAfterRegulation);
    const now = at('2026-09-30T19:25:34Z');
    expect(parseState(ev, 'hockey', now)).toMatchObject({ score: [4, 4], period: 3, statusText: 'PERIOD_3:FINISHED', breakFlag: true });
    const won = structuredClone(ev);
    won.commentary!.facts!.find((f) => f.type === 'SCORE')!.value = '5';
    expect(parseState(won, 'hockey', now)!.breakFlag).toBeUndefined();
    won.commentary!.periods!.push({ type: 'OVERTIME', status: 'FINISHED', startTime: '2026-09-30T19:30:00Z', clock: { offset: 120, state: 'STOPPED' } });
    expect(parseState(won, 'hockey', now)!.breakFlag).toBeUndefined();
  });

  it('live period templates: hockey nth period 1X2/AH/BTTS, basketball Q3 OU/AH', () => {
    const h = parse1(fx.hockeyPeriods);
    expect(price(h, '1X2|P2', 'HOME')).toBe(2.45);
    expect(price(h, '1X2|P2', 'DRAW')).toBe(2.5);
    expect(price(h, '1X2|P2', 'AWAY')).toBe(3.15);
    expect(price(h, 'AH|P2|0.5', 'HOME')).toBe(1.29);
    expect(price(h, 'AH|P2|-0.5', 'AWAY')).toBe(1.47);
    expect(price(h, 'BTTS|P2', 'YES')).toBe(2.9);
    expect(h.markets.every((m) => !m.open)).toBe(true); // v REST suspendované
    const b = parse1(fx.basketQuarters, at('2026-09-30T19:45:24Z'));
    expect(price(b, 'OU|Q3|33.5', 'OVER')).toBe(1.98);
    expect(price(b, 'AH|Q3|-10.5', 'HOME')).toBe(1.83);
    expect(price(b, 'AH|Q3|-10.5', 'AWAY')).toBe(1.87);
  });

  it('suspended event closes all markets (REST status and push sEVENT st=S)', () => {
    const ev = structuredClone(fx.basketQuarters);
    const now = at('2026-09-30T19:45:24Z');
    expect(parse1(ev, now).markets.some((m) => m.open)).toBe(true);
    const r = applyMessage(new Map([['4257722', ev]]), msg('sEVENT', '4257722', { ev_id: 4257722, status: 'S' }));
    expect(r).toEqual({ changed: true, resync: '4257722' });
    expect(parse1(ev, now).markets.every((m) => !m.open)).toBe(true);
  });

  it('push: hidden/unmapped objects do not trigger resync; silent reopen does', () => {
    const ev = structuredClone(fx.race.event);
    const events = new Map([['4261983', ev]]);
    const ignored = new Set<string>();
    // skrytý výběr, který REST neposlal
    expect(applyMessage(events, msg('sSELCN', '1', { ev_id: 4261983, ev_mkt_id: 244721595, status: 'S', displayed: 'N' }), { ignored }).resync).toBeUndefined();
    // nový trh s nemapovaným kódem → ignorovat i jeho ceny
    expect(applyMessage(events, msg('sEVMKT', '999', { ev_id: 4261983, mkt_code: 'SET_X_GAME_X_POINT_X_WINNER', status: 'A', displayed: 'Y' }), { ignored }).resync).toBeUndefined();
    expect(ignored.has('999')).toBe(true);
    expect(applyMessage(events, msg('sPRICE', '5', { ev_id: 4261983, ev_mkt_id: 999, lp_num: '1', lp_den: '2' }), { ignored }).resync).toBeUndefined();
    // nový mapovaný trh → REST detail
    expect(applyMessage(events, msg('sEVMKT', '998', { ev_id: 4261983, mkt_code: 'TOTAL_GAMES_OVER/UNDER', status: 'A', displayed: 'Y' }), { ignored }).resync).toBe('4261983');
    // suspendovaný mapovaný trh dostává ceny → mohl být znovuotevřen bez st=A → ověřit REST
    applyMessage(events, msg('sEVMKT', '244721595', { ev_id: 4261983, status: 'S', displayed: 'Y' }));
    const r = applyMessage(events, msg('sPRICE', '637749513', { ev_id: 4261983, ev_mkt_id: 244721595, lp_num: '9', lp_den: '4' }));
    expect(r).toEqual({ changed: true, resync: '4261983' });
    expect(ev.markets!.find((m) => m.id === '244721595')!.outcomes[0].prices![0].decimal).toBe(3.25);
  });

  it('push decimals follow the REST convention (2 decimals, tiny prices floored)', () => {
    const pp = (v: string, n: string, d: string) => ({ lp_num: n, lp_den: d, potentialPayout: [{ type: 'MULTIPLIER', winPlaceOverrideRef: 'WIN', value: v }] });
    expect(pushDecimal(pp('1.83', '83', '100'))).toBe(1.83);
    expect(pushDecimal(pp('1.008', '1', '125'))).toBe(1); // REST: decimal 1
    expect(pushDecimal({ lp_num: '9', lp_den: '4' })).toBe(3.25);
    expect(pushDecimal({ lp_num: '', lp_den: '' })).toBeUndefined();
  });

  it('prematch requests are cache-busted (Akamai/origin cache up to ~90 s, non-monotonic)', async () => {
    const urls: string[] = [];
    const future = new Date(Date.now() + 3600_000).toISOString();
    const ev = { id: '1', name: 'A - B', startTime: future, sortCode: 'MTCH', liveNow: false, started: false, markets: [] };
    const transport = async (url: string) => {
      urls.push(url);
      return { status: 200, body: { data: { events: [ev] } }, bytes: 10, createdAt: Date.now() };
    };
    const noop = () => {};
    const log = { debug: noop, info: noop, warn: noop, error: noop, child: () => log };
    const core = new SazkaCore({ log } as unknown as AdapterContext, transport);
    await core.loadRaw('prematch', ['hockey'], { requests: 0, bytes: 0 });
    expect(urls).toHaveLength(2);
    expect(urls[0]).toMatch(/drilldownTagIds=8&eventState=OPEN_EVENT&_=\d+$/);
    expect(urls[1]).toMatch(/sazkaEventsDrilldownDetail\?eventIds=1&_=\d+$/);
  });

  it('name blacklist: replacement/derived templates never map onto canonical keys', () => {
    const m: ObMarket = {
      id: 'x',
      name: 'Výsledek zbytku zápasu',
      groupCode: 'MATCH_RESULT',
      status: 'ACTIVE',
      outcomes: [
        { id: '1', name: 'A', subType: 'H', status: 'ACTIVE', prices: [{ decimal: 2 }] },
        { id: '2', name: 'Remíza', subType: 'D', status: 'ACTIVE', prices: [{ decimal: 3 }] },
        { id: '3', name: 'B', subType: 'A', status: 'ACTIVE', prices: [{ decimal: 4 }] },
      ],
    };
    expect(mapMarket('football', m, 'A', 'B')).toBeNull();
    expect(mapMarket('football', { ...m, name: 'Výsledek zápasu' }, 'A', 'B')?.key).toBe('1X2|REG');
  });
});

// ---------------------------------------------------------------------------------------------
// Dvojtip (DC) a dalších 9 sportů. Fixtures = zkrácené reálné odpovědi API z 30. 9. / 1. 10. 2026 (noc):
//  - prematch-dc-newsports.json: listing + detail vybraných zápasů (fotbal, hokej, házená, AF, baseball, volejbal, šipky,
//    snooker, box, MMA),
//  - live-new-sports.json: živé zápasy (baseball MLB, volejbal, stolní tenis Setka Cup / TT Elite Series).
// ---------------------------------------------------------------------------------------------

const NEW_NOW = Date.parse('2026-09-30T22:40:00Z');
const keysOf = (e: RawEvent) => e.markets.map((m) => m.key);

describe('sazka double chance (DC) and new sports – prematch', async () => {
  const raw = await load('prematch-dc-newsports.json');
  const events = parseEvents(raw, { scope: 'prematch', now: NEW_NOW });
  const ev = (id: string) => events.find((x) => x.sourceId === id)!;

  it('validates, all keys canonical, every expected sport is present', () => {
    const v = validateRawOdds(odds(events, 'openbet-api', 'prematch'), { minEvents: 5, maxAgeMs: 60_000, now: NOW });
    expect(v.errors).toEqual([]);
    expect(new Set(events.map((e) => e.sport))).toEqual(
      new Set(['football', 'hockey', 'handball', 'american_football', 'baseball', 'volleyball', 'darts', 'snooker', 'boxing', 'mma']),
    );
    for (const e of events) for (const m of e.markets) expect(isValidMarketKey(m.key), m.key).toBe(true);
  });

  it('football DC: 1X / X2 / 12 by subType (1, 2, 3), full time and halves, prices match 1X2', () => {
    const e = ev('4200060');
    expect(price(e, 'DC|REG', 'HOME_DRAW')).toBe(1.63);
    expect(price(e, 'DC|REG', 'DRAW_AWAY')).toBe(1.29);
    expect(price(e, 'DC|REG', 'HOME_AWAY')).toBe(1.29);
    expect(price(e, 'DC|H1', 'HOME_DRAW')).toBe(1.38);
    expect(price(e, 'DC|H1', 'DRAW_AWAY')).toBe(1.21);
    expect(price(e, 'DC|H2', 'HOME_AWAY')).toBe(1.43);
    // 1X2|REG 3.25 / 3.25 / 2.1 → 1X = 1/3.25 + 1/3.25 ≈ 1/1.63 (marže ~2 %)
    expect(1 / 3.25 + 1 / 3.25).toBeCloseTo(1 / 1.63, 1);
    expect(1 / 2.1 + 1 / 3.25).toBeCloseTo(1 / 1.29, 1);
    // "Dvojitý výsledek" (DOUBLE_RESULT) je jiný trh a DC se z něj nebere
    expect(keysOf(e).filter((k) => k.startsWith('DC|')).sort()).toEqual(['DC|H1', 'DC|H2', 'DC|REG']);
  });

  it('hockey DC: 60 minutes and periods (not "do rozhodnutí")', () => {
    const e = ev('3814143');
    expect(price(e, 'DC|REG', 'HOME_DRAW')).toBe(1.4);
    expect(price(e, 'DC|REG', 'DRAW_AWAY')).toBe(1.69);
    expect(price(e, 'DC|REG', 'HOME_AWAY')).toBe(1.23);
    expect(price(e, 'DC|P1', 'HOME_DRAW')).toBe(1.31);
    expect(price(e, 'DC|P3', 'DRAW_AWAY')).toBe(1.51);
    expect(keysOf(e).filter((k) => k.startsWith('DC|')).sort()).toEqual(['DC|P1', 'DC|P2', 'DC|P3', 'DC|REG']);
    // 1X2|REG 2.15 / 4.15 / 2.9 → 12 = 1/2.15 + 1/2.9 ≈ 1/1.23
    expect(1 / 2.15 + 1 / 2.9).toBeCloseTo(1 / 1.23, 1);
  });

  it('DC: outcome orientation comes from subType AND name; contradictions / extended time are refused', () => {
    const o = (name: string, subType: string, decimal: number) => ({ id: name, name, subType, status: 'ACTIVE', prices: [{ decimal }] });
    const m = (name: string, outs: ObOutcome[]): ObMarket => ({ id: 'dc', name, groupCode: 'DOUBLE_CHANCE', status: 'ACTIVE', outcomes: outs });
    const good = m('Dvojtip', [o('Sparta nebo Remíza', '1', 1.3), o('Remíza nebo Slavia', '2', 1.6), o('Sparta nebo Slavia', '3', 1.25)]);
    const r = mapMarket('football', good, 'Sparta', 'Slavia')!;
    expect(r.key).toBe('DC|REG');
    expect(Object.fromEntries(r.selections.map((s) => [s.key, s.odds]))).toEqual({ HOME_DRAW: 1.3, DRAW_AWAY: 1.6, HOME_AWAY: 1.25 });
    // subType "2" u názvu "Sparta nebo Slavia" (tj. 12) NESMÍ dát X2
    expect(mapMarket('football', m('Dvojtip', [o('Sparta nebo Slavia', '2', 1.25)]), 'Sparta', 'Slavia')).toBeNull();
    // neúplný dvojtip (skrytý výběr) je použitelný, ale výběr zůstane správně
    const partial = mapMarket('handball', m('Dvojtip', [o('Sparta nebo Remíza', '1', 7.75)]), 'Sparta', 'Slavia')!;
    expect(partial.key).toBe('DC|REG');
    expect(partial.selections).toHaveLength(1);
    // název s prodloužením = rozsah bez remízy → nechápeme
    expect(mapMarket('hockey', m('Dvojtip do rozhodnutí', good.outcomes), 'Sparta', 'Slavia')).toBeNull();
    // nemapovaný sport/kód: box nemá DC pravidlo
    expect(mapMarket('boxing', good, 'Sparta', 'Slavia')).toBeNull();
    expect(mapMarket('football', { ...good, groupCode: 'DOUBLE_RESULT' }, 'Sparta', 'Slavia')).toBeNull();
    // poločas házené: stejný kód jako ve fotbale
    expect(mapMarket('handball', { ...good, groupCode: 'DOUBLE_CHANCE_1ST_HALF', name: '1.poločas: dvojtip' }, 'Sparta', 'Slavia')?.key).toBe('DC|H1');
  });

  it('handball: 60 minutes (REG) + halves; DC, DNB, AH from home perspective, team totals', () => {
    const e = ev('4264021');
    expect([e.home, e.away]).toEqual(['El Zamalek', 'Al Ahli Sports Club (Egy)']);
    expect(e.competition).toBe('Mistrovství světa klubů');
    expect(price(e, '1X2|REG', 'HOME')).toBe(3.25);
    expect(price(e, '1X2|REG', 'DRAW')).toBe(8);
    expect(price(e, 'DC|REG', 'HOME_DRAW')).toBe(2.4);
    expect(price(e, 'DC|REG', 'DRAW_AWAY')).toBe(1.26);
    expect(price(e, 'DC|REG', 'HOME_AWAY')).toBe(1.03);
    expect(price(e, 'DNB|REG', 'HOME')).toBe(2.9);
    expect(price(e, '1X2|H1', 'AWAY')).toBe(1.61);
    expect(price(e, 'DNB|H1', 'HOME')).toBe(2.5);
    expect(price(e, 'OU|REG|56.5', 'OVER')).toBe(2.05);
    expect(price(e, 'OU|H1|28.5', 'OVER')).toBe(2.3);
    expect(price(e, 'OU_HOME|REG|25.5', 'OVER')).toBe(1.53);
    expect(price(e, 'OU_AWAY|REG|27.5', 'UNDER')).toBe(2.4);
    // "Handicap 1.5": El Zamalek +1.5 @2.05, soupeř −1.5 @1.63 → linie domácích +1.5
    expect(price(e, 'AH|REG|1.5', 'HOME')).toBe(2.05);
    expect(price(e, 'AH|REG|1.5', 'AWAY')).toBe(1.63);
    expect(mk(e, 'AH|REG|1.5')!.rawName).toBe('Handicap 1.5');
    // AH +2.5 / +3.5 domácích jsou oba zrcadlově
    expect(price(e, 'AH|REG|3.5', 'HOME')).toBe(1.53);
    expect(keysOf(e).some((k) => k.includes('MATCH'))).toBe(false); // bez prodloužení žádný MATCH scope
  });

  it('american football: only 3-way 60 min + "(včetně prodloužení)" handicap; ML, totals without scope left out', () => {
    const e = ev('3886665');
    expect(price(e, '1X2|REG', 'HOME')).toBe(2.3);
    expect(price(e, '1X2|REG', 'DRAW')).toBe(11);
    expect(price(e, '1X2|H1', 'DRAW')).toBe(7.75);
    expect(price(e, 'AH|MATCH|4.5', 'HOME')).toBe(1.54);
    expect(price(e, 'AH|MATCH|4.5', 'AWAY')).toBe(2.25);
    expect(price(e, 'AH|H1|1.5', 'AWAY')).toBe(1.83);
    expect(price(e, 'OU|H1|18.5', 'OVER')).toBe(1.71);
    // "Vítěz zápasu do rozhodnutí" (MONEY_LINE): NFL remíza po prodloužení → neznámé vyhodnocení
    expect(keysOf(e)).not.toContain('ML|MATCH');
    // "Body: pod/nad" bez uvedení rozsahu (+ týmové) – nejasné, zda vč. prodloužení
    expect(keysOf(e).filter((k) => k.startsWith('OU|MATCH') || k.startsWith('OU|REG') || k.startsWith('OU_HOME') || k.startsWith('OU_AWAY'))).toEqual([]);
  });

  it('baseball: ML / run line / totals incl. extra innings, 3-way only with "9 směn"; first 5 innings and innings left out', () => {
    const npb = ev('4152342');
    expect(npb.competition).toBe('Japonsko NPB');
    expect(price(npb, 'ML|MATCH', 'HOME')).toBe(2.15);
    expect(price(npb, '1X2|REG', 'DRAW')).toBe(6.75);
    expect(price(npb, '1X2|REG', 'AWAY')).toBe(1.83);
    expect(price(npb, 'OE|MATCH', 'ODD')).toBe(1.59);
    expect(price(npb, 'AH|MATCH|1.5', 'HOME')).toBe(1.59);
    expect(price(npb, 'AH|MATCH|1.5', 'AWAY')).toBe(2.25);
    expect(price(npb, 'OU|MATCH|7.5', 'OVER')).toBe(2.5);
    expect(price(npb, 'OU_AWAY|MATCH|3.5', 'OVER')).toBe(1.98);
    const mlb = ev('4257695');
    expect(price(mlb, 'ML|MATCH', 'HOME')).toBe(1.73);
    expect(keysOf(mlb)).not.toContain('1X2|REG'); // MLB 3-cestný trh nenabízí
    expect(price(mlb, 'AH|MATCH|-2.5', 'HOME')).toBe(3.4);
    expect(price(mlb, 'AH|MATCH|-2.5', 'AWAY')).toBe(1.29);
    // "Prvních 5 směn", "1. směna", "Extra směna", "První dosáhne N bodů" → nic z toho nemá klíč
    expect(keysOf(mlb).every((k) => /^(ML|AH|OU|OU_HOME|OU_AWAY)\|MATCH/.test(k))).toBe(true);
    expect(mlb.markets.every((m) => !/5 směn|1\. směn|Extra|dosáhne/i.test(m.rawName ?? ''))).toBe(true);
  });

  it('volleyball: ML|MATCH, sets, points handicap and total (points, not sets)', () => {
    const e = ev('4264336');
    expect(price(e, 'ML|MATCH', 'HOME')).toBe(2.2);
    expect(price(e, 'ML|S1', 'HOME')).toBe(2.1);
    expect(price(e, 'ML|S1', 'AWAY')).toBe(1.63);
    expect(price(e, 'AH|MATCH|4.5', 'HOME')).toBe(1.83);
    expect(price(e, 'OU|MATCH|182.5', 'OVER')).toBe(1.83);
  });

  it('darts: ML|MATCH, sets handicap/total only in set format, legs total in leg format', () => {
    const sets = ev('4262538');
    expect(price(sets, 'ML|MATCH', 'HOME')).toBe(2.7);
    // "Zápas handicap 1.5": Zonneveld +1.5 @1.77, Anderson −1.5 @1.91 (= správná výhra 3:0/3:1 podle "Přesný výsledek")
    expect(price(sets, 'AH_SETS|MATCH|1.5', 'HOME')).toBe(1.77);
    expect(price(sets, 'AH_SETS|MATCH|1.5', 'AWAY')).toBe(1.91);
    expect(price(sets, 'OU_SETS|MATCH|3.5', 'OVER')).toBe(1.36);
    expect(keysOf(sets).filter((k) => k.startsWith('OU|'))).toEqual([]); // sety nejsou legy
    const wade = ev('4262697');
    expect(price(wade, 'AH_SETS|MATCH|-1.5', 'HOME')).toBe(2.1); // Wade −1.5 @2.10
    expect(price(wade, 'AH_SETS|MATCH|-1.5', 'AWAY')).toBe(1.63);
    const legs = ev('4268272');
    expect(price(legs, 'ML|MATCH', 'AWAY')).toBe(3.4);
    expect(price(legs, 'OU|MATCH|5.5', 'OVER')).toBe(1.63); // "Legy 5.5" = legy celého zápasu
    // handicap v zápase bez setů (neověřeno na legy) se nemapuje
    const noSets = structuredClone(raw.find((x) => x.id === '4262538')!);
    noSets.markets = noSets.markets!.filter((m) => !/SETS?(_|$)|_SET/.test(m.groupCode ?? ''));
    const p = parseEvent(noSets, { scope: 'prematch', now: NEW_NOW })!;
    expect(keysOf(p).some((k) => k.startsWith('AH'))).toBe(false);
    expect(price(p, 'ML|MATCH', 'HOME')).toBe(2.7);
  });

  it('snooker: ML and handicap / total in frames', () => {
    const e = ev('4266320');
    expect(price(e, 'ML|MATCH', 'HOME')).toBe(2.9);
    expect(price(e, 'ML|MATCH', 'AWAY')).toBe(1.4);
    expect(price(e, 'AH|MATCH|1.5', 'HOME')).toBe(2.05);
    expect(price(e, 'AH|MATCH|1.5', 'AWAY')).toBe(1.69);
    expect(price(e, 'AH|MATCH|0.5', 'HOME')).toBe(2.8); // +0.5 snookeru = vítěz (remíza neexistuje)
    expect(price(e, 'OU|MATCH|8.5', 'OVER')).toBe(3.75);
    expect(price(e, 'OU|MATCH|7.5', 'UNDER')).toBe(1.77);
  });

  it('boxing / MMA: 1X2|REG incl. draw, never ML; boxing 2-way "Vítěz zápasu" = DNB (draw refunded), MMA has no 2-way', () => {
    const box = ev('4062846');
    expect(price(box, '1X2|REG', 'HOME')).toBe(1.08);
    expect(price(box, '1X2|REG', 'DRAW')).toBe(16);
    expect(price(box, '1X2|REG', 'AWAY')).toBe(9);
    expect(price(box, 'DNB|REG', 'HOME')).toBe(1.04);
    expect(price(box, 'DNB|REG', 'AWAY')).toBe(8.5);
    // DNB je nižší než 1X2 a odpovídá normovanému poměru bez remízy (±0.01)
    const p = (o: number) => 1 / o;
    expect(p(1.08) / (p(1.08) + p(9))).toBeCloseTo(p(1.04) / (p(1.04) + p(8.5)), 1);
    expect(keysOf(box).some((k) => k.startsWith('OU') || k.startsWith('ML'))).toBe(false); // počet kol, způsob výhry vynechány
    const mma = ev('4246446');
    expect([mma.home, mma.away]).toEqual(['McGee Court', 'Nolan Eric']);
    expect(mma.competition).toBe('UFC');
    expect(keysOf(mma)).toEqual(['1X2|REG']);
    expect(price(mma, '1X2|REG', 'DRAW')).toBe(48);
    expect(price(mma, '1X2|REG', 'HOME')).toBe(2.75);
    expect(price(mma, '1X2|REG', 'AWAY')).toBe(1.35);
  });

  it('name blacklist also covers baseball first-N-innings, innings and volleyball golden set', () => {
    const base: ObMarket = {
      id: 'x',
      name: 'Prvních 5 směn: handicap 1.5',
      groupCode: 'HANDICAP_2_WAY',
      status: 'ACTIVE',
      outcomes: [
        { id: '1', name: 'A', subType: 'H', status: 'ACTIVE', prices: [{ decimal: 2.4, handicapLow: '+1.5', handicapHigh: '+1.5' }] },
        { id: '2', name: 'B', subType: 'A', status: 'ACTIVE', prices: [{ decimal: 1.47, handicapLow: '-1.5', handicapHigh: '-1.5' }] },
      ],
    };
    expect(mapMarket('baseball', base, 'A', 'B')).toBeNull();
    expect(mapMarket('baseball', { ...base, name: 'Body: handicap 1.5' }, 'A', 'B')?.key).toBe('AH|MATCH|1.5');
    expect(mapMarket('baseball', { ...base, name: '3. směna: handicap 1.5' }, 'A', 'B')).toBeNull();
    expect(mapMarket('volleyball', { ...base, groupCode: 'SET_WINNER_NTH', name: 'Zlatý set: vítěz' }, 'A', 'B')).toBeNull();
  });

  it('volleyball events with a golden set or baseball with listed pitchers are skipped', () => {
    const vb = structuredClone(raw.find((x) => x.id === '4264336')!);
    expect(parseEvent(vb, { scope: 'prematch', now: NEW_NOW })).not.toBeNull();
    expect(parseEvent({ ...vb, name: 'Indie - Pákistán (zlatý set)' }, { scope: 'prematch', now: NEW_NOW })).toBeNull();
    const bb = structuredClone(raw.find((x) => x.id === '4257695')!);
    expect(parseEvent(bb, { scope: 'prematch', now: NEW_NOW })).not.toBeNull();
    // nadhazovači v názvu týmů ("Tým (Nadhazovač)") – změna nadhazovače = kurz 1,00 pro všechny sázky (herní plán 16.1 f)
    const withPitchers = { ...bb, teams: bb.teams!.map((t) => ({ ...t, name: `${t.name} (Pitcher)` })) };
    expect(parseEvent(withPitchers, { scope: 'prematch', now: NEW_NOW })).toBeNull();
    expect(parseEvent({ ...bb, blurb: 'Nadhazovači: Cole, Bello' }, { scope: 'prematch', now: NEW_NOW })).toBeNull();
  });
});

describe('sazka new sports – live state and markets', async () => {
  const raw = await load('live-new-sports.json');
  const events = parseEvents(raw, { scope: 'live', now: NEW_NOW });
  const ev = (id: string) => events.find((x) => x.sourceId === id)!;

  it('validates and keeps all four live events', () => {
    expect(events.map((e) => e.sport).sort()).toEqual(['baseball', 'table_tennis', 'table_tennis', 'volleyball']);
    expect(events.every((e) => e.live)).toBe(true);
    const v = validateRawOdds(odds(events, 'openbet-api', 'live'), { minEvents: 1, maxAgeMs: 60_000, now: NOW });
    expect(v.errors).toEqual([]);
    for (const e of events) for (const m of e.markets) expect(isValidMarketKey(m.key), m.key).toBe(true);
  });

  it('volleyball: sets score, set points, per-set markets with their own group codes, sets handicap counts the score so far', () => {
    const e = ev('4250714');
    expect(e.url).toBe('https://www.allwyn.cz/kurzove-sazky/live/4250714');
    // skóre setů 0:2 (Itaqua vede), body setů domácí:hosté (fakta jsou v jiném pořadí než účastníci → podle participantId)
    expect(e.state).toMatchObject({ score: [0, 2], period: 3, statusText: 'SET_3', periodScores: [[17, 25], [19, 25], [19, 25]] });
    expect(e.state?.breakFlag).toBeUndefined(); // feed u setů žádný status/přestávku nedává
    // "Sety: handicap 2.5" (Itaqua −2.5 = 3:0) při 0:2 = výhra 3. setu (stejné ceny jako "3.set: vítěz")
    expect(price(e, 'AH_SETS|MATCH|2.5', 'HOME')).toBe(4.25);
    expect(price(e, 'AH_SETS|MATCH|2.5', 'AWAY')).toBe(1.16);
    expect(price(e, 'ML|S3', 'HOME')).toBe(4.25);
    expect(price(e, 'ML|S4', 'AWAY')).toBe(1.26);
    expect(price(e, 'OU_SETS|MATCH|3.5', 'OVER')).toBe(4.25);
    expect(price(e, 'AH|S3|4.5', 'HOME')).toBe(1.91);
    expect(price(e, 'AH|S4|3.5', 'AWAY')).toBe(1.8);
    expect(price(e, 'OU|S3|44.5', 'OVER')).toBe(1.73);
    expect(price(e, 'OU|S4|45.5', 'UNDER')).toBe(1.78);
    // "Sety: přesný výsledek", "3.set: extra body" … nemají klíč
    expect(keysOf(e).every((k) => /^(ML|AH|OU|AH_SETS|OU_SETS)\|(MATCH|S\d)/.test(k))).toBe(true);
  });

  it('table tennis: sets, per-set points, sets handicap, match points total, per-game handicap', () => {
    const a = ev('4262354');
    expect(a.state).toMatchObject({ score: [0, 2], period: 3, statusText: 'SET_3', periodScores: [[6, 11], [6, 11], [3, 3]] });
    expect(price(a, 'ML|MATCH', 'AWAY')).toBe(1.14);
    expect(price(a, 'AH_SETS|MATCH|2.5', 'HOME')).toBe(1.78);
    expect(price(a, 'OU|MATCH|66.5', 'OVER')).toBe(1.83);
    expect(price(a, 'OU|S3|18.5', 'OVER')).toBe(1.53);
    expect(price(a, 'ML|S3', 'AWAY')).toBe(1.83);
    const b = ev('4260166');
    expect(b.state).toMatchObject({ score: [2, 0], period: 3, periodScores: [[11, 4], [12, 10], [8, 7]] });
    // "3. Game Handicap 2-Way −2.5": Tkaczyk (domácí) −2.5 bodu @2.50, Lewczuk +2.5 @1.47
    expect(price(b, 'AH|S3|-2.5', 'HOME')).toBe(2.5);
    expect(price(b, 'AH|S3|-2.5', 'AWAY')).toBe(1.47);
    expect(price(b, 'ML|S3', 'HOME')).toBe(1.25);
    expect(price(b, 'OU|S3|19.5', 'OVER')).toBe(1.53);
    // "První dosáhne 10 bodů", "Získá 9. bod", "Lichý/sudý", "Přesný výsledek" – žádný klíč
    expect(keysOf(b).every((k) => /^(ML|AH|OU|AH_SETS|OU_SETS)\|(MATCH|S\d)/.test(k))).toBe(true);
  });

  it('baseball: innings as periods (score per inning), no clock, no break from missing signals', () => {
    const e = ev('4257694');
    expect(e.state).toMatchObject({ score: [3, 4], period: 4, statusText: 'INNINGS_4', periodScores: [[1, 4], [1, 0], [0, 0], [1, 0]] });
    expect(e.state?.breakFlag).toBeUndefined();
    expect(e.state?.clockSec).toBeUndefined();
    expect(price(e, 'ML|MATCH', 'HOME')).toBe(2.25);
    expect(price(e, 'AH|MATCH|1.5', 'HOME')).toBe(1.57); // +1.5 domácích při 3:4 (handicap počítá stav zápasu)
    expect(price(e, 'OU|MATCH|10.5', 'OVER')).toBe(1.5);
    expect(keysOf(e).some((k) => /1X2|S\d|P\d/.test(k))).toBe(false); // "Prvních 5 směn" a 3-cestný 9 směn tu nejsou
  });

  it('explicit break signal ends a set break; set period FINISHED + match undecided → break (volleyball to 3, TT from MAX_SETS)', () => {
    const vb = structuredClone(raw.find((x) => x.id === '4250714')!);
    vb.commentary!.periods![0].status = 'FINISHED';
    expect(parseState(vb, 'volleyball', NEW_NOW)).toMatchObject({ breakFlag: true });
    const done = structuredClone(vb);
    done.commentary!.facts = done.commentary!.facts!.map((f) => (f.type === 'SCORE' && f.participantId === '7729119' ? { ...f, value: '3' } : f));
    expect(parseState(done, 'volleyball', NEW_NOW)?.breakFlag).toBeUndefined(); // 0:3 = konec zápasu, ne přestávka
    const brk = structuredClone(raw.find((x) => x.id === '4250714')!);
    brk.commentary!.periods!.push({ type: 'SET_BREAK', startTime: '2026-09-30T22:45:00Z', periodIndex: 4 } as never);
    expect(parseState(brk, 'volleyball', NEW_NOW)).toMatchObject({ breakFlag: true, statusText: 'SET_BREAK' });
  });
});

describe('sazka new sports – requests, detail selection and push', async () => {
  const noop = () => {};
  const log = { debug: noop, info: noop, warn: noop, error: noop, child: () => log };
  const future = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
  const node = (id: string, code: string) => [{ id, code, levelNumber: 2 }];

  it('prematch URL groups: football alone (DNB params), everything else in ONE listing via drilldownTagIds', () => {
    const all = ['football', 'tennis', 'basketball', 'hockey', 'handball', 'volleyball', 'baseball', 'american_football', 'mma', 'boxing', 'darts', 'snooker', 'table_tennis'] as const;
    const groups = prematchListingGroups([...all]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual(['football']);
    expect(groups[1]).toHaveLength(12);
    expect(listingUrl(groups[1], 'prematch')).toMatch(/drilldownTagIds=12,5,8,29,42,4,3,9,6,23,37,39&eventState=OPEN_EVENT$/);
    expect(listingUrl(groups[0], 'prematch')).toContain('marketsSortsIncluded=MR,HL,--,DC,DN');
    expect(listingUrl([...all], 'live')).toMatch(/drilldownTagIds=11,12,5,8,29,42,4,3,9,6,23,37,39&liveNowOrSoon=true&_=\d+$/);
    expect(prematchListingGroups(['hockey', 'tennis'])).toEqual([['hockey', 'tennis']]);
    expect(prematchListingGroups(['football'])).toEqual([['football']]);
    expect(prematchListingGroups(['esports' as never])).toEqual([]);
  });

  it('prematch cycle: 2 listings + ⌈240/40⌉ detail requests for 13 sports; minor sports get details before tennis', async () => {
    const urls: string[] = [];
    // 250 tenisových zápasů dřív než házená; bez priority by házená detail nedostala (limit 240)
    const tennis = Array.from({ length: 250 }, (_, i) => ({ id: `t${i}`, name: 'A - B', startTime: future(1 + i / 100), sortCode: 'MTCH', liveNow: false, started: false, markets: [], drilldownNodes: node('12', 'tennis') }));
    const hb = { id: 'h1', name: 'C - D', startTime: future(20), sortCode: 'MTCH', liveNow: false, started: false, markets: [], drilldownNodes: node('29', 'handball') };
    const hb2 = { ...hb, id: 'h2', startTime: future(60) }; // házená je v okně 72 h
    const tennisLate = { ...tennis[0], id: 'tLate', startTime: future(60) }; // tenis jen do 24 h
    const box = { id: 'b1', name: 'E vs. F', startTime: future(2), sortCode: 'MTCH', liveNow: false, started: false, markets: [], drilldownNodes: node('6', 'boxing') };
    const detailIds: string[] = [];
    const transport = async (url: string) => {
      urls.push(url);
      if (url.includes('DrilldownDetail')) {
        const ids = /eventIds=([^&]+)/.exec(url)![1].split(',');
        detailIds.push(...ids);
        return { status: 200, body: { data: { events: [] } }, bytes: 10, createdAt: Date.now() };
      }
      const events = url.includes('drilldownTagIds=11&') ? [] : [...tennis, hb, hb2, tennisLate, box];
      return { status: 200, body: { data: { events } }, bytes: 10, createdAt: Date.now() };
    };
    const core = new SazkaCore({ log } as unknown as AdapterContext, transport);
    await core.loadRaw('prematch', ['football', 'tennis', 'handball', 'hockey', 'volleyball', 'baseball', 'american_football', 'mma', 'boxing', 'darts', 'snooker', 'table_tennis', 'basketball'], { requests: 0, bytes: 0 });
    expect(urls.filter((u) => u.includes('DrilldownList'))).toHaveLength(2);
    expect(urls.filter((u) => u.includes('DrilldownDetail'))).toHaveLength(6);
    expect(detailIds).toHaveLength(240);
    expect(detailIds.slice(0, 2)).toEqual(['h1', 'h2']);
    expect(detailIds).not.toContain('tLate');
    expect(detailIds).not.toContain('b1'); // box / MMA detail nepotřebují
    expect(urls.every((u) => /&_=\d+$/.test(u))).toBe(true); // vše s cache-busterem
  });

  it('push: new sports – unmapped templates are ignored, mapped per-set templates and a new set period trigger a resync', async () => {
    const live = await load('live-new-sports.json');
    const st = new PushState();
    st.events.set('4250714', structuredClone(live.find((e) => e.id === '4250714')!));
    const msg = (subjectType: string, subjectId: string, body: Record<string, unknown>): PushMessage => ({ channelType: 'SEVENT', channelId: String(body.ev_id), messageId: '!!!!!!!!!!', subjectType, subjectId, body });
    const ignored = st.ignored;
    // "4.set: přesný výsledek" / "extra body" nemapujeme → žádný resync
    expect(applyMessage(st.events, msg('sEVMKT', '7001', { ev_id: 4250714, mkt_code: 'SET_4_CORRECT_SCORE', status: 'A', displayed: 'Y' }), { ignored }).resync).toBeUndefined();
    expect(ignored.has('7001')).toBe(true);
    // nový mapovaný trh (vítěz 5. setu) → REST detail
    expect(applyMessage(st.events, msg('sEVMKT', '7002', { ev_id: 4250714, mkt_code: 'SET_WINNER_FIFTH_SET', status: 'A', displayed: 'Y' }), { ignored }).resync).toBe('4250714');
    // cena v existujícím trhu "Sety: handicap" (výběr jménem Bebedouro = HOME) se aplikuje
    const hc = st.events.get('4250714')!.markets!.find((m) => m.groupCode === 'MATCH_WINNER_SET_HANDICAP')!;
    const home = hc.outcomes.find((o) => o.subType === 'H')!;
    expect(applyMessage(st.events, msg('sPRICE', home.id, { ev_id: 4250714, ev_mkt_id: Number(hc.id), lp_num: '13', lp_den: '4' })).changed).toBe(true);
    expect(price(parseEvent(st.events.get('4250714')!, { scope: 'live', now: NEW_NOW })!, 'AH_SETS|MATCH|2.5', 'HOME')).toBe(4.25);
    // nový set (hodiny periody SET 4, kterou snapshot nezná) → resync
    expect(applyMessage(st.events, msg('sCLOCK', '4250714', { ev_id: 4250714, period_code: 'SET', period_index: 4, state: 'S', offset: 0, last_update: '2026-09-30T22:50:00+0000' })).resync).toBe('4250714');
    // hodiny existujícího setu jen aktualizují periodu
    expect(applyMessage(st.events, msg('sCLOCK', '4250714', { ev_id: 4250714, period_code: 'SET', period_index: 3, state: 'S', offset: 0, last_update: '2026-09-30T22:50:00+0000' })).resync).toBeUndefined();
  });

  it('isMappedMarketCode knows the new sports', () => {
    expect(isMappedMarketCode('handball', 'DOUBLE_CHANCE')).toBe(true);
    expect(isMappedMarketCode('volleyball', 'SET_WINNER_SECOND_SET')).toBe(true);
    expect(isMappedMarketCode('table_tennis', 'HANDICAP_2_WAY_NTH_GAME')).toBe(true);
    expect(isMappedMarketCode('baseball', 'FIRST_5_INNINGS_TOTAL_RUNS_OVER/UNDER')).toBe(false);
    expect(isMappedMarketCode('mma', 'SB_FIGHT_WINNER_3WAY')).toBe(true);
    expect(isMappedMarketCode('boxing', 'METHOD_OF_VICTORY')).toBe(false);
    expect(isMappedMarketCode('american_football', 'MONEY_LINE')).toBe(false);
  });
});

describe('sazka live state – sports without a live sample at verification time (structure from the web scoreboard config)', () => {
  const T0 = Date.parse('2026-10-01T18:00:00Z');
  const base = (periods: NonNullable<NonNullable<ObEvent['commentary']>['periods']>, h = '1', a = '0'): ObEvent => ({
    id: '9',
    name: 'A - B',
    startTime: '2026-10-01T17:30:00Z',
    liveNow: true,
    commentary: {
      participants: [
        { id: 'h', name: 'A', roleCode: 'HOME' },
        { id: 'a', name: 'B', roleCode: 'AWAY' },
      ],
      facts: [
        { type: 'SCORE', value: h, participantId: 'h' },
        { type: 'SCORE', value: a, participantId: 'a' },
      ],
      periods,
    },
  });
  const clock = (offset: number, state: string, lu = T0) => ({ offset, state, lastUpdate: new Date(lu).toISOString() });

  it('handball: ascending clock (30 min halves, offset relative to the half), half time is a break, a draw after 60 min is not', () => {
    const run = base([
      { type: 'FIRST_HALF', startTime: '2026-10-01T17:00:00Z', status: 'FINISHED', clock: clock(1800, 'STOPPED', T0 - 900_000) },
      { type: 'HALF_TIME', startTime: '2026-10-01T17:30:00Z', clock: clock(0, 'STOPPED', T0 - 600_000) },
      { type: 'SECOND_HALF', startTime: '2026-10-01T17:45:00Z', clock: clock(600, 'RUNNING', T0 - 5_000) },
    ]);
    expect(parseState(run, 'handball', T0)).toMatchObject({ statusText: 'SECOND_HALF', period: 2, clockRunning: true, clockSec: 1800 + 600 + 5 });
    expect(parseState(run, 'handball', T0)?.breakFlag).toBeUndefined();
    const ht = base([
      { type: 'FIRST_HALF', startTime: '2026-10-01T17:00:00Z', status: 'FINISHED', clock: clock(1800, 'STOPPED', T0 - 900_000) },
      { type: 'HALF_TIME', startTime: '2026-10-01T17:30:00Z', clock: clock(0, 'STOPPED') },
    ]);
    expect(parseState(ht, 'handball', T0)).toMatchObject({ statusText: 'HALF_TIME', breakFlag: true, clockRunning: false });
    const draw = base(
      [
        { type: 'FIRST_HALF', startTime: '2026-10-01T17:00:00Z', status: 'FINISHED', clock: clock(1800, 'STOPPED') },
        { type: 'SECOND_HALF', startTime: '2026-10-01T17:45:00Z', status: 'FINISHED', clock: clock(1800, 'STOPPED') },
      ],
      '25',
      '25',
    );
    expect(parseState(draw, 'handball', T0)?.breakFlag).toBeUndefined(); // remíza je běžný konec (prodloužení jen v play-off)
  });

  it('american football: countdown clock like basketball, quarter end = break, tie after Q4 = break before overtime', () => {
    const q2 = base([{ type: 'QUARTER_2', startTime: '2026-10-01T17:50:00Z', clock: clock(300, 'COUNTING_DOWN', T0 - 10_000) }], '7', '3');
    expect(parseState(q2, 'american_football', T0)).toMatchObject({ period: 2, clockRunning: true, periodRemainingSec: 290 });
    const end = base([{ type: 'QUARTER_2', startTime: '2026-10-01T17:50:00Z', clock: clock(0, 'STOPPED') }], '7', '3');
    expect(parseState(end, 'american_football', T0)).toMatchObject({ period: 2, breakFlag: true, periodRemainingSec: 0 });
    const tied = base([{ type: 'QUARTER_4', startTime: '2026-10-01T18:30:00Z', status: 'FINISHED', clock: clock(0, 'STOPPED') }], '20', '20');
    expect(parseState(tied, 'american_football', T0)?.breakFlag).toBe(true);
    const won = base([{ type: 'QUARTER_4', startTime: '2026-10-01T18:30:00Z', status: 'FINISHED', clock: clock(0, 'STOPPED') }], '27', '20');
    expect(parseState(won, 'american_football', T0)?.breakFlag).toBeUndefined();
  });

  it('darts (sets with nested legs) and snooker (frames): counters without clock, no invented break', () => {
    const fact = (v: string, id: string) => ({ type: 'SCORE', value: v, participantId: id });
    const darts = base(
      [
        { type: 'SET', periodIndex: 1, startTime: '2026-10-01T18:00:00Z', clock: clock(0, 'STOPPED'), facts: [fact('3', 'h'), fact('1', 'a')] },
        { type: 'SET', periodIndex: 2, startTime: '2026-10-01T18:10:00Z', clock: clock(0, 'STOPPED'), facts: [fact('1', 'h'), fact('2', 'a')] },
        { type: 'LEG', periodIndex: 4, startTime: '2026-10-01T18:15:00Z', clock: clock(0, 'STOPPED') },
      ],
      '1',
      '1',
    );
    expect(parseState(darts, 'darts', T0)).toMatchObject({ score: [1, 1], period: 2, statusText: 'SET_2', periodScores: [[3, 1], [1, 2]] });
    expect(parseState(darts, 'darts', T0)?.breakFlag).toBeUndefined();
    const dartsLegs = base([{ type: 'LEG', periodIndex: 5, startTime: '2026-10-01T18:15:00Z', clock: clock(0, 'STOPPED') }], '2', '2');
    expect(parseState(dartsLegs, 'darts', T0)).toMatchObject({ period: 5, statusText: 'LEG_5' });
    const snooker = base([{ type: 'FRAME', periodIndex: 3, startTime: '2026-10-01T18:15:00Z', clock: clock(0, 'STOPPED') }], '2', '0');
    expect(parseState(snooker, 'snooker', T0)).toMatchObject({ score: [2, 0], period: 3, statusText: 'FRAME_3' });
    expect(parseState(snooker, 'snooker', T0)?.periodScores).toBeUndefined();
  });

  it('MMA / boxing have no scoreboard: only the score, never a break', () => {
    const f = base([{ type: 'ROUND', periodIndex: 2, startTime: '2026-10-01T18:15:00Z', clock: clock(0, 'STOPPED') }], '0', '0');
    const st = parseState(f, 'mma', T0);
    expect(st?.breakFlag).toBeUndefined();
    expect(st?.clockSec).toBeUndefined();
  });
});
