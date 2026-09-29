import { describe, expect, it } from 'vitest';
import { loadFixture } from '../fixtures.js';
import { isValidMarketKey, parseMarketKey } from '../../core/markets.js';
import { validateRawOdds } from '../../core/validate.js';
import type { RawEvent, RawOdds } from '../../core/types.js';
import {
  buildEvents,
  mapMarket,
  mergeMini,
  parseGameState,
  type FortunaBundle,
  type FtnMarket,
  type FtnMarketsByFixture,
  type FtnMatchesPage,
  type FtnMiniScoreboard,
} from './parse.js';
import { FortunaLiveStore, type FtnWsMessage } from './live-store.js';
import { parseSockJs, unescapeHeader } from './ws.js';

const odds = (e: RawEvent | undefined, key: string) =>
  Object.fromEntries((e?.markets.find((m) => m.key === key)?.selections ?? []).map((s) => [s.key, s.odds]));
const raw = (events: RawEvent[], scope: 'prematch' | 'live', strategy: string): RawOdds => ({
  bookmaker: 'fortuna',
  strategy,
  scope,
  fetchedAt: Date.now(),
  events,
});

async function prematchBundle(): Promise<FortunaBundle> {
  const pages = await loadFixture<FtnMatchesPage[]>('fortuna', 'prematch-matches.json');
  const markets = await loadFixture<FtnMarketsByFixture>('fortuna', 'prematch-overview.json');
  for (const s of ['football', 'hockey', 'basketball', 'tennis']) {
    const d = await loadFixture<{ fixtureId: string; markets: FtnMarket[] }>('fortuna', `prematch-detail-${s}.json`);
    markets[d.fixtureId] = [...(markets[d.fixtureId] ?? []), ...d.markets];
  }
  return { scope: 'prematch', pages, markets };
}

