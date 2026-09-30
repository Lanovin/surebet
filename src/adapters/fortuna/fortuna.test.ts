import { describe, expect, it } from 'vitest';
import { loadFixture } from '../fixtures.js';
import { isValidMarketKey, parseMarketKey } from '../../core/markets.js';
import { validateRawOdds } from '../../core/validate.js';
import type { RawEvent, RawOdds, Sport } from '../../core/types.js';
import {
  PRIMARY_SPORTS,
  buildEvents,
  isSkipped,
  isUnsupportedFormat,
  mapMarket,
  mergeMini,
  parseGameState,
  sportOfFixture,
  type FortunaBundle,
  type FtnMarket,
  type FtnMarketsByFixture,
  type FtnMatchesPage,
  type FtnMiniScoreboard,
} from './parse.js';
import { FortunaLiveStore, TOPIC, type FtnWsMessage } from './live-store.js';
import { FortunaWsStrategy, SNAPSHOT_REPLAY_MARGIN_MS, parseSockJs, unescapeHeader } from './ws.js';
import { WebSocketServer, type WebSocket as WsClient } from 'ws';
import { StrategyError, type AdapterContext } from '../types.js';
import { DEFAULT_DETAIL, FortunaApi, collectLive, detailTargets, type Transport } from './strategies.js';

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

describe('fortuna live game state – texts seen live 30. 9. 2026', () => {
  it('„Konec“ = finished (hockey Leksand – Vasteras, 3:7)', () => {
    const st = parseGameState('hockey', {
      fixtureId: 'ufo:mtch:1wg-0dk',
      columns: { TotalScore: { Home: '3', Away: '7' } },
      overview: { gameTime: 'Konec', info: [{ order: 1, home: 0, away: 2, finished: true }, { order: 2, home: 0, away: 2, finished: true }, { order: 3, home: 3, away: 3, finished: false }] },
    }).state;
    expect(st).toMatchObject({ statusText: 'Konec', finished: true, clockRunning: false, score: [3, 7] });
    expect(st?.breakFlag).toBeUndefined();
  });

  it('„Za 3 m“ = not started yet (tennis Niedner N. – Markovina D.)', () => {
    const gs = parseGameState('tennis', { fixtureId: 'x', overview: { gameTime: 'Za 3 m' } });
    expect(gs.started).toBe(false);
    expect(gs.state).toEqual({ statusText: 'Za 3 m' });
  });

  it('„Prodl. < 5m“ = overtime period, running, countdown (hockey Ostersunds IK – Kalmar 4:4)', () => {
    const st = parseGameState('hockey', {
      fixtureId: 'x',
      columns: { TotalScore: { Home: '4', Away: '4' } },
      overview: { gameTime: 'Prodl. < 5m', info: [{ order: 1, home: 0, away: 1, finished: true }, { order: 2, home: 0, away: 2, finished: true }, { order: 3, home: 4, away: 1, finished: true }] },
    }).state;
    expect(st).toMatchObject({ period: 4, breakFlag: false, periodRemainingSec: 300, score: [4, 4] });
  });

  it('football „< 3m“ is time remaining, never elapsed time (e-sport 2×4 min text)', () => {
    const st = parseGameState('football', { fixtureId: 'x', columns: { TotalScore: { Home: '0', Away: '0' } }, overview: { gameTime: '1. pol. < 3m', info: [{ order: 1, home: 0, away: 0 }] } }).state;
    expect(st).toMatchObject({ period: 1, breakFlag: false });
    expect(st?.clockSec).toBeUndefined();
  });
});

interface RaceScenario {
  name: string;
  fixtureId: string;
  page: FtnMatchesPage;
  snapshot: { requestAtMs: number; loadAtMs: number; markets: FtnMarketsByFixture; scoreboards: FtnMiniScoreboard[] };
  messages: [number, string, FtnWsMessage][];
}

describe('fortuna websocket: REST resync must not overwrite newer push messages (recorded 30. 9. 2026)', async () => {
  const { scenarios } = await loadFixture<{ scenarios: RaceScenario[] }>('fortuna', 'ws-resync-race.json');
  const T0 = 1_790_000_000_000;
  /** Přehraje záznam (zprávy + snapshot načtený v loadAtMs) a vrátí událost v čase `until` (ms od požadavku). */
  const replayRecording = (sc: RaceScenario, until: number, replay: boolean) => {
    const store = new FortunaLiveStore();
    const bundle: FortunaBundle = { scope: 'live', pages: [sc.page], markets: sc.snapshot.markets, scoreboards: sc.snapshot.scoreboards };
    store.loadSnapshot(bundle, T0 - 60_000); // předchozí resync
    let loaded = false;
    const load = () => {
      loaded = true;
      store.loadSnapshot(bundle, T0 + sc.snapshot.loadAtMs, replay ? T0 + sc.snapshot.requestAtMs - SNAPSHOT_REPLAY_MARGIN_MS : undefined);
    };
    for (const [dt, dest, msg] of sc.messages) {
      if (dt > until) break;
      if (!loaded && dt > sc.snapshot.loadAtMs) load();
      store.apply(dest, msg, T0 + dt);
    }
    if (!loaded && until >= sc.snapshot.loadAtMs) load();
    return buildEvents(store.bundle(T0 + until)).find((e) => e.sourceId === sc.fixtureId)!;
  };

  it('tennis Koike – Zucchini: match-winner UPDATE 217 ms after the snapshot request survives the resync', () => {
    const sc = scenarios[0];
    expect(sc.snapshot.loadAtMs).toBeGreaterThan(363);
    // bez přehrání: snapshot vrátil kurzy z doby před brejkem a platily by 32 s (do další zprávy)
    const stale = replayRecording(sc, 30_000, false);
    expect(odds(stale, 'ML|MATCH')).toEqual({ HOME: 1.12, AWAY: 4.75 });
    expect(odds(stale, 'ML|S2')).toEqual({ HOME: 1.66, AWAY: 2.06 });
    const fixed = replayRecording(sc, 30_000, true);
    expect(odds(fixed, 'ML|MATCH')).toEqual({ HOME: 1.08, AWAY: 5.8 });
    expect(odds(fixed, 'ML|S2')).toEqual({ HOME: 1.44, AWAY: 2.5 });
  });

  it('football Barinas – Barquisimeto: markets suspended (DELETE) during the snapshot download stay suspended', () => {
    const sc = scenarios[1];
    const at = sc.snapshot.loadAtMs + 100; // před znovuotevřením trhů (668 ms)
    const stale = replayRecording(sc, at, false);
    expect(odds(stale, '1X2|REG')).toEqual({ HOME: 1.95, DRAW: 3.85, AWAY: 3.25 }); // vzkříšený suspendovaný trh
    const fixed = replayRecording(sc, at, true);
    expect(fixed.markets.map((m) => m.key)).toEqual([]);
    // po znovuotevření nové kurzy
    expect(odds(replayRecording(sc, 1000, true), '1X2|REG')).toEqual({ HOME: 2, DRAW: 3.45, AWAY: 3.4 });
  });
});

