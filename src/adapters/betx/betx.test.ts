import { describe, expect, it } from 'vitest';
import { loadFixture } from '../fixtures.js';
import { validateRawOdds } from '../../core/validate.js';
import { parseMarketKey } from '../../core/markets.js';
import type { RawEvent, RawOdds } from '../../core/types.js';
import type { AdapterContext } from '../types.js';
import {
  BetxHttpStrategy,
  DEFAULT_OPTIONS,
  livePasses,
  liveUrl,
  parseRaw,
  PUSH_DEFAULTS,
  rawGeneratedAt,
  type BetxRaw,
} from './strategies.js';
import {
  betxState,
  checkPushTable,
  liveGeneratedAt,
  LIVE_CACHE_MS,
  parseBetxMatches,
  parseUofKey,
  PUSH_BET_TYPES,
  pushSnapshot,
  pushUofKey,
  type BetxMatch,
  type BetxPushMatch,
  type PushConnState,
} from './parse.js';

type Fixture = BetxRaw & { recordedAt: string };

async function load(name: string, scope: 'prematch' | 'live'): Promise<{ events: RawEvent[]; now: number }> {
  const raw = await loadFixture<Fixture>('betx', name);
  const now = Date.parse(raw.recordedAt);
  return { events: parseRaw(raw, scope, now), now };
}

function odds(e: RawEvent, key: string): Record<string, number> {
  const m = e.markets.find((x) => x.key === key);
  if (!m) throw new Error(`market ${key} missing on ${e.home} – ${e.away}`);
  return Object.fromEntries(m.selections.map((s) => [s.key, s.odds]));
}

function validate(events: RawEvent[], scope: 'prematch' | 'live', now: number, strategy: string) {
  const raw: RawOdds = { bookmaker: 'betx', strategy, scope, fetchedAt: now, events };
  return validateRawOdds(raw, { minEvents: 1, maxAgeMs: 60_000, now });
}