describe('fortuna rest-api prematch (listing + overview + detail)', async () => {
  const bundle = await prematchBundle();
  const events = buildEvents(bundle);
  const byId = new Map(events.map((e) => [e.sourceId, e]));

  it('parses events of all four sports and drops e-sports / live fixtures', () => {
    expect(events.length).toBeGreaterThan(80);
    expect(new Set(events.map((e) => e.sport))).toEqual(new Set(['football', 'hockey', 'basketball', 'tennis']));
    expect(events.every((e) => !e.live && !e.state)).toBe(true);
    expect(events.some((e) => /esports|\dx\d+ min/i.test(e.competition))).toBe(false);
    const all = bundle.pages.flatMap((p) => p.fixtures ?? []);
    const esport = all.find((f) => /^ufo:ctgr:(0c|35|0e)-/.test(f.categoryId));
    expect(esport).toBeDefined();
    expect(byId.has(esport!.id)).toBe(false);
    expect(all.some((f) => f.kind === 'LIVE' && byId.has(f.id))).toBe(false);
  });

  it('football detail: Česko – Anglie, REG scopes and AH from the home side', () => {
    const e = byId.get('ufo:mtch:1wf-008')!;
    expect(e).toMatchObject({
      sport: 'football',
      home: 'Česko',
      away: 'Anglie',
      competition: 'Liga národů',
      country: 'Mezinárodní',
      startTime: Date.parse('2026-09-29T18:45:00Z'),
      url: 'https://www.ifortuna.cz/sazeni/fotbal/mezinarodni-30/liga-narodu/cesko-anglie',
    });
    expect(odds(e, '1X2|REG')).toEqual({ HOME: 8.8, DRAW: 5.4, AWAY: 1.34 });
    expect(odds(e, 'OU|REG|2.5')).toEqual({ OVER: 1.69, UNDER: 2.19 });
    expect(odds(e, 'OU|REG|4')).toEqual({ OVER: 4.2, UNDER: 1.23 }); // asijská celá linie
    expect(odds(e, 'AH|REG|1')).toEqual({ HOME: 2.55, AWAY: 1.5 }); // Česko (+1) / Anglie (-1)
    expect(odds(e, 'AH|REG|0').HOME).toBe(odds(e, 'DNB|REG').HOME); // AH 0 == sázka bez remízy
    expect(odds(e, 'BTTS|REG')).toEqual({ YES: 2.03, NO: 1.71 });
    expect(odds(e, '1X2|H1')).toEqual({ HOME: 7.8, DRAW: 2.6, AWAY: 1.74 });
    expect(odds(e, 'AH|H1|1')).toEqual({ HOME: 1.4, AWAY: 2.75 });
    expect(odds(e, 'BTTS|H2')).toEqual({ YES: 3.8, NO: 1.23 });
    expect(odds(e, 'OU_HOME|REG|0.5')).toEqual({ OVER: 1.81, UNDER: 1.86 });
    expect(odds(e, 'OU_AWAY|H2|1.5')).toEqual({ OVER: 2.6, UNDER: 1.45 });
    // hráčské trhy / kombinace se nemapují
    expect(e.markets.some((m) => /střel|gól z pokutového|náhradník/i.test(m.rawName ?? ''))).toBe(false);
    expect(e.markets.every((m) => parseMarketKey(m.key).scope !== 'MATCH')).toBe(true);
  });

  it('hockey detail: 60 min vs. „do rozhodnutí“ and periods', () => {
    const e = byId.get('ufo:mtch:1wf-00r')!;
    expect(e).toMatchObject({ sport: 'hockey', home: 'Hradec Králové', away: 'Sparta Praha', competition: '1. Česko' });
    expect(odds(e, '1X2|REG')).toEqual({ HOME: 2.69, DRAW: 4.05, AWAY: 2.21 });
    expect(odds(e, 'ML|MATCH')).toEqual({ HOME: 2.04, AWAY: 1.75 });
    expect(odds(e, 'AH|MATCH|-1.5')).toEqual({ HOME: 3.9, AWAY: 1.25 });
    expect(odds(e, 'AH|REG|-0.5')).toEqual({ HOME: 2.65, AWAY: 1.46 });
    expect(odds(e, 'OU|MATCH|5.5')).toEqual({ OVER: 2.08, UNDER: 1.73 });
    expect(odds(e, '1X2|P2')).toEqual({ HOME: 2.9, DRAW: 2.85, AWAY: 2.55 });
    expect(odds(e, 'OU|P3|1.5')).toEqual({ OVER: 1.65, UNDER: 2.07 });
    expect(odds(e, 'AH|P1|0.5')).toEqual({ HOME: 1.46, AWAY: 2.7 }); // název trhu anglicky „1. Period - Handicap“
    expect(odds(e, 'OU_AWAY|MATCH|2.5')).toEqual({ OVER: 1.67, UNDER: 2.13 });
    expect(e.markets.some((m) => m.key === 'ML|REG')).toBe(false);
  });

  it('basketball detail: 3-way REG, everything else incl. overtime, halves and quarters', () => {
    const e = byId.get('ufo:mtch:1wf-047')!;
    expect(e).toMatchObject({ sport: 'basketball', home: 'Dubai', away: 'Barcelona', competition: 'Euroliga - muži' });
    expect(Object.keys(odds(e, '1X2|REG')).sort()).toEqual(['AWAY', 'DRAW', 'HOME']);
    expect(odds(e, 'ML|MATCH')).toEqual({ HOME: 1.31, AWAY: 3.5 });
    expect(odds(e, 'AH|MATCH|-10.5')).toEqual({ HOME: 2.43, AWAY: 1.57 });
    expect(odds(e, 'OU|MATCH|162.5')).toEqual({ OVER: 1.35, UNDER: 3.2 });
    expect(odds(e, 'OU_HOME|MATCH|87.5')).toEqual({ OVER: 1.64, UNDER: 2.23 });
    expect(odds(e, '1X2|Q1')).toEqual({ HOME: 1.59, DRAW: 16, AWAY: 2.4 });
    expect(odds(e, 'AH|Q1|-1.5')).toEqual({ HOME: 1.8, AWAY: 1.98 });
    expect(odds(e, 'DNB|H1')).toEqual({ HOME: 1.44, AWAY: 2.7 });
    expect(odds(e, 'OE|H1')).toEqual({ ODD: 1.9, EVEN: 1.9 });
  });

  it('tennis detail: match, sets, games and set handicap', () => {
    const e = byId.get('ufo:mtch:1wf-0t4')!;
    expect(e).toMatchObject({ sport: 'tennis', home: 'Dart H.', away: 'Ma Y.', startTime: Date.parse('2026-09-29T03:00:00Z') });
    expect(odds(e, 'ML|MATCH')).toEqual({ HOME: 1.49, AWAY: 2.6 });
    expect(odds(e, 'ML|S1')).toEqual({ HOME: 1.54, AWAY: 2.32 });
    expect(odds(e, 'AH_SETS|MATCH|-1.5')).toEqual({ HOME: 2.12, AWAY: 1.65 });
    expect(odds(e, 'OU_SETS|MATCH|2.5')).toEqual({ OVER: 2.47, UNDER: 1.46 });
    expect(odds(e, 'OU|S1|10.5')).toEqual({ OVER: 3.85, UNDER: 1.22 });
    expect(odds(e, 'AH|MATCH|-0.5')).toEqual({ HOME: 1.49, AWAY: 2.44 });
    expect(odds(e, 'OU_HOME|MATCH|11.5')).toEqual({ OVER: 1.26, UNDER: 3.5 });
    expect(e.markets.every((m) => parseMarketKey(m.key).scope !== 'REG')).toBe(true);
  });

  it('only valid canonical keys with sport-consistent scopes; validateRawOdds passes', () => {
    for (const e of events) {
      for (const m of e.markets) {
        expect(isValidMarketKey(m.key)).toBe(true);
        const { type, scope } = parseMarketKey(m.key);
        if (e.sport === 'tennis') expect(scope === 'MATCH' || scope.startsWith('S')).toBe(true);
        if (e.sport === 'football') expect(['REG', 'H1', 'H2']).toContain(scope);
        if (e.sport === 'basketball' && type === 'ML') expect(scope).toBe('MATCH');
        if (e.sport === 'hockey') expect(['REG', 'MATCH', 'P1', 'P2', 'P3']).toContain(scope);
      }
    }
    const v = validateRawOdds(raw(events, 'prematch', 'rest-api'), { minEvents: 5, maxAgeMs: 60_000 });
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.stats.droppedOdds).toBe(0);
    expect(v.stats.markets).toBeGreaterThan(300);
  });
});