describe('fortuna websocket strategy against a local SockJS/STOMP server', () => {
  const sc = { page: null as unknown as FtnMatchesPage, markets: {} as FtnMarketsByFixture, minis: [] as FtnMiniScoreboard[], update: null as unknown as FtnWsMessage };
  const frame = (command: string, headers: Record<string, string>, body = '') =>
    'a' + JSON.stringify([`${command}\n${Object.entries(headers).map(([k, v]) => `${k}:${v}`).join('\n')}\n\n${body}\u0000`]);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function setup(overviewDelayMs: () => number) {
    const { scenarios } = await loadFixture<{ scenarios: RaceScenario[] }>('fortuna', 'ws-resync-race.json');
    const tennis = scenarios[0];
    sc.page = tennis.page;
    sc.markets = tennis.snapshot.markets;
    sc.minis = tennis.snapshot.scoreboards;
    sc.update = tennis.messages.find(([dt, dest]) => dt === 217 && dest.endsWith('overview-markets'))![2];
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((r) => wss.on('listening', () => r()));
    const clients: WsClient[] = [];
    wss.on('connection', (c) => {
      clients.push(c);
      c.send('o');
      c.on('message', (d) => {
        const s = d.toString();
        if (s.includes('CONNECT\\n')) c.send(frame('CONNECTED', { version: '1.2', 'heart-beat': '10000,10000' }));
      });
    });
    const http = {
      json: async (url: string) => {
        if (url.includes('/matches')) return { status: 200, body: url.includes('ufo:sprt:0x') ? sc.page : { fixtures: [] } };
        if (url.includes('/overview')) {
          await sleep(overviewDelayMs());
          return { status: 200, body: sc.markets };
        }
        if (url.includes('miniscoreboards')) return { status: 200, body: sc.minis };
        throw new Error(`unexpected ${url}`);
      },
    };
    const noop = () => {};
    const log = { debug: noop, info: noop, warn: noop, error: noop, child: () => log };
    const ctx = { bookmaker: 'fortuna', http, log } as unknown as AdapterContext;
    const port = (wss.address() as { port: number }).port;
    const strategy = new FortunaWsStrategy(ctx, { wsBase: `ws://127.0.0.1:${port}/stomp`, emitThrottleMs: 10, heartbeatEmitMs: 60_000, silenceMs: 600 });
    const push = (msg: FtnWsMessage) => {
      for (const c of clients) if (c.readyState === c.OPEN) c.send(frame('MESSAGE', { destination: '/topic/offer/cs/sport/ufo\\csprt\\c0x/overview-markets', subscription: 'sub-1', 'message-id': 'm' }, JSON.stringify(msg)));
    };
    return { wss, clients, strategy, push };
  }

  it('keeps a push UPDATE that arrives while the REST snapshot is loading; fetchedAt = last frame', async () => {
    const { wss, strategy, push } = await setup(() => 200);
    const got: RawOdds[] = [];
    const sub = strategy.subscribe({ scope: 'live', sports: ['tennis'] }, (r) => got.push(r), () => {});
    await sleep(80); // spojeno, snapshot se stahuje
    const pushedAt = Date.now();
    push(sc.update);
    await sub;
    const unsub = await sub;
    await sleep(50);
    const last = got[got.length - 1];
    const ev = last.events.find((e) => e.sourceId === 'ufo:mtch:1wg-2n1')!;
    expect(odds(ev, 'ML|MATCH')).toEqual({ HOME: 1.08, AWAY: 5.8 }); // ne stará 1.12 / 4.75 ze snapshotu
    expect(last.fetchedAt).toBeGreaterThanOrEqual(pushedAt - 5);
    expect(last.fetchedAt).toBeLessThanOrEqual(Date.now());
    await unsub();
    await strategy.dispose();
    wss.close();
  });

  it('silent socket -> reconnect; nothing is emitted until the fresh snapshot is loaded', async () => {
    let delay = 0;
    const { wss, clients, strategy, push } = await setup(() => delay);
    const got: { at: number; raw: RawOdds }[] = [];
    const errors: string[] = [];
    const unsub = await strategy.subscribe({ scope: 'live', sports: ['tennis'] }, (raw) => got.push({ at: Date.now(), raw }), (e) => errors.push(e.message));
    expect(got.length).toBeGreaterThan(0);
    // server přestane posílat cokoli (ani heartbeat) -> watchdog (600 ms) spojení zahodí a naváže nové
    delay = 400;
    await sleep(900);
    expect(errors.some((m) => /silent/.test(m))).toBe(true);
    const before = got.length;
    // reconnect po 1 s; během stahování nového snapshotu přijde zpráva – emitovat se nesmí, dokud snapshot není načtený
    while (clients.length < 2) await sleep(20);
    await sleep(60);
    push(sc.update);
    await sleep(150);
    expect(got.length).toBe(before);
    await sleep(400);
    expect(got.length).toBeGreaterThan(before);
    const ev = got[got.length - 1].raw.events.find((e) => e.sourceId === 'ufo:mtch:1wg-2n1')!;
    expect(odds(ev, 'ML|MATCH')).toEqual({ HOME: 1.08, AWAY: 5.8 });
    await unsub();
    await strategy.dispose();
    wss.close();
  }, 10_000);
});