describe('betx / betx-api prematch (matches/flat, víc BetTypeKey průchodů)', async () => {
  const { events, now } = await load('betx-api-prematch.json', 'prematch');
  const byId = new Map(events.map((e) => [e.sourceId, e]));

  it('parsuje a slučuje průchody pro všechny čtyři sporty', () => {
    expect(events).toHaveLength(80);
    for (const s of ['football', 'tennis', 'basketball', 'hockey']) expect(events.filter((e) => e.sport === s)).toHaveLength(20);
    expect(events.every((e) => !e.live && e.startTime > now && !e.state)).toBe(true);
  });

  it('fotbal: 1X2 + počet gólů + 2-cestný handicap z pohledu domácích', () => {
    const e = byId.get('73220774')!;
    expect(e).toMatchObject({
      sport: 'football',
      home: 'Suriname',
      away: 'Martinique',
      competition: 'CONCACAF Liga národů - Liga A',
      country: 'Mezinárodní',
      startTime: Date.parse('2026-09-28T22:00:00Z'),
    });
    expect(odds(e, '1X2|REG')).toEqual({ HOME: 1.49, DRAW: 4.09, AWAY: 6.5 });
    expect(odds(e, 'OU|REG|2.5')).toEqual({ OVER: 1.92, UNDER: 1.82 });
    // favorit domácí -> handicap domácích -1.5
    expect(odds(e, 'AH|REG|-1.5')).toEqual({ HOME: 2.35, AWAY: 1.53 });
  });

  it('hokej: 1X2 v základní době + vítěz vč. prodloužení + počet gólů', () => {
    const e = byId.get('72166250')!;
    expect(e).toMatchObject({ sport: 'hockey', home: 'Amur Khabarovsk', away: 'CHK Neftěchimik Nižněkamsk', competition: 'KHL' });
    expect(odds(e, '1X2|REG')).toEqual({ HOME: 2.29, DRAW: 3.96, AWAY: 2.56 });
    expect(odds(e, 'ML|MATCH')).toEqual({ HOME: 1.79, AWAY: 1.96 });
    expect(odds(e, 'OU|REG|5.5')).toEqual({ OVER: 2.18, UNDER: 1.64 });
  });

  it('tenis: vítěz, počet gemů, handicap gemů', () => {
    const e = byId.get('75094670')!;
    expect(e).toMatchObject({ sport: 'tennis', home: 'Tsitsipas, Stefanos', away: 'Hijikata, Rinky', startTime: Date.parse('2026-09-29T02:00:00Z') });
    expect(odds(e, 'ML|MATCH')).toEqual({ HOME: 1.29, AWAY: 3.38 });
    expect(odds(e, 'OU|MATCH|22.5')).toEqual({ OVER: 1.99, UNDER: 1.73 });
    expect(odds(e, 'AH|MATCH|-3.5')).toEqual({ HOME: 1.73, AWAY: 1.99 });
  });

  it('basket: vítěz, total a handicap vč. prodloužení', () => {
    const e = byId.get('74998040')!;
    expect(e).toMatchObject({ sport: 'basketball', home: 'CA Lanus', away: 'Gimnasia de Comodoro' });
    expect(odds(e, 'ML|MATCH')).toEqual({ HOME: 2.37, AWAY: 1.52 });
    expect(odds(e, 'OU|MATCH|157.5')).toEqual({ OVER: 1.88, UNDER: 1.82 });
    expect(odds(e, 'AH|MATCH|4.5')).toEqual({ HOME: 1.81, AWAY: 1.89 });
  });

  it('scope trhů odpovídá sportu', () => {
    for (const e of events)
      for (const m of e.markets) {
        const { type, scope } = parseMarketKey(m.key);
        if (e.sport === 'football') expect(scope).toBe('REG');
        if (e.sport === 'tennis' || e.sport === 'basketball') expect(scope).toBe('MATCH');
        if (e.sport === 'hockey') expect(type === 'ML' ? 'MATCH' : 'REG').toBe(scope);
      }
  });

  it('validateRawOdds projde', () => {
    const v = validate(events, 'prematch', now, 'betx-api');
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.stats.droppedOdds).toBe(0);
  });
});

describe('betx / betx-api live (matches/live + BetTypeKey 5_-1)', async () => {
  const { events, now } = await load('betx-api-live.json', 'live');
  const byId = new Map(events.map((e) => [e.sourceId, e]));

  it('parsuje live události s herním stavem', () => {
    expect(events).toHaveLength(13);
    expect(events.every((e) => e.live && e.state)).toBe(true);
    expect(events.filter((e) => e.sport === 'football')).toHaveLength(6);
  });

  it('fotbal: 1X2 ze základního listingu + OU z BetTypeKey průchodu, stav', () => {
    const e = byId.get('74894938')!;
    expect(e).toMatchObject({ home: 'CA Tembetary Ypane', away: 'Paraguari AC', competition: 'Segunda Division' });
    expect(e.state).toEqual({ statusText: '2. poločas', score: [2, 1], periodScores: [[2, 0], [0, 1]], period: 2, clockSec: 3120 });
    expect(e.markets.map((m) => m.key).sort()).toEqual(['1X2|REG', 'OU|REG|4.5']);
  });

  it('tenis: sety, gemy, body', () => {
    const e = byId.get('75048540')!;
    expect(e.state).toEqual({
      statusText: '3.set',
      score: [1, 1],
      periodScores: [[2, 6], [7, 5], [5, 3]],
      period: 3,
      games: [5, 3],
      points: '40:30',
    });
    expect(e.markets[0].key).toBe('ML|MATCH');
  });

  it('basket: čtvrtina, 1X2 základní doby', () => {
    const e = byId.get('73187244')!;
    expect(e.state).toMatchObject({ statusText: '1.čtvrtina', period: 1, score: [15, 9] });
    expect(e.markets[0].key).toBe('1X2|REG');
  });

  it('validateRawOdds projde', () => {
    const v = validate(events, 'live', now, 'betx-api');
    expect(v.ok).toBe(true);
    expect(v.stats.droppedOdds).toBe(0);
  });
});