describe('fortuna rest-api live (live listing + overview + miniscoreboards)', async () => {
  const bundle: FortunaBundle = {
    scope: 'live',
    pages: await loadFixture<FtnMatchesPage[]>('fortuna', 'live-matches.json'),
    markets: await loadFixture<FtnMarketsByFixture>('fortuna', 'live-overview.json'),
    scoreboards: await loadFixture<FtnMiniScoreboard[]>('fortuna', 'live-miniscoreboards.json'),
  };
  const events = buildEvents(bundle);
  const byId = new Map(events.map((e) => [e.sourceId, e]));

  it('parses live events with game state and no e-sports', () => {
    expect(events.length).toBeGreaterThan(10);
    expect(new Set(events.map((e) => e.sport))).toEqual(new Set(['football', 'hockey', 'basketball', 'tennis']));
    expect(events.some((e) => /esports|\dx\d+ min|\(/i.test(e.competition))).toBe(false);
    expect(events.filter((e) => e.live).length).toBeGreaterThan(10);
  });

  it('football in 2nd half: minute clock, score, periods', () => {
    const e = byId.get('ufo:mtch:1we-026')!;
    expect(e).toMatchObject({ home: 'Tembetary', away: 'Paraguari AC', live: true, competition: '2. Paraguay' });
    expect(e.state).toEqual({
      statusText: '2. pol. - 52m',
      period: 2,
      breakFlag: false,
      clockSec: 52 * 60,
      score: [2, 1],
      periodScores: [
        [2, 0],
        [0, 1],
      ],
    });
    expect(odds(e, '1X2|REG')).toEqual({ HOME: 1.3, DRAW: 3.95, AWAY: 11 });
    expect(odds(e, 'OU|REG|4.5')).toEqual({ OVER: 2.47, UNDER: 1.41 });
  });

  it('tennis: sets, games, points; hockey/basketball: countdown in minutes', () => {
    expect(byId.get('ufo:mtch:1we-07p')!.state).toMatchObject({ period: 3, score: [1, 1], games: [5, 3], points: '40:15', periodScores: [[2, 6], [7, 5], [5, 3]] });
    expect(byId.get('ufo:mtch:1we-0dn')!.state).toMatchObject({ statusText: '2. tř. < 8m', period: 2, periodRemainingSec: 480, score: [0, 2] });
    const b = byId.get('ufo:mtch:1we-05s')!;
    expect(b.state).toMatchObject({ period: 1, periodRemainingSec: 120, score: [15, 9] });
    expect(odds(b, '1X2|REG').DRAW).toBe(23);
    expect(odds(b, 'ML|MATCH')).toEqual({ HOME: 1.02, AWAY: 8.8 });
  });

  it('not-started fixtures in the live feed are live=false', () => {
    const e = byId.get('ufo:mtch:1we-086')!;
    expect(e.live).toBe(false);
    expect(e.state).toEqual({ statusText: 'Začne brzy' });
    expect(odds(e, 'ML|MATCH')).toEqual({ HOME: 1.02, AWAY: 8.8 });
  });

  it('validateRawOdds passes', () => {
    const v = validateRawOdds(raw(events, 'live', 'rest-api'), { minEvents: 1, maxAgeMs: 60_000 });
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
  });
});

describe('fortuna game state (miniscoreboard texts)', () => {
  const mini = (gameTime: string, extra: Partial<FtnMiniScoreboard> = {}): FtnMiniScoreboard => ({
    fixtureId: 'x',
    columns: { TotalScore: { Home: '1', Away: '0' } },
    overview: { gameTime, info: [{ order: 1, home: 1, away: 0, finished: false }] },
    ...extra,
  });

  it('halftime / intermission „Přestávka“ -> breakFlag, clock stopped, period of the last period', () => {
    expect(parseGameState('football', mini('Přestávka')).state).toEqual({
      statusText: 'Přestávka',
      period: 1,
      breakFlag: true,
      clockRunning: false,
      score: [1, 0],
      periodScores: [[1, 0]],
    });
    expect(parseGameState('football', mini('1. pol. - 14m')).state).toMatchObject({ period: 1, breakFlag: false, clockSec: 840 });
    expect(parseGameState('football', mini('1. pol. - 45+2m')).state).toMatchObject({ clockSec: 47 * 60 });
    expect(parseGameState('hockey', mini('2. tř. < 3m')).state).toMatchObject({ period: 2, periodRemainingSec: 180, breakFlag: false });
    expect(parseGameState('basketball', mini('3. čt. < 4m')).state).toMatchObject({ period: 3, periodRemainingSec: 240 });
  });

  it('interrupted, finished, not started', () => {
    expect(parseGameState('tennis', mini('Přerušeno')).state).toMatchObject({ statusText: 'Přerušeno', clockRunning: false, period: 1 });
    expect(parseGameState('tennis', mini('Přerušeno')).state?.breakFlag).toBeUndefined();
    expect(parseGameState('football', mini('Zápas skončil')).state).toMatchObject({ finished: true, clockRunning: false });
    expect(parseGameState('tennis', mini('Začne brzy')).started).toBe(false);
    expect(parseGameState('tennis', mini('29.09.26 3:00:00')).started).toBe(false);
  });

  it('mergeMini keeps the last known periods when a break update omits them', () => {
    const prev = mini('2. tř. < 8m', { overview: { gameTime: '2. tř. < 8m', info: [{ order: 1, home: 0, away: 2, finished: true }, { order: 2, home: 0, away: 0 }] } });
    const next: FtnMiniScoreboard = { fixtureId: 'x', columns: { TotalScore: { Home: '0', Away: '2' } }, overview: { gameTime: 'Přestávka' } };
    expect(parseGameState('hockey', mergeMini(prev, next)).state).toMatchObject({ period: 2, breakFlag: true, periodScores: [[0, 2], [0, 0]] });
  });

  it('exact clock from the full scoreboard (websocket)', () => {
    const st = parseGameState('basketball', mini('2. čt. < 2m'), {
      fixtureId: 'x',
      eventTime: 1137,
      remainingTimeInPeriod: 63,
      timerRunning: true,
    }).state;
    expect(st).toMatchObject({ period: 2, clockSec: 1137, periodRemainingSec: 63, clockRunning: true });
  });
});

describe('fortuna market mapping edge cases', () => {
  const m = (typeId: string, name: string, outcomes: [string, number][], extra: Partial<FtnMarket> = {}): FtnMarket => ({
    id: 'm',
    fixtureId: 'f',
    marketTypeId: `ufo:mtyp:${typeId}`,
    name,
    outcomes: outcomes.map(([n, o], i) => ({ id: `o${i}`, name: n, odds: o, displayType: 'OPEN' })),
    ...extra,
  });

  it('skips inconsistent handicaps, unknown selections, wrong team totals, wrong sport prefixes', () => {
    expect(mapMarket(m('00-0b', 'Handicap v zápasu -1', [['A (-1)', 2], ['B (+1.5)', 1.8]]), 'football', 'A', 'B')).toBeNull();
    expect(mapMarket(m('00-0b', 'Handicap v zápasu -1', [['C (-1)', 2], ['B (+1)', 1.8]]), 'football', 'A', 'B')).toBeNull();
    expect(mapMarket(m('00-00', 'Výsledek zápasu', [['1', 2], ['X2', 3], ['2', 4]]), 'football', 'A', 'B')).toBeNull();
    expect(mapMarket(m('00-10', 'B počet gólů v zápasu', [['+ 1.5', 2], ['- 1.5', 1.8]], { marketTypeName: 'B počet gólů v zápasu' }), 'football', 'A', 'B')).toBeNull();
    expect(mapMarket(m('00-00', 'Výsledek zápasu', [['1', 2], ['0', 3], ['2', 4]]), 'hockey', 'A', 'B')).toBeNull();
    expect(mapMarket(m('0x-0e', 'Vítěz setu', [['1', 2], ['2', 1.8]]), 'tennis', 'A', 'B')).toBeNull(); // bez čísla setu
  });

  it('maps suspended outcomes as open=false and drops odds outside 1.01–1000', () => {
    const mk = m('0x-0e', 'Vítěz 2.setu', [['1', 1.5], ['2', 2.5]], { syntheticGroupKey: '2nd_set' });
    mk.outcomes[1].displayType = 'LOCKED';
    const r = mapMarket(mk, 'tennis', 'A', 'B')!;
    expect(r.key).toBe('ML|S2');
    expect(r.open).toBe(true);
    expect(r.selections.find((s) => s.key === 'AWAY')?.open).toBe(false);
    const bad = mapMarket(m('0x-01', 'Vítěz zápasu', [['1', 1.0], ['2', 12]]), 'tennis', 'A', 'B')!;
    expect(bad.selections.map((s) => s.key)).toEqual(['AWAY']);
    // perioda v názvu a v syntheticGroupKey si odporují -> vynechat
    expect(mapMarket(m('0x-0e', 'Vítěz 2.setu', [['1', 1.5], ['2', 2.5]], { syntheticGroupKey: '1st_set' }), 'tennis', 'A', 'B')).toBeNull();
  });
});

describe('fortuna websocket (SockJS/STOMP + live store)', async () => {
  it('parses SockJS frames and unescapes STOMP headers', () => {
    const msg =
      'a["MESSAGE\\ndestination:/topic/offer/cs/sport/ufo\\\\csprt\\\\c00/overview-markets\\nsubscription:sub-1\\nmessage-id:x-1\\n\\n{\\"id\\":\\"ufo:mkt:1\\",\\"operation\\":\\"DELETE\\"}\\u0000"]';
    const p = parseSockJs(msg);
    expect(p.frames).toHaveLength(1);
    expect(p.frames[0].command).toBe('MESSAGE');
    expect(p.frames[0].headers.destination).toBe('/topic/offer/cs/sport/ufo:sprt:00/overview-markets');
    expect(JSON.parse(p.frames[0].body)).toEqual({ id: 'ufo:mkt:1', operation: 'DELETE' });
    expect(parseSockJs('o').open).toBe(true);
    expect(parseSockJs('h').frames).toEqual([]);
    expect(parseSockJs('a["\\n"]').frames).toEqual([]); // STOMP heartbeat
    expect(unescapeHeader('a\\cb\\\\c')).toBe('a:b\\c');
  });

  const snapshot = await loadFixture<FortunaBundle>('fortuna', 'ws-snapshot.json');
  const messages = await loadFixture<[string, FtnWsMessage][]>('fortuna', 'ws-messages.json');

  it('applies recorded push messages on top of the REST snapshot', () => {
    const store = new FortunaLiveStore();
    store.loadSnapshot(snapshot, 1000);
    const before = buildEvents(store.bundle(1000));
    let changed = 0;
    for (const [dest, msg] of messages) if (store.apply(dest, msg, 2000)) changed++;
    expect(changed).toBeGreaterThan(100);
    const events = buildEvents(store.bundle(2000));
    expect(events.length).toBeGreaterThan(10);
    expect(before.length).toBeGreaterThan(10);

    // poslední UPDATE každého trhu musí být vidět ve výsledku, DELETE trh odstraní
    const last = new Map<string, FtnWsMessage>();
    for (const [dest, msg] of messages) if (dest.endsWith('/overview-markets')) last.set((msg.data as FtnMarket | undefined)?.id ?? msg.id!, msg);
    const bySource = new Map(events.flatMap((e) => e.markets.map((mk) => [mk.sourceId!, mk] as const)));
    let checked = 0;
    for (const [id, msg] of last) {
      if (msg.operation === 'DELETE') expect(bySource.has(id)).toBe(false);
      else {
        const mk = bySource.get(id);
        const data = msg.data as FtnMarket;
        if (!mk) continue; // e-sport, nemapovaný typ nebo zápas mimo live
        for (const s of mk.selections) expect(data.outcomes.map((o) => o.odds)).toContain(s.odds);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10);

    // hokejová přestávka uprostřed 2. třetiny: perioda a zmrazené hodiny z posledního scoreboardu
    const h = events.find((e) => e.sourceId === 'ufo:mtch:1we-0dn')!;
    expect(h.state).toMatchObject({ statusText: 'Přestávka', breakFlag: true, clockRunning: false, period: 2, periodRemainingSec: 426 });

    const v = validateRawOdds(raw(events, 'live', 'websocket'), { minEvents: 1, maxAgeMs: 60_000 });
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('extrapolates a running clock and drops fixtures deleted by the feed', () => {
    const store = new FortunaLiveStore();
    store.loadSnapshot(snapshot, 1000);
    const id = 'ufo:mtch:1we-05s';
    store.apply(`/topic/offer/v2/cs/scoreboard.${id}`, { id, data: { fixtureId: id, eventTime: 500, remainingTimeInPeriod: 100, timerRunning: true }, created: 10_000 }, 10_000);
    const c = store.bundle(40_000).clocks![id];
    expect(c.eventTime).toBe(530);
    expect(c.remainingTimeInPeriod).toBe(70);
    expect(store.apply('/topic/offer/cs/fixtures', { id, operation: 'DELETE' }, 41_000)).toBe(true);
    expect(buildEvents(store.bundle(41_000)).some((e) => e.sourceId === id)).toBe(false);
  });
});