describe('fortuna websocket: full market set per fixture (market.{id} topic, recorded 30. 9. 2026)', async () => {
  const rec = await loadFixture<{
    fixtureId: string;
    page: FtnMatchesPage;
    detail: (FtnMarket & { overview?: boolean })[];
    messages: [number, string, FtnWsMessage][];
  }>('fortuna', 'ws-detail-topic.json');
  const T0 = 1_790_000_000_000;
  const fid = rec.fixtureId; // Olympique Lyon – Chelsea FC (poločas, 0:0)
  // overview = jen hlavní plně otevřené trhy (to, co vrací overview endpoint / overview-markets topic)
  const overview = rec.detail.filter((m) => m.overview && m.outcomes.every((o) => o.displayType === 'OPEN'));
  const fresh = () => {
    const store = new FortunaLiveStore();
    store.loadSnapshot({ scope: 'live', pages: [rec.page], markets: { [fid]: overview } }, T0);
    return store;
  };
  const ev = (store: FortunaLiveStore, at: number) => buildEvents(store.bundle(T0 + at)).find((e) => e.sourceId === fid)!;
  const upTo = (store: FortunaLiveStore, from: number, to: number) => {
    for (const [dt, dest, msg] of rec.messages) if (dt > from && dt <= to) store.apply(dest, msg, T0 + dt);
  };

  it('detail adds AH, team totals, BTTS…; messages received before the detail was loaded are replayed', () => {
    const store = fresh();
    const before = ev(store, 0).markets.map((m) => m.key);
    expect(before.some((k) => k.startsWith('AH|'))).toBe(false);
    upTo(store, -Infinity, 22_400); // topic odebíraný, detail se stahuje – zprávy jen do journalu
    expect(ev(store, 22_400).markets.map((m) => m.key)).toEqual(before);
    store.loadDetail(fid, rec.detail, T0 + 22_400, T0 - 1_000);
    const e = ev(store, 22_400);
    const keys = e.markets.map((m) => m.key);
    expect(keys.length).toBeGreaterThan(before.length + 8);
    expect(keys).toEqual(expect.arrayContaining(['1X2|REG', 'DNB|REG', 'AH|REG|-0.5', 'BTTS|REG', 'OU_HOME|REG|0.5', 'OU_AWAY|REG|2.5', 'OU|REG|1']));
    // přehraná zpráva z 22 365 ms (dorazila během stahování detailu)
    expect(odds(e, 'AH|REG|-0.5')).toEqual({ HOME: 1.95, AWAY: 1.75 });
    upTo(store, 22_400, 30_000);
    const e2 = ev(store, 30_000);
    expect(odds(e2, '1X2|REG')).toEqual({ HOME: 1.95, DRAW: 2.75, AWAY: 4.6 });
    expect(odds(e2, 'AH|REG|-1.5')).toEqual({ HOME: 4.1, AWAY: 1.2 }); // trh přibyl zprávou (v REST detailu nebyl)
    // „- 2.5 = 1 (SUSPENDED)“: výběr bez kurzu vypadne, otevřený OVER zůstane
    expect(e2.markets.find((m) => m.key === 'OU_AWAY|REG|2.5')?.selections).toEqual([{ key: 'OVER', odds: 16, rawName: '+ 2.5' }]);
    const v = validateRawOdds(raw([e2], 'live', 'websocket'), { minEvents: 1, maxAgeMs: 60_000 });
    expect(v.errors).toEqual([]);
  });

  it('suspended outcome with a real price is open=false; DELETE removes the market', () => {
    const store = fresh();
    store.loadDetail(fid, rec.detail, T0, T0 - 1_000);
    const m1x2 = rec.detail.find((m) => m.marketTypeId === 'ufo:mtyp:00-00')!;
    const locked = { ...m1x2, outcomes: m1x2.outcomes.map((o) => (o.name === '1' ? { ...o, displayType: 'SUSPENDED' } : o)) };
    store.apply(TOPIC.detail(fid), { data: locked, operation: 'UPDATE', type: 'MARKET' }, T0 + 1_000);
    const mk = ev(store, 1_000).markets.find((m) => m.key === '1X2|REG')!;
    expect(mk.selections.find((x) => x.key === 'HOME')?.open).toBe(false);
    store.apply(TOPIC.detail(fid), { id: m1x2.id, operation: 'DELETE', type: 'MARKET' }, T0 + 2_000);
    expect(ev(store, 2_000).markets.some((m) => m.key === '1X2|REG')).toBe(false);
  });

  it('silent market.{id} topic: overview brings a change the detail never gets -> fall back to overview', () => {
    const store = fresh();
    store.loadDetail(fid, rec.detail, T0, T0 - 1_000);
    const m1x2 = overview.find((m) => m.marketTypeId === 'ufo:mtyp:00-00')!;
    const moved = { ...m1x2, outcomes: m1x2.outcomes.map((o) => ({ ...o, odds: o.name === '1' ? 2.4 : o.odds })) };
    store.apply(TOPIC.markets('ufo:sprt:00'), { data: moved, operation: 'UPDATE', type: 'MARKET' }, T0 + 5_000);
    expect(store.dropSilentDetails(T0 + 6_000)).toEqual([]); // ještě v toleranci
    expect(store.dropSilentDetails(T0 + 8_500)).toEqual([fid]);
    const e = ev(store, 8_500);
    expect(odds(e, '1X2|REG').HOME).toBe(2.4);
    expect(e.markets.some((m) => m.key.startsWith('AH|'))).toBe(false);
    // detail, který stejnou změnu doručí, se nezahazuje
    const s2 = fresh();
    s2.loadDetail(fid, rec.detail, T0, T0 - 1_000);
    s2.apply(TOPIC.markets('ufo:sprt:00'), { data: moved, operation: 'UPDATE', type: 'MARKET' }, T0 + 5_000);
    s2.apply(TOPIC.detail(fid), { data: moved, operation: 'UPDATE', type: 'MARKET' }, T0 + 5_020);
    expect(s2.dropSilentDetails(T0 + 9_000)).toEqual([]);
  });
});

describe('fortuna websocket strategy: market.{id} subscription + REST detail (local server)', () => {
  it('subscribes the fixture topic, downloads the detail and emits the full market set', async () => {
    const rec = await loadFixture<{ fixtureId: string; page: FtnMatchesPage; detail: (FtnMarket & { overview?: boolean })[] }>('fortuna', 'ws-detail-topic.json');
    const fid = rec.fixtureId;
    const overview = rec.detail.filter((m) => m.overview && m.outcomes.every((o) => o.displayType === 'OPEN'));
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((r) => wss.on('listening', () => r()));
    const events: string[] = [];
    wss.on('connection', (c) => {
      c.send('o');
      c.on('message', (d) => {
        const txt = d.toString();
        if (txt.includes('CONNECT\\n')) c.send('a' + JSON.stringify(['CONNECTED\nversion:1.2\nheart-beat:10000,10000\n\n\u0000']));
        const sub = /destination:([^\\]+)\\n/.exec(txt);
        if (txt.includes('SUBSCRIBE') && sub) events.push(`sub ${sub[1]}`);
      });
    });
    const http = {
      json: async (url: string) => {
        if (url.includes('/matches')) return { status: 200, body: url.includes('ufo:sprt:00') ? rec.page : { fixtures: [] } };
        if (url.includes('/overview')) return { status: 200, body: { [fid]: overview } };
        if (url.includes('miniscoreboards')) return { status: 200, body: [] };
        if (url.includes(`/fixture/${encodeURIComponent(fid)}/markets`)) {
          events.push('detail');
          return { status: 200, body: rec.detail };
        }
        throw new Error(`unexpected ${url}`);
      },
    };
    const noop = () => {};
    const log = { debug: noop, info: noop, warn: noop, error: noop, child: () => log };
    const ctx = { bookmaker: 'fortuna', http, log } as unknown as AdapterContext;
    const port = (wss.address() as { port: number }).port;
    const strategy = new FortunaWsStrategy(ctx, { wsBase: `ws://127.0.0.1:${port}/stomp`, emitThrottleMs: 10, detailGapMs: 10 });
    const got: RawOdds[] = [];
    const unsub = await strategy.subscribe({ scope: 'live', sports: ['football'] }, (r) => got.push(r), () => {});
    for (let i = 0; i < 50 && !events.includes('detail'); i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 60));
    expect(events).toContain(`sub /topic/offer/cs/market.${fid}`);
    expect(events).toContain('detail');
    const e = got[got.length - 1].events.find((x) => x.sourceId === fid)!;
    expect(e.markets.map((m) => m.key)).toEqual(expect.arrayContaining(['AH|REG|-0.5', 'BTTS|REG', 'OU_HOME|REG|0.5']));
    await unsub();
    await strategy.dispose();
    wss.close();
  });
});