describe('betx / betx-browser live (stejné API přes Chromium)', async () => {
  const { events, now } = await load('betx-browser-live.json', 'live');
  it('parsuje se stejně jako HTTP varianta', () => {
    expect(events.length).toBeGreaterThan(0);
    expect(validate(events, 'live', now, 'betx-browser').ok).toBe(true);
  });
});

describe('betx / přestávky a konce (pozorované payloady)', () => {
  const m = (x: Partial<BetxMatch>) => ({ Id: 1, MatchStartTime: '2026-09-28T20:00:00Z', SportId: 388, ...x }) as BetxMatch;
  it('fotbalový poločas: LB_SOCCER_PAUSED / "Přestávka" / paused', () => {
    const st = betxState(
      m({ LiveMatchTime: '45', LiveMatchTimeState: 'Přestávka', LiveMatchTimeOrigName: 'LB_SOCCER_PAUSED', LiveStatusString: 'paused', LiveMatchScore: '0 : 1', LiveSetScore: '0 : 1' }),
      'football',
    );
    expect(st).toEqual({ statusText: 'Přestávka', score: [0, 1], periodScores: [[0, 1]], breakFlag: true, period: 1, clockSec: 2700 });
  });
  it('hokejová přestávka: LB_ICE_HOCKEY_PAUSED', () => {
    const st = betxState(
      m({ SportId: 398, LiveMatchTime: '20', LiveMatchTimeState: 'Přestávka', LiveMatchTimeOrigName: 'LB_ICE_HOCKEY_PAUSED', LiveStatusString: 'paused', LiveMatchScore: '0 : 2', LiveSetScore: '0 : 2' }),
      'hockey',
    );
    expect(st).toMatchObject({ breakFlag: true, period: 1, clockSec: 1200, score: [0, 2] });
  });
  it('přerušený tenis není přestávka, konec zápasu je finished', () => {
    const t = betxState(
      m({ SportId: 389, LiveMatchTimeState: 'přerušeno', LiveMatchTimeOrigName: 'LB_TENNIS_INTERRUPTED', LiveStatusString: 'interrupted', LiveMatchScore: '0 : 0', LiveSetScore: '1 : 2', LiveGameScore: '15 : 30' }),
      'tennis',
    );
    expect(t.breakFlag).toBeUndefined();
    expect(t).toMatchObject({ statusText: 'přerušeno', games: [1, 2], points: '15:30' });
    const f = betxState(
      m({ LiveMatchTime: '', LiveMatchTimeState: 'Konec zápasu', LiveMatchTimeOrigName: 'LB_SOCCER_ENDED', LiveStatusString: 'ended', LiveMatchScore: '0 : 0', LiveSetScore: '0 : 0 - 0 : 0' }),
      'football',
    );
    expect(f).toMatchObject({ finished: true, score: [0, 0] });
    expect(f.breakFlag).toBeUndefined();
  });
});

describe('betx / UofKey a URL', () => {
  it('parsuje UofKey se specifikátory, varianty odmítne', () => {
    expect(parseUofKey('uof:3/sr:sport:4/446/12?periodnr=1&total=1.5')).toEqual({
      producer: 3,
      srSport: 4,
      market: 446,
      outcome: 12,
      specs: { periodnr: '1', total: '1.5' },
    });
    expect(parseUofKey('uof:3/sr:sport:1/15/sr:winning_margin:3+:119?variant=sr:winning_margin:3+')).toBeUndefined();
  });
  it('každý live BetTypeKey průchod má vlastní řetězec SportIds (serverová cache)', () => {
    expect(liveUrl([388, 389])).toMatch(/SportIds=388,389$/);
    expect(liveUrl([388, 389], '5_-1', 1)).toMatch(/SportIds=388,389,388&BetTypeKey=5_-1$/);
    expect(liveUrl([388], '7_16', 2)).toMatch(/SportIds=388,388,388&BetTypeKey=7_16$/);
  });
});