describe('fortuna live listing: sport without live fixtures', () => {
  it('HTTP 404 „Structure with id ufo:sprt:0w not found“ is an empty listing, not a failed fetch', async () => {
    const pages = await loadFixture<FtnMatchesPage[]>('fortuna', 'live-matches.json');
    const tennis = pages.find((p) => p.fixtures?.some((f) => f.sportId === 'ufo:sprt:0x'))!;
    const urls: string[] = [];
    const t: Transport = {
      kind: 'http',
      get: async <T,>(url: string) => {
        urls.push(url);
        // /live/sports: hokej hlášený s live zápasem (výpis ale mezitím 404 – CDN), fotbal a basket bez live zápasů
        if (url.endsWith('/live/sports'))
          return [
            { id: 'ufo:sprt:0x', fixturesCount: 3 },
            { id: 'ufo:sprt:0w', fixturesCount: 1 },
            { id: 'ufo:sprt:0c', fixturesCount: 7 },
          ] as T;
        if (url.includes('/live/sport/ufo:sprt:0x/')) return tennis as T;
        if (url.includes('/live/sport/')) {
          throw new StrategyError(`HTTP 404 ${url}`, 'http', { status: 404, sample: 'Structure with id ufo:sprt:0w not found' });
        }
        if (url.includes('/overview')) return {} as T;
        return [] as T;
      },
    };
    const { bundle } = await collectLive(new FortunaApi(t), ['football', 'hockey', 'basketball', 'tennis'], null, 0, false);
    const events = buildEvents(bundle);
    expect(events.length).toBeGreaterThan(0);
    expect(new Set(events.map((e) => e.sport))).toEqual(new Set(['tennis']));
    expect(urls.some((u) => u.includes('/overview'))).toBe(true);
    // výpis jen pro sporty, které /live/sports hlásí (fotbal a basket se nestahují)
    expect(urls.filter((u) => u.includes('/live/sport/')).map((u) => /sprt:(\w+)/.exec(u)?.[1])).toEqual(['0w', '0x']);
    // jiná chyba než 404 se dál propaguje
    const t500: Transport = { kind: 'http', get: async () => { throw new StrategyError('HTTP 500 x', 'http', { status: 500 }); } };
    await expect(collectLive(new FortunaApi(t500), ['hockey'], null, 0, false)).rejects.toThrow('HTTP 500');
  });
});

// ---------- dvojtip (DC) a další sporty (fixtures z 1. 10. 2026, zkrácené na namapované trhy + pár nenamapovaných) ----------

const newSportsBundle = async (): Promise<FortunaBundle> => ({
  scope: 'prematch',
  ...(await loadFixture<{ pages: FtnMatchesPage[]; markets: FtnMarketsByFixture }>('fortuna', 'prematch-new-sports.json')),
});

describe('fortuna double chance (DC) – recorded 1. 10. 2026', async () => {
  const events = buildEvents(await newSportsBundle());
  const byName = (home: string) => events.find((e) => e.home === home)!;
  const selKeys = (e: RawEvent, key: string) => (e.markets.find((m) => m.key === key)?.selections ?? []).map((s) => s.key).sort();

  it('football: match (base time) and halves; 10 = 1X, 12, 02 = X2', () => {
    const e = byName('Argentina');
    expect(odds(e, 'DC|REG')).toEqual({ HOME_DRAW: 1.01, HOME_AWAY: 1.03, DRAW_AWAY: 5.4 });
    expect(odds(e, 'DC|H1')).toEqual({ HOME_DRAW: 1.03, DRAW_AWAY: 2.85, HOME_AWAY: 1.17 });
    // dvojtip sedí na 1X2: 1/1.01 ≈ P(1)+P(X) při maržích kolem 1.1
    expect(odds(e, '1X2|REG')).toEqual({ HOME: 1.06, DRAW: 11, AWAY: 30 });
  });

  it('hockey: 60 min and periods P1–P3 (not „do rozhodnutí“)', () => {
    const e = byName('Philadelphia Flyers');
    expect(odds(e, 'DC|REG')).toEqual({ HOME_DRAW: 1.4, DRAW_AWAY: 1.66, HOME_AWAY: 1.23 });
    expect(odds(e, 'DC|P1')).toEqual({ DRAW_AWAY: 1.44, HOME_AWAY: 1.41, HOME_DRAW: 1.34 });
    expect(odds(e, 'DC|P2')).toEqual({ HOME_AWAY: 1.34, DRAW_AWAY: 1.49, HOME_DRAW: 1.36 });
    expect(Object.keys(odds(e, 'DC|P3')).length).toBe(3);
    expect(e.markets.some((m) => m.key.startsWith('DC|MATCH'))).toBe(false);
  });

  it('handball: match and first half', () => {
    const e = byName('Helsingborg');
    expect(odds(e, 'DC|REG')).toEqual({ DRAW_AWAY: 2.08, HOME_AWAY: 1.09, HOME_DRAW: 1.33 });
    expect(odds(e, 'DC|H1')).toEqual({ HOME_AWAY: 1.09, DRAW_AWAY: 1.91, HOME_DRAW: 1.38 });
  });

  it('every DC market has exactly the three canonical selections, valid keys, only draw-capable scopes', () => {
    for (const e of events)
      for (const m of e.markets.filter((x) => x.key.startsWith('DC|'))) {
        expect(isValidMarketKey(m.key)).toBe(true);
        expect(['REG', 'H1', 'H2', 'P1', 'P2', 'P3', 'Q1', 'Q2', 'Q3', 'Q4']).toContain(parseMarketKey(m.key).scope);
        expect(m.selections.map((s) => s.key).sort()).toEqual(['DRAW_AWAY', 'HOME_AWAY', 'HOME_DRAW']);
      }
    expect(selKeys(byName('Argentina'), 'DC|REG')).toEqual(['DRAW_AWAY', 'HOME_AWAY', 'HOME_DRAW']);
  });

  it('mapMarket: DC needs 10/12/02, sports without a DC type or another sport prefix are skipped', () => {
    const mk = (typeId: string, outcomes: [string, number][]): FtnMarket => ({
      id: 'm',
      fixtureId: 'f',
      marketTypeId: `ufo:mtyp:${typeId}`,
      name: 'Výsledek zápasu - dvojtip',
      outcomes: outcomes.map(([n, o], i) => ({ id: `o${i}`, name: n, odds: o, displayType: 'OPEN' })),
    });
    const ok = mapMarket(mk('00-01', [['10', 1.2], ['12', 1.3], ['02', 2]]), 'football', 'A', 'B')!;
    expect(ok.key).toBe('DC|REG');
    expect(ok.selections.map((s) => s.key)).toEqual(['HOME_DRAW', 'HOME_AWAY', 'DRAW_AWAY']);
    expect(mapMarket(mk('00-01', [['1', 1.2], ['12', 1.3], ['02', 2]]), 'football', 'A', 'B')).toBeNull();
    expect(mapMarket(mk('00-01', [['10', 1.2], ['10', 1.3], ['02', 2]]), 'football', 'A', 'B')).toBeNull();
    expect(mapMarket(mk('00-01', [['10', 1.2], ['12', 1.3], ['02', 2]]), 'handball', 'A', 'B')).toBeNull();
    // fotbalový dvojtip 2. poločasu / hokejový za třetinu podle čísla v názvu
    const p = mk('0w-0t', [['10', 1.4], ['12', 1.3], ['02', 1.6]]);
    p.name = 'Výsledek 3. třetiny - dvojtip';
    p.syntheticGroupKey = '3rd_period_-_double_chance';
    expect(mapMarket(p, 'hockey', 'A', 'B')!.key).toBe('DC|P3');
    p.name = 'Výsledek třetiny - dvojtip';
    p.syntheticGroupKey = undefined;
    expect(mapMarket(p, 'hockey', 'A', 'B')).toBeNull(); // bez čísla třetiny
  });
});