// ---------------------------------------------------------------- stáří live listingu

describe('betx / live listing: fetchedAt = okamžik vygenerování (serverová cache ~11 s)', async () => {
  // poll z 30. 9. 19:51:52 – listing vygenerovaný 19:51:42.312, tj. 10,2 s starý; Crystal Palace –
  // Charlton v něm ještě "otevřený", i když push zápas suspendoval už v 19:51:50.1 (viz push testy)
  const raw = await loadFixture<BetxRaw & { recordedAt: string }>('betx', 'betx-api-live-timed.json');
  const received = Date.parse(raw.recordedAt);

  it('rawGeneratedAt vrací max(LiveUpdateTimestamp), ne čas odpovědi', () => {
    expect(rawGeneratedAt(raw, received)).toBe(Date.parse('2026-09-30T19:51:42.312Z'));
    expect(received - rawGeneratedAt(raw, received)).toBeGreaterThan(10_000);
  });

  it('bez časových razítek: nejhůř start dotazu − TTL cache, nikdy po odpovědi', () => {
    expect(liveGeneratedAt([], 100_000, 100_100)).toBe(100_000 - LIVE_CACHE_MS);
    const m = { Id: 1, SportId: 388, MatchStartTime: '', LiveUpdateTimestamp: new Date(200_000).toISOString() } as BetxMatch;
    expect(liveGeneratedAt([m], 150_000, 150_100)).toBe(150_100);
  });

  it('fetch() stampuje fetchedAt stářím cache (stará data -> start dotazu − TTL)', async () => {
    const bodies = raw.live.map((l) => JSON.stringify(l.body));
    let i = 0;
    const ctx = {
      bookmaker: 'betx',
      http: { text: async () => ({ status: 200, body: bodies[Math.min(i++, bodies.length - 1)], headers: new Headers(), ms: 1, url: '' }) },
      log: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } },
    } as unknown as AdapterContext;
    const t0 = Date.now();
    const out = await new BetxHttpStrategy(ctx, DEFAULT_OPTIONS).fetch({ scope: 'live', sports: ['football', 'tennis', 'basketball', 'hockey'] });
    expect(out.fetchedAt).toBeLessThanOrEqual(t0 - LIVE_CACHE_MS + 50);
    expect(out.events.find((e) => e.sourceId === '73607406')?.markets.find((m) => m.key === '1X2|REG')?.open).toBe(true);
  });

  it('live průchody: sporty se stejným typem dohromady, každý průchod vlastní řetězec SportIds', () => {
    const all = ['football', 'tennis', 'basketball', 'hockey'] as const;
    for (const bts of [DEFAULT_OPTIONS.liveBetTypes, PUSH_DEFAULTS.pushBetTypes]) {
      const passes = livePasses([...all], bts);
      const urls = passes.map((p, i) => liveUrl(p.sportIds, p.bt, i));
      const ids = urls.map((u) => /SportIds=([\d,]+)/.exec(u)![1]);
      expect(new Set(ids).size).toBe(ids.length);
      expect(passes[0]).toEqual({ sportIds: [388, 389, 391, 398] });
    }
    expect(livePasses([...all], DEFAULT_OPTIONS.liveBetTypes).slice(1)).toEqual([
      { sportIds: [388, 398], bt: '5_-1' },
      { sportIds: [391], bt: '7_37' },
      { sportIds: [398], bt: '7_106' },
    ]);
  });
});

// ---------------------------------------------------------------- push

type PushFixture = {
  statics: BetxMatch[];
  items: { t: number; sid: number; bt?: string; x: BetxPushMatch }[];
};

describe('betx / push (SignalR liveUpdated, 1 spojení = sport + registrovaný typ)', async () => {
  const f = await loadFixture<PushFixture>('betx', 'betx-push-live.json');
  const statics = new Map(f.statics.map((m) => [m.Id, m]));
  const mkConns = (): PushConnState[] => {
    const conns: PushConnState[] = PUSH_DEFAULTS.pushBetTypes.football!.map((bt) => ({ sid: 388, bt, live: true, items: new Map() }));
    for (const [sport, sid] of [['tennis', 389], ['basketball', 391], ['hockey', 398]] as const)
      for (const bt of PUSH_DEFAULTS.pushBetTypes[sport]!) conns.push({ sid, bt, live: true, items: new Map() });
    for (const it of f.items) conns.find((c) => c.sid === it.sid && c.bt === it.bt)!.items.set(it.x.Id, { t: it.t, x: it.x });
    return conns;
  };
  const run = (conns = mkConns(), bad = new Set<string>(), healthy: (c: PushConnState) => boolean = () => true) =>
    new Map(parseBetxMatches(pushSnapshot(statics, conns, bad, healthy), { live: true }).map((e) => [e.sourceId, e]));
  const events = run();

  it('fotbal: 1X2 z BasicOffer + počet gólů z registrovaného 5_-1, stav z push (poločas)', () => {
    const e = events.get('74507942')!;
    expect(e).toMatchObject({ sport: 'football', home: 'Defensor Sporting', away: 'Plaza Colonia', live: true });
    expect(odds(e, '1X2|REG')).toEqual({ HOME: 5.4, DRAW: 2.9, AWAY: 1.7 });
    expect(odds(e, 'OU|REG|2.5')).toEqual({ OVER: 2.45, UNDER: 1.45 });
    expect(e.state).toMatchObject({ breakFlag: true, period: 1, score: [0, 1], clockSec: 2700 });
  });

  it('vyřazený výsledek (Odd 0, Active false) chybí, ostatní otevřené', () => {
    const m = events.get('58208457')!.markets.find((x) => x.key === '1X2|REG')!;
    expect(m.open).toBe(true);
    expect(m.selections.map((s) => [s.key, s.odds, s.open ?? true])).toEqual([
      ['DRAW', 8.5, true],
      ['AWAY', 50, true],
    ]);
  });

  it('suspendace (bo.a=false, kurzy a=false) -> trhy zavřené; listing ze stejné chvíle je ještě otevřený', () => {
    for (const id of ['73607406', '75111974']) {
      const e = events.get(id)!;
      expect(e.markets.length).toBeGreaterThan(0);
      for (const m of e.markets) {
        expect(m.open).toBe(false);
        expect(m.selections.every((s) => s.open === false)).toBe(true);
      }
    }
  });

  it('tenis: vítěz + handicap gemů (7_922, linie z pohledu hráče 1), gemy a body', () => {
    const e = events.get('75048490')!;
    expect(odds(e, 'ML|MATCH')).toEqual({ HOME: 1.65, AWAY: 2.05 });
    expect(odds(e, 'AH|MATCH|-2.5')).toEqual({ HOME: 1.7, AWAY: 1.95 });
    expect(e.state).toMatchObject({ period: 2, score: [1, 0], games: [5, 6], points: '30:30' });
  });

  it('basket: 1X2 základní doby (BasicOffer) + vítěz vč. prodloužení (7_37), herní čas', () => {
    const e = events.get('72902006')!;
    expect(odds(e, '1X2|REG')).toEqual({ HOME: 1.52, DRAW: 10.5, AWAY: 2.9 });
    expect(odds(e, 'ML|MATCH')).toEqual({ HOME: 1.42, AWAY: 2.6 });
    expect(e.state).toMatchObject({ breakFlag: true, period: 2, clockSec: 1140, score: [43, 42] });
  });

  it('hokej: dvě spojení (5_-1 a 7_106) se slučují – 1X2 + total základní doby + vítěz vč. prodl.', () => {
    const e = events.get('72123356')!;
    expect(odds(e, '1X2|REG')).toEqual({ HOME: 50, DRAW: 10, AWAY: 1.01 });
    expect(odds(e, 'OU|REG|6.5')).toEqual({ OVER: 1.32, UNDER: 2.85 });
    expect(odds(e, 'ML|MATCH')).toEqual({ HOME: 9.75, AWAY: 1.01 });
    expect(e.state).toMatchObject({ period: 3, score: [2, 4], clockSec: 3240 });
  });

  it('validateRawOdds projde', () => {
    const v = validate([...events.values()], 'live', Date.now(), 'betx-push');
    expect(v.errors).toEqual([]);
    expect(v.stats.droppedOdds).toBe(0);
  });

  it('podobně vypadající trhy (další gól, zbytek zápasu, evropský handicap) se nemapují', () => {
    for (const bt of ['6_13', '6_4', '4_-1', '7_34', '8_1523']) {
      expect(pushUofKey(388, bt, '1', null)).toBeUndefined();
      expect(pushUofKey(398, bt, '1', '0:1')).toBeUndefined();
    }
    // stejný zápas, BasicOffer přeznačený na "další gól" -> žádné 1X2
    const conns = mkConns();
    const c = conns.find((x) => x.sid === 388)!;
    const it = c.items.get(74507942)!;
    c.items.set(74507942, { t: it.t, x: { ...it.x, bo: { ...it.x.bo!, bt: '6_13' }, cofs: it.x.cofs!.map((o) => ({ ...o, bt: '6_4' })) } });
    expect(run(conns).get('74507942')!.markets).toEqual([]);
  });

  it('mrtvé spojení: jeho trhy (ani celý sport bez živého spojení) se nevydávají', () => {
    const noMl = run(mkConns(), new Set(), (c) => c.bt !== '7_106');
    expect(noMl.get('72123356')!.markets.map((m) => m.key).sort()).toEqual(['1X2|REG', 'OU|REG|6.5']);
    expect(run(mkConns(), new Set(), (c) => c.sid !== 398).has('72123356')).toBe(false);
  });

  it('liveStatus 0 -> vše zavřené; typ vyřazený kontrolou -> vynechán; zápas bez statických dat -> vynechán', () => {
    const conns = mkConns();
    conns.filter((c) => c.sid === 389).forEach((c) => (c.live = false));
    expect(run(conns).get('75048490')!.markets.every((m) => !m.open)).toBe(true);
    expect(run(mkConns(), new Set(['398|7_106'])).get('72123356')!.markets.some((m) => m.key === 'ML|MATCH')).toBe(false);
    const only = new Map([...statics].filter(([id]) => id !== 74507942));
    expect(parseBetxMatches(pushSnapshot(only, mkConns(), new Set(), () => true), { live: true }).some((e) => e.sourceId === '74507942')).toBe(false);
  });
});