describe('fortuna new sports – prematch (recorded 1. 10. 2026)', async () => {
  const bundle = await newSportsBundle();
  const events = buildEvents(bundle);
  const by = (sport: string, home?: string) => events.find((e) => e.sport === sport && (!home || e.home === home))!;
  const keys = (e: RawEvent) => e.markets.map((m) => m.key);
  const scopes = (e: RawEvent) => new Set(e.markets.map((m) => parseMarketKey(m.key).scope));
  const types = (e: RawEvent) => new Set(e.markets.map((m) => parseMarketKey(m.key).type));

  it('all nine new sports are returned with valid keys and validateRawOdds passes', () => {
    expect(new Set(events.map((e) => e.sport))).toEqual(
      new Set(['football', 'hockey', 'handball', 'volleyball', 'baseball', 'american_football', 'boxing', 'mma', 'darts', 'snooker', 'table_tennis']),
    );
    for (const e of events) for (const m of e.markets) expect(isValidMarketKey(m.key)).toBe(true);
    const v = validateRawOdds(raw(events, 'prematch', 'rest-api'), { minEvents: 1, maxAgeMs: 60_000 });
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
    // nenamapované trhy (kombinace, přesný výsledek, hráčské…) se nedostanou ven
    const rawCount = Object.values(bundle.markets).flat().length;
    expect(events.flatMap((e) => e.markets).length).toBeLessThan(rawCount);
  });

  it('handball: 60 min – 1X2, DNB, AH, totals, odd/even, halves; nothing with overtime', () => {
    const e = by('handball');
    expect(e).toMatchObject({ home: 'Helsingborg', away: 'Skanela', competition: '1. Švédsko - muži', country: 'Švédsko' });
    expect(odds(e, '1X2|REG')).toEqual({ HOME: 1.59, DRAW: 8, AWAY: 2.95 });
    expect(odds(e, 'DNB|REG')).toEqual({ HOME: 1.43, AWAY: 2.65 });
    expect(odds(e, 'AH|REG|-1.5')).toEqual({ HOME: 1.81, AWAY: 1.89 }); // „1 -1.5“ / „2 +1.5“ bez závorek
    expect(odds(e, 'OU|REG|59.5')).toEqual({ OVER: 2.07, UNDER: 1.68 });
    expect(odds(e, 'OU_HOME|REG|29.5')).toEqual({ OVER: 1.65, UNDER: 2.06 });
    expect(odds(e, 'OU_AWAY|REG|27.5')).toEqual({ OVER: 1.59, UNDER: 2.16 });
    expect(odds(e, 'OE|REG')).toEqual({ EVEN: 1.85, ODD: 1.97 });
    expect(odds(e, '1X2|H1')).toEqual({ HOME: 1.67, DRAW: 8.2, AWAY: 2.65 });
    expect(odds(e, 'AH|H1|-0.5')).toEqual({ HOME: 1.68, AWAY: 2.06 });
    expect(odds(e, 'OU|H1|28.5')).toEqual({ OVER: 1.73, UNDER: 1.99 });
    expect([...scopes(e)].sort()).toEqual(['H1', 'REG']);
    // kombinace a „vítězný náskok“ se nemapují
    expect(e.markets.some((m) => /náskok|^Výsledek .* a /i.test(m.rawName ?? ''))).toBe(false);
  });

  it('volleyball: points vs. sets kept apart (AH/OU on points, AH_SETS/OU_SETS on sets), set markets S1', () => {
    const e = by('volleyball');
    expect(e).toMatchObject({ home: 'Indie', away: 'Pákistán' });
    expect(odds(e, 'ML|MATCH')).toEqual({ HOME: 2.29, AWAY: 1.6 });
    expect(odds(e, 'AH_SETS|MATCH|-1.5')).toEqual({ HOME: 3.5, AWAY: 1.26 }); // „Indie -1.5“ / „Pákistán +1.5“
    expect(odds(e, 'AH_SETS|MATCH|1.5')).toEqual({ HOME: 1.61, AWAY: 2.17 });
    expect(odds(e, 'OU_SETS|MATCH|3.5')).toEqual({ OVER: 1.41, UNDER: 2.7 });
    expect(odds(e, 'OU|MATCH|180.5')).toEqual({ OVER: 1.71, UNDER: 2.02 });
    expect(odds(e, 'AH|MATCH|8.5')).toEqual({ HOME: 1.52, AWAY: 2.36 }); // body
    expect(odds(e, 'OU_HOME|MATCH|91.5')).toEqual({ OVER: 1.87, UNDER: 1.84 });
    expect(odds(e, 'OU_AWAY|MATCH|94.5')).toEqual({ OVER: 1.85, UNDER: 1.85 });
    expect(odds(e, 'ML|S1')).toEqual({ HOME: 2.12, AWAY: 1.64 });
    expect(odds(e, 'OU|S1|44.5')).toEqual({ OVER: 1.54, UNDER: 2.33 });
    expect(odds(e, 'AH|S1|-2.5')).toEqual({ HOME: 2.85, AWAY: 1.37 });
    expect(types(e).has('1X2')).toBe(false); // remíza neexistuje
    // „vyhraje alespoň set“ / přesný výsledek / kombinace 1. set + zápas se nemapují
    expect(e.markets.some((m) => /alespoň set|přesný výsledek|vítěz 1\. setu a/i.test(m.rawName ?? ''))).toBe(false);
  });

  it('baseball: everything incl. extra innings (MATCH), 1X2 only for 9 innings (REG), no 5-inning / hits markets', () => {
    const e = by('baseball');
    expect(e).toMatchObject({ home: 'NY Yankees', away: 'Boston Red Sox', competition: 'MLB' });
    expect(odds(e, 'ML|MATCH')).toEqual({ HOME: 1.75, AWAY: 2.14 });
    expect(odds(e, '1X2|REG')).toEqual({ HOME: 1.88, DRAW: 8, AWAY: 2.36 });
    expect(odds(e, 'AH|MATCH|-1.5')).toEqual({ HOME: 2.55, AWAY: 1.51 }); // run line
    expect(odds(e, 'AH|MATCH|1')).toEqual({ HOME: 1.5, AWAY: 2.6 });
    expect(odds(e, 'OU|MATCH|5')).toEqual({ OVER: 1.36, UNDER: 3.15 }); // celá linie = vrácení
    expect(odds(e, 'OU_HOME|MATCH|4.5')).toEqual({ OVER: 2.7, UNDER: 1.43 });
    expect(odds(e, 'OU_AWAY|MATCH|2.5')).toEqual({ OVER: 1.68, UNDER: 2.11 });
    expect([...scopes(e)].sort()).toEqual(['MATCH', 'REG']);
    expect(e.markets.some((m) => /po 5\. inningu|v \d\. inningu|hitů|1 - 5|1-5/i.test(m.rawName ?? ''))).toBe(false);
    expect(bundle.markets[e.sourceId].some((m) => m.marketTypeId === 'ufo:mtyp:0q-0c')).toBe(true); // „Vítěz po 5. inningu“ je ve zdroji
  });

  it('american football: 1X2 = regular time, AH/OU incl. overtime, halves and quarters; no ML (tie not refunded)', () => {
    const e = by('american_football');
    expect(e).toMatchObject({ home: 'Cleveland', away: 'Pittsburgh', competition: 'NFL' });
    expect(odds(e, '1X2|REG')).toEqual({ HOME: 2.34, DRAW: 13, AWAY: 1.71 });
    expect(odds(e, 'AH|MATCH|0.5')).toEqual({ HOME: 2.16, AWAY: 1.62 });
    expect(odds(e, 'OU|MATCH|38.5')).toEqual({ OVER: 1.87, UNDER: 1.84 });
    expect(odds(e, 'OU_HOME|MATCH|17.5')).toEqual({ OVER: 1.92, UNDER: 1.78 });
    expect(odds(e, 'OU_AWAY|MATCH|20.5')).toEqual({ OVER: 1.98, UNDER: 1.74 });
    expect(odds(e, 'OE|MATCH')).toEqual({ EVEN: 2.07, ODD: 1.68 });
    expect(odds(e, '1X2|H1')).toEqual({ HOME: 2.35, DRAW: 8.6, AWAY: 1.83 });
    expect(odds(e, 'AH|H1|3.5')).toEqual({ HOME: 1.55, AWAY: 2.29 });
    expect(odds(e, 'DNB|Q1')).toEqual({ HOME: 2.05, AWAY: 1.69 });
    expect(odds(e, 'OU|Q1|7.5')).toEqual({ OVER: 2.28, UNDER: 1.56 });
    expect(keys(e).some((k) => k.startsWith('ML|'))).toBe(false);
    // „Vítěz zápasu včetně prodloužení“ (0g-05) je ve zdroji, ale nenamapuje se
    const ml = bundle.markets[e.sourceId].find((m) => m.marketTypeId === 'ufo:mtyp:0g-05');
    expect(ml).toBeDefined();
    expect(mapMarket(ml!, 'american_football', e.home, e.away)).toBeNull();
  });

  it('boxing: 1X2|REG incl. draw and DNB|REG (winner, draw = refund) – never ML', () => {
    const e = by('boxing');
    expect(e).toMatchObject({ home: 'Sulaimaan, Ibraheem', away: 'Hardy, Sonny', country: 'Mezinárodní' });
    expect(odds(e, '1X2|REG')).toEqual({ HOME: 1.08, DRAW: 23, AWAY: 8.6 });
    expect(odds(e, 'DNB|REG')).toEqual({ HOME: 1.05, AWAY: 7.8 });
    expect(keys(e).some((k) => k.startsWith('ML|'))).toBe(false);
    // „Počet kol“, „Způsob vítězství“ a „na body“ se nemapují
    expect(keys(e).sort()).toEqual(['1X2|REG', 'DNB|REG']);
  });

  it('mma: UFC has 1X2 (draw) + DNB, other promotions DNB only (text: „V případě remízy budou sázky vráceny“)', () => {
    const ufc = by('mma', 'Figueiredo, Deiveson');
    expect(odds(ufc, '1X2|REG')).toEqual({ HOME: 5.2, DRAW: 50, AWAY: 1.14 });
    expect(odds(ufc, 'DNB|REG')).toEqual({ HOME: 5.2, AWAY: 1.13 });
    const fm = by('mma', 'Rybak, Dominika');
    expect(keys(fm)).toEqual(['DNB|REG']);
    expect(odds(fm, 'DNB|REG')).toEqual({ HOME: 1.22, AWAY: 3.75 });
    for (const e of [ufc, fm]) expect(keys(e).some((k) => k.startsWith('ML|') || k.startsWith('OU|'))).toBe(false);
  });

  it('darts: sets and legs are never mixed (AH_SETS/OU_SETS vs. AH/OU|MATCH on legs)', () => {
    const sets = by('darts', 'Zonneveld N.');
    expect(odds(sets, 'ML|MATCH')).toEqual({ HOME: 2.7, AWAY: 1.43 });
    expect(odds(sets, 'AH_SETS|MATCH|1.5')).toEqual({ HOME: 1.77, AWAY: 1.91 });
    expect(odds(sets, 'OU_SETS|MATCH|3.5')).toEqual({ OVER: 1.38, UNDER: 2.8 });
    expect(odds(sets, 'ML|S1')).toEqual({ HOME: 2.22, AWAY: 1.57 });
    expect(odds(sets, 'AH|S1|1.5')).toEqual({ HOME: 1.6, AWAY: 2.16 }); // legy v 1. setu
    expect(odds(sets, 'OU|S1|4.5')).toEqual({ OVER: 2.7, UNDER: 1.39 });
    const legs = by('darts', 'Thornton R.');
    expect(odds(legs, 'AH|MATCH|1.5')).toEqual({ HOME: 2.23, AWAY: 1.56 }); // legy
    expect(odds(legs, 'OU|MATCH|5.5')).toEqual({ OVER: 1.62, UNDER: 2.11 });
    expect(keys(legs).some((k) => k.startsWith('AH_SETS') || k.startsWith('OU_SETS'))).toBe(false);
    expect(keys(sets).some((k) => k.startsWith('AH|MATCH'))).toBe(false);
    // 180 / zavření se nemapují
    expect(events.filter((e) => e.sport === 'darts').every((e) => e.markets.every((m) => !/180|zavření/i.test(m.rawName ?? '')))).toBe(true);
  });

  it('snooker: ML and frame handicap/total', () => {
    const e = by('snooker');
    expect(e).toMatchObject({ home: 'Trump J.', away: 'Jiahui Si' });
    expect(odds(e, 'ML|MATCH')).toEqual({ HOME: 1.21, AWAY: 4.3 });
    expect(odds(e, 'AH|MATCH|-1.5')).toEqual({ HOME: 1.38, AWAY: 2.75 });
    expect(odds(e, 'OU|MATCH|7.5')).toEqual({ OVER: 2.22, UNDER: 1.56 });
  });

  it('table tennis: points vs. sets, set markets S1', () => {
    const e = by('table_tennis');
    expect(e).toMatchObject({ home: 'Tkaczyk H.', away: 'Lewczuk M.', competition: 'TT Elite Series' });
    expect(odds(e, 'ML|MATCH')).toEqual({ HOME: 1.47, AWAY: 2.31 });
    expect(odds(e, 'AH|MATCH|-4.5')).toEqual({ HOME: 1.86, AWAY: 1.78 }); // body
    expect(odds(e, 'OU|MATCH|77.5')).toEqual({ OVER: 1.86, UNDER: 1.78 });
    expect(odds(e, 'ML|S1')).toEqual({ HOME: 1.62, AWAY: 2.05 });
    expect(odds(e, 'OU|S1|18.5')).toEqual({ OVER: 1.74, UNDER: 1.9 });
    expect(odds(e, 'AH|S1|-3.5')).toEqual({ HOME: 2.93, AWAY: 1.29 });
  });

  it('sets above the 5th (best of 7) and unparseable set numbers are skipped', () => {
    const mk = (name: string): FtnMarket => ({
      id: 'm',
      fixtureId: 'f',
      marketTypeId: 'ufo:mtyp:0j-0a',
      name,
      outcomes: [{ id: 'a', name: '1', odds: 1.5, displayType: 'OPEN' }, { id: 'b', name: '2', odds: 2.5, displayType: 'OPEN' }],
    });
    expect(mapMarket(mk('Vítěz 5. setu'), 'table_tennis', 'A', 'B')!.key).toBe('ML|S5');
    expect(mapMarket(mk('Vítěz 6. setu'), 'table_tennis', 'A', 'B')).toBeNull();
    expect(mapMarket(mk('Vítěz setu'), 'table_tennis', 'A', 'B')).toBeNull();
  });

  it('handicap without parentheses: team names, „1 -1.5“, „2+0.5“, line 0 and mixed-up lines', () => {
    const mk = (typeId: string, outcomes: [string, number][]): FtnMarket => ({
      id: 'm',
      fixtureId: 'f',
      marketTypeId: `ufo:mtyp:${typeId}`,
      name: 'Handicap',
      outcomes: outcomes.map(([n, o], i) => ({ id: `o${i}`, name: n, odds: o, displayType: 'OPEN' })),
    });
    expect(mapMarket(mk('0h-03', [['1 +0.5\t', 2], ['2 -0.5', 1.6]]), 'snooker', 'A', 'B')!.key).toBe('AH|MATCH|0.5');
    expect(mapMarket(mk('0q-0p'.replace('0q-0p', '0q-0f'), [['1 -1.5\t', 2.5], ['2 +1.5', 1.5]]), 'baseball', 'A', 'B')!.key).toBe('AH|MATCH|-1.5');
    expect(mapMarket(mk('0m-01', [['Pákistán -1.5', 1.3], ['Indie +1.5', 3.4]]), 'volleyball', 'Indie', 'Pákistán')!.key).toBe('AH_SETS|MATCH|1.5');
    expect(mapMarket(mk('0h-03', [['1 0', 1.9], ['2 0', 1.9]]), 'snooker', 'A', 'B')!.key).toBe('AH|MATCH|0');
    expect(mapMarket(mk('0h-03', [['1 +0.5', 2], ['2 +0.5', 1.6]]), 'snooker', 'A', 'B')).toBeNull(); // obě strany stejné znaménko
    expect(mapMarket(mk('0h-03', [['A 3', 2], ['B -3', 1.6]]), 'snooker', 'A', 'B')).toBeNull(); // číslo bez znaménka = součást jména
    expect(mapMarket(mk('0h-03', [['C -1.5', 2], ['B +1.5', 1.6]]), 'snooker', 'A', 'B')).toBeNull(); // cizí jméno
    // typy trhů jiných sportů (kódy 14-/05-/19- jen box a MMA)
    expect(mapMarket(mk('14-01', [['1', 1.2], ['0', 20], ['2', 5]]), 'boxing', 'A', 'B')!.key).toBe('1X2|REG');
    expect(mapMarket(mk('14-01', [['1', 1.2], ['0', 20], ['2', 5]]), 'mma', 'A', 'B')).toBeNull();
    expect(mapMarket(mk('05-00', [['1', 1.2], ['0', 20], ['2', 5]]), 'mma', 'A', 'B')!.key).toBe('1X2|REG');
    expect(mapMarket(mk('19-00', [['1', 1.2], ['2', 5]]), 'mma', 'A', 'B')!.key).toBe('DNB|REG');
    expect(mapMarket(mk('19-00', [['1', 1.2], ['2', 5]]), 'boxing', 'A', 'B')).toBeNull();
  });

  it('volleyball: beach volleyball and golden-set formats are dropped, e-sports in new sports too', () => {
    const f = (o: object) => ({ id: 'x', sportId: 'ufo:sprt:0m', categoryId: 'ufo:ctgr:0m-00', tournamentId: 't', name: 'A - B', participants: [], ...o }) as never;
    expect(isUnsupportedFormat(f({}), { id: 't', name: 'Plážový volejbal - muži' } as never)).toBe(true);
    expect(isUnsupportedFormat(f({}), { id: 't', name: 'Liga (zlatý set)' } as never)).toBe(true);
    expect(isUnsupportedFormat(f({}), { id: 't', name: 'Asijské hry - muži' } as never)).toBe(false);
    expect(isUnsupportedFormat(f({ sportId: 'ufo:sprt:0x', name: 'Beach A - B' }), undefined)).toBe(false); // jen volejbal
    // kategorie cizího kódu pod reálným sportem = e-sport (box smí `01-`/`14-`, MMA `19-`/`05-`)
    const cat = (sportId: string, code: string) => f({ sportId, categoryId: `ufo:ctgr:${code}-00` });
    expect(isSkipped(cat('ufo:sprt:01', '01'))).toBe(false);
    expect(isSkipped(cat('ufo:sprt:19', '05'))).toBe(false);
    expect(isSkipped(cat('ufo:sprt:19', '19'))).toBe(false);
    expect(isSkipped(cat('ufo:sprt:0j', '0c'))).toBe(true);
    expect(isSkipped(cat('ufo:sprt:0y', '0y'))).toBe(false);
  });
});