describe('betx / push tabulka odpovídá UofKey v live listingu', async () => {
  const f = await loadFixture<{ matches: BetxMatch[] }>('betx', 'betx-live-uofkeys.json');

  it('pokrývá všechny typy z PUSH_BET_TYPES a checkPushTable nic nenajde', () => {
    const covered = new Set(f.matches.flatMap((m) => [m.BasicOffer, ...(m.Offers ?? [])].filter(Boolean).map((o) => `${m.SportId}|${o!.BetTypeKey}`)));
    for (const k of Object.keys(PUSH_BET_TYPES)) expect(covered.has(k), k).toBe(true);
    expect(checkPushTable(f.matches)).toEqual([]);
  });

  it('trhy z push UofKey (bt + OrigName + Sbv) jsou totožné s trhy ze skutečných UofKey', () => {
    const viaPush = f.matches.map((m) => ({
      ...m,
      BasicOffer: m.BasicOffer && { ...m.BasicOffer, Odds: m.BasicOffer.Odds!.map((o) => ({ ...o, UofKey: pushUofKey(m.SportId, m.BasicOffer!.BetTypeKey, o.OrigName, m.BasicOffer!.Sbv) })) },
      Offers: (m.Offers ?? []).map((of) => ({ ...of, Odds: of.Odds!.map((o) => ({ ...o, UofKey: pushUofKey(m.SportId, of.BetTypeKey, o.OrigName, of.Sbv) })) })),
    }));
    const strip = (evs: ReturnType<typeof parseBetxMatches>) => evs.map((e) => e.markets.map((m) => ({ key: m.key, open: m.open, sels: m.selections.map((s) => [s.key, s.odds, s.open]) })));
    const real = strip(parseBetxMatches(f.matches, { live: true }));
    expect(real.flat().length).toBeGreaterThan(30);
    expect(strip(parseBetxMatches(viaPush, { live: true }))).toEqual(real);
  });

  it('nesouhlasící UofKey (jiný trh / navíc specifikátor) typ vyřadí', () => {
    const tamper = (k: string, fn: (u: string) => string) =>
      f.matches.map((m) => ({
        ...m,
        Offers: (m.Offers ?? []).map((of) => (`${m.SportId}|${of.BetTypeKey}` === k ? { ...of, Odds: of.Odds!.map((o) => ({ ...o, UofKey: fn(o.UofKey!) })) } : of)),
      }));
    expect(checkPushTable(tamper('398|7_106', (u) => u.replace('/406/', '/1/')))).toEqual(['398|7_106']);
    expect(checkPushTable(tamper('388|5_-1', (u) => `${u}&score=0:1`))).toEqual(['388|5_-1']);
  });
});