describe('fortuna new sports – live game state (recorded 1. 10. 2026)', async () => {
  const rec = await loadFixture<{ pages: FtnMatchesPage[]; markets: FtnMarketsByFixture; scoreboards: FtnMiniScoreboard[] }>('fortuna', 'live-new-sports.json');
  const events = buildEvents({ scope: 'live', ...rec });
  const byId = new Map(events.map((e) => [e.sourceId, e]));

  it('table tennis: sets won, set scores, points in the running set', () => {
    const e = byId.get('ufo:mtch:1wg-22z')!;
    expect(e).toMatchObject({ sport: 'table_tennis', home: 'Midori Mihai', away: 'Uzun Alexandr', live: true });
    expect(e.state).toEqual({
      statusText: '4. set',
      period: 4,
      breakFlag: false,
      score: [1, 2],
      periodScores: [[10, 12], [11, 6], [4, 11], [6, 2]],
      points: '6:2',
    });
    // stav setů neobsahuje minutovou hodinu ani odpočet
    expect(e.state!.clockSec).toBeUndefined();
    expect(e.state!.periodRemainingSec).toBeUndefined();
    expect(Object.keys(odds(e, 'ML|MATCH')).sort()).toEqual(['AWAY', 'HOME']);
    expect(Object.keys(odds(e, 'AH_SETS|MATCH|1.5'))).toHaveLength(2);
  });

  it('volleyball: sets and points in the running set', () => {
    expect(byId.get('ufo:mtch:1un-02p')!.state).toMatchObject({ period: 2, score: [0, 1], periodScores: [[17, 25], [6, 9]], points: '6:9' });
    expect(byId.get('ufo:mtch:1wg-0bn')!.state).toMatchObject({ period: 1, score: [0, 0], periodScores: [[11, 8]], points: '11:8' });
  });

  it('baseball: innings as periods, runs per inning, no clock', () => {
    const e = byId.get('ufo:mtch:1wg-05t')!;
    expect(e).toMatchObject({ sport: 'baseball', live: true });
    expect(e.state).toEqual({ statusText: '3. směna', period: 3, breakFlag: false, score: [2, 4], periodScores: [[1, 4], [1, 0], [0, 0]] });
    expect(odds(e, 'ML|MATCH')).toEqual({ HOME: 2.66, AWAY: 1.41 });
    expect(odds(e, '1X2|REG')).toEqual({ HOME: 3.35, DRAW: 8, AWAY: 1.5 });
  });

  it('validateRawOdds passes', () => {
    const v = validateRawOdds(raw(events, 'live', 'rest-api'), { minEvents: 1, maxAgeMs: 60_000 });
    expect(v.errors).toEqual([]);
  });

  it('game state texts of the other new sports', () => {
    const mini = (gameTime: string, over: Partial<FtnMiniScoreboard['overview']> = {}): FtnMiniScoreboard =>
      ({ fixtureId: 'f', columns: { TotalScore: { Home: '1', Away: '0' } }, overview: { gameTime, ...over } }) as never;
    // házená: uplynulá minuta jako ve fotbale, poločas „Přestávka“
    expect(parseGameState('handball', mini('1. pol. - 24m')).state).toMatchObject({ period: 1, clockSec: 24 * 60, breakFlag: false });
    expect(parseGameState('handball', mini('Přestávka', { info: [{ order: 1, home: 14, away: 12, finished: true }] })).state).toMatchObject({ breakFlag: true, clockRunning: false, period: 1 });
    // americký fotbal: čtvrtiny s odpočtem, prodloužení je 5. perioda
    expect(parseGameState('american_football', mini('2. čt. < 6m')).state).toMatchObject({ period: 2, periodRemainingSec: 360 });
    expect(parseGameState('american_football', mini('Prodl. < 4m')).state).toMatchObject({ period: 5, periodRemainingSec: 240 });
  });
});

describe('fortuna request budget and websocket priorities for the new sports', async () => {
  it('overview batches: all sports in one stream, only the types of sports in the batch, URL < maxUrl', () => {
    const api = new FortunaApi({ kind: 'http', get: async () => ({}) as never });
    const items = [
      ...Array.from({ length: 400 }, (_, i) => ({ id: `ufo:mtch:1wf-${i.toString(36).padStart(3, '0')}`, sport: 'football' as const })),
      ...Array.from({ length: 60 }, (_, i) => ({ id: `ufo:mtch:1wg-${i.toString(36).padStart(3, '0')}`, sport: 'handball' as const })),
      ...Array.from({ length: 30 }, (_, i) => ({ id: `ufo:mtch:1wh-${i.toString(36).padStart(3, '0')}`, sport: 'mma' as const })),
    ];
    const urls = api.overviewUrls(items, true);
    expect(urls.length).toBeLessThanOrEqual(5);
    for (const u of urls) expect(u.length).toBeLessThan(7_000);
    const ids = urls.flatMap((u) => [...u.matchAll(/fixtureIds=([^&]+)/g)].map((x) => decodeURIComponent(x[1])));
    expect(ids.sort()).toEqual(items.map((i) => i.id).sort());
    // typy trhů jen sportů, které jsou v dávce
    const types = (u: string) => [...u.matchAll(/marketTypeIds=ufo%3Amtyp%3A([^&]+)/g)].map((x) => x[1]);
    expect(types(urls[0]).every((t) => t.startsWith('00-'))).toBe(true);
    expect(types(urls[0])).toContain('00-01'); // dvojtip je v overview fotbalu
    const last = urls[urls.length - 1];
    expect(types(last).some((t) => t.startsWith('05-') || t.startsWith('19-'))).toBe(true);
    expect(types(last).some((t) => t.startsWith('0j-'))).toBe(false);
    // netypovaný režim (websocket snapshot) typy neposílá
    expect(api.overviewUrls(items, false).every((u) => !u.includes('marketTypeIds'))).toBe(true);
  });

  it('prematch detail budget: main sports first (own quota), extra sports have their own small quota', () => {
    const now = 1_790_000_000_000;
    const fx = (id: string, code: string, inMin: number) => ({ id, sportId: `ufo:sprt:${code}`, startDatetime: now + inMin * 60_000, kind: 'PREMATCH', name: id, participants: [] }) as never;
    // kvóty: hlavní sporty max. maxTracked nejbližších, další sporty zvlášť extraMaxTracked (i když začínají dřív)
    const crowded = [
      ...Array.from({ length: 60 }, (_, i) => fx(`f${i}`, '00', 10 + i)),
      ...Array.from({ length: 30 }, (_, i) => fx(`h${i}`, '0y', 5 + i)),
    ];
    const a = detailTargets(crowded, DEFAULT_DETAIL, now).map((f) => f.id);
    expect(a.filter((id) => id.startsWith('f')).length).toBe(DEFAULT_DETAIL.maxTracked);
    expect(a.filter((id) => id.startsWith('h')).length).toBe(DEFAULT_DETAIL.extraMaxTracked);
    // okna: hokej 24 h, fotbal 3 h, další sporty 12 h; stolní tenis / MMA / box detail nedostanou (vše v overview)
    const list = [fx('t1', '0x', 20), fx('tt1', '0j', 1), fx('hk1', '0w', 20 * 60), fx('late', '00', 4 * 60), fx('hb1', '0y', 11 * 60), fx('hb2', '0y', 13 * 60), fx('mma', '19', 30), fx('bx', '01', 30)];
    const b = detailTargets(list, DEFAULT_DETAIL, now).map((f) => f.id);
    expect(b.sort()).toEqual(['hb1', 'hk1', 't1']);
  });

  it('websocket detail subscriptions (cap 40): original sports before the new ones, even if the new ones start earlier', async () => {
    const rec = await loadFixture<{ pages: FtnMatchesPage[]; markets: FtnMarketsByFixture; scoreboards: FtnMiniScoreboard[] }>('fortuna', 'live-new-sports.json');
    const old = await loadFixture<FtnMatchesPage[]>('fortuna', 'live-matches.json');
    // nové sporty mají nejdřívější začátek – bez prioritizace by obsadily všechny odběry
    const pages = [
      ...rec.pages.map((p) => ({ ...p, fixtures: p.fixtures!.map((f) => ({ ...f, startDatetime: 1 })) })),
      ...old,
    ];
    const store = new FortunaLiveStore();
    store.loadSnapshot({ scope: 'live', pages, markets: {} }, 1_790_000_000_000);
    const all: Sport[] = ['football', 'hockey', 'basketball', 'tennis', 'volleyball', 'baseball', 'table_tennis'];
    const cand = store.detailCandidates(all);
    const sportOf = (id: string) => sportOfFixture(pages.flatMap((p) => p.fixtures ?? []).find((f) => f.id === id)!);
    const firstNew = cand.findIndex((id) => !PRIMARY_SPORTS.includes(sportOf(id)!));
    const lastOld = cand.map((id) => PRIMARY_SPORTS.includes(sportOf(id)!)).lastIndexOf(true);
    expect(firstNew).toBeGreaterThan(-1);
    expect(lastOld).toBeGreaterThan(-1);
    expect(lastOld).toBeLessThan(firstNew);
    // nové sporty jsou v seznamu (dostanou zbytek odběrů)
    expect(new Set(cand.map((id) => sportOf(id)))).toContain('table_tennis');
  });

  it('live listing asks only the sports that /live/sports reports with live fixtures', async () => {
    const urls: string[] = [];
    const t: Transport = {
      kind: 'http',
      get: async <T,>(url: string) => {
        urls.push(url);
        if (url.endsWith('/live/sports'))
          return [{ id: 'ufo:sprt:0j', fixturesCount: 8 }, { id: 'ufo:sprt:0m', fixturesCount: 0 }, { id: 'ufo:sprt:0q', fixturesCount: 1 }] as T;
        if (url.includes('/live/sport/')) return { fixtures: [], categories: [], tournaments: [], pagingInfo: { hasNext: false } } as T;
        return {} as T;
      },
    };
    const api = new FortunaApi(t);
    expect(await api.liveSportsWithFixtures(['table_tennis', 'volleyball', 'baseball', 'football'])).toEqual(['table_tennis', 'baseball']);
    // neznámý tvar / chyba = ptát se všech
    const bad = new FortunaApi({ kind: 'http', get: async () => ({ nope: 1 }) as never });
    expect(await bad.liveSportsWithFixtures(['football'])).toBeNull();
    const err = new FortunaApi({ kind: 'http', get: async () => { throw new StrategyError('HTTP 500 x', 'http', { status: 500 }); } });
    expect(await err.liveSportsWithFixtures(['football'])).toBeNull();
    await collectLive(api, ['table_tennis', 'volleyball', 'baseball'], null, 0, false);
    expect(urls.filter((u) => u.includes('/live/sport/')).map((u) => /sprt:(\w+)/.exec(u)?.[1])).toEqual(['0j', '0q']);
  });
});