describe('betx / další stavy z překladové tabulky (LB_*)', () => {
  const m = (x: Partial<BetxMatch>) => ({ Id: 1, MatchStartTime: '2026-09-30T18:00:00Z', SportId: 391, ...x }) as BetxMatch;
  it('basket: přestávka mezi čtvrtinami (PAUSE1..3, AWAITING_OT), konec po prodloužení', () => {
    expect(betxState(m({ LiveMatchTimeOrigName: 'LB_BASKETBALL_PAUSE1', LiveMatchTime: '10', LiveSetScore: '20 : 18' }), 'basketball')).toMatchObject({ breakFlag: true, period: 1, clockSec: 600 });
    expect(betxState(m({ LiveMatchTimeOrigName: 'LB_BASKETBALL_AWAITING_OT', LiveMatchTimeState: 'přestávka' }), 'basketball').breakFlag).toBe(true);
    const aot = betxState(m({ LiveMatchTimeOrigName: 'LB_BASKETBALL_AFTER_OT', LiveMatchTimeState: 'konec', LiveMatchTime: '45' }), 'basketball');
    expect(aot).toMatchObject({ finished: true });
    expect(aot.breakFlag).toBeUndefined();
    expect(aot.clockSec).toBeUndefined();
  });
  it('tenis: skreč / bez boje = konec; LiveMatchState 2 = konec', () => {
    expect(betxState(m({ SportId: 389, LiveMatchTimeOrigName: 'LB_TENNIS_RETIRED', LiveMatchTimeState: 'skreč' }), 'tennis').finished).toBe(true);
    expect(betxState(m({ SportId: 389, LiveMatchTimeOrigName: 'LB_TENNIS_WALKOVER' }), 'tennis').finished).toBe(true);
    expect(betxState(m({ SportId: 388, LiveMatchState: 2, LiveMatchTimeOrigName: 'LB_SOCCER_2P' }), 'football').finished).toBe(true);
  });
  it('IsLiveMatchAvailable=false (web zápas v live skrývá) -> trhy zavřené', () => {
    const ev = parseBetxMatches(
      [m({ SportId: 388, TeamHome: 'A', TeamAway: 'B', IsLiveMatchAvailable: false, BasicOffer: { Odds: [{ Odd: 2, UofKey: 'uof:1/sr:sport:1/1/1' }] } })],
      { live: true },
    );
    expect(ev[0].markets[0].open).toBe(false);
  });
});
