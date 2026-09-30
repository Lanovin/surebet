import { describe, expect, it } from 'vitest';
import { loadFixture } from '../fixtures.js';
import { validateRawOdds } from '../../core/validate.js';
import { isValidMarketKey, parseMarketKey } from '../../core/markets.js';
import type { RawEvent, RawOdds, Sport } from '../../core/types.js';
import type { ApiEnvelope } from './api.js';
import { LIVE_SNAPSHOT_MS, marketsBody, SnapshotClock, wcfDate } from './api.js';
import { decodeEventsResponse } from './proto.js';
import type { SynLiveEvent, SynLiveResponse } from './parse.js';
import { gameTypeId, mapGame, parseLive, parsePrematch, parseState, parseWcfDate, PREMATCH_GAME_IDS, splitName } from './parse.js';

// fixtures/synot/meta.json: recordedAt 2026-09-29T15:31:00.500Z
const NOW = 1790695860500;
const SPORTS: Sport[] = ['football', 'hockey', 'tennis', 'basketball'];
const odds = (events: RawEvent[], scope: 'prematch' | 'live'): RawOdds => ({ bookmaker: 'synot', strategy: 'ebet-api', scope, fetchedAt: NOW, events });
const mk = (e: RawEvent, key: string) => e.markets.find((m) => m.key === key);
const price = (e: RawEvent, key: string, sel: string) => mk(e, key)?.selections.find((s) => s.key === sel)?.odds;

describe('synot prematch (ebet-api / browser-fetch: GetWebStandardEvents, protobuf)', async () => {
  const responses = [];
  for (const s of SPORTS) {
    for (const kind of ['main', 'markets']) {
      const env = await loadFixture<ApiEnvelope<string>>('synot', `prematch-${kind}-${s}.json`);
      expect(env.Result).toBe(1);
      responses.push(decodeEventsResponse(env.ReturnValue!));
    }
  }
  const events = parsePrematch(responses, { now: NOW });
  const byId = (id: string) => events.find((e) => e.sourceId === id)!;

  it('decodes and parses all four sports and validates', () => {
    const by: Record<string, number> = {};
    for (const e of events) by[e.sport] = (by[e.sport] ?? 0) + 1;
    expect(events.length).toBe(1055); // 11 událostí bez jediného trhu se zahazuje
    expect(by).toEqual({ football: 687, hockey: 133, tennis: 116, basketball: 119 });
    expect(events.every((e) => !e.live && !e.state && e.startTime > NOW)).toBe(true);
    expect(new Set(events.map((e) => e.sourceId)).size).toBe(events.length);
    const v = validateRawOdds(odds(events, 'prematch'), { minEvents: 5, maxAgeMs: 60_000, now: NOW });
    expect(v.ok).toBe(true);
    for (const e of events) for (const m of e.markets) expect(isValidMarketKey(m.key)).toBe(true);
  });

  it('football: Česko – Anglie (main listing + GameIds markets merged)', () => {
    const e = byId('3783258');
    expect([e.home, e.away]).toEqual(['Česko', 'Anglie']);
    expect(e.competition).toBe('Liga národů UEFA');
    expect(e.country).toBe('Mezinárodní');
    expect(e.startTime).toBe(Date.parse('2026-09-29T18:45:00Z'));
    expect(e.url).toBe('https://sport.synottip.cz/zapas/3783258');
    // float32 z protobufu (9.869999885) → 2 desetinná místa
    expect(price(e, '1X2|REG', 'HOME')).toBe(9.87);
    expect(price(e, '1X2|REG', 'DRAW')).toBe(5.98);
    expect(price(e, '1X2|REG', 'AWAY')).toBe(1.31);
    expect(price(e, 'DNB|REG', 'HOME')).toBe(6.85);
    expect(price(e, 'OU|REG|2.5', 'OVER')).toBe(1.56);
    expect(price(e, 'OU|REG|2.5', 'UNDER')).toBe(2.45);
    // "Tým 1 (+1.5)" / "Tým 2 (-1.5)" → linie z pohledu domácích +1.5
    expect(price(e, 'AH|REG|1.5', 'HOME')).toBe(1.98);
    expect(price(e, 'AH|REG|1.5', 'AWAY')).toBe(1.83);
    expect(price(e, 'AH|REG|0', 'HOME')).toBe(7.14);
    expect(price(e, 'OU_AWAY|REG|2.5', 'OVER')).toBe(2.1);
    expect(price(e, '1X2|H1', 'DRAW')).toBe(2.79);
    expect(price(e, 'OU|H2|1.5', 'UNDER')).toBe(1.94);
    for (const m of e.markets) {
      const p = parseMarketKey(m.key);
      expect(['REG', 'H1', 'H2']).toContain(p.scope);
      if (p.line !== undefined) expect(Math.abs(p.line * 2 - Math.round(p.line * 2))).toBeLessThan(1e-9); // žádné .25/.75
    }
  });

  it('hockey: regular time vs. incl. OT & shootout, periods', () => {
    const e = byId('3834120');
    expect([e.home, e.away]).toEqual(['HC Prešov', 'Dukla Michalovce']);
    expect(e.country).toBe('Slovensko');
    expect(e.competition).toBe('Extraliga');
    expect(price(e, '1X2|REG', 'DRAW')).toBe(4.26);
    expect(price(e, 'ML|MATCH', 'HOME')).toBe(2.19);
    expect(price(e, 'ML|MATCH', 'AWAY')).toBe(1.66);
    expect(price(e, 'AH|REG|-1.5', 'HOME')).toBe(4.24);
    expect(price(e, 'AH|MATCH|-1.5', 'HOME')).toBe(3.96);
    expect(price(e, 'OU|REG|2.5', 'OVER')).toBe(1.07);
    expect(price(e, 'OU|MATCH|2.5', 'OVER')).toBe(1.03);
    expect(price(e, '1X2|P2', 'HOME')).toBe(3.04);
    expect(price(e, 'DNB|P3', 'AWAY')).toBe(1.65);
    expect(price(e, 'OU|P1|1.5', 'UNDER')).toBe(1.79);
    for (const m of e.markets) {
      const matchScope = parseMarketKey(m.key).scope === 'MATCH';
      expect(/prodl|nájezd/i.test(m.rawName ?? '')).toBe(matchScope);
    }
  });

  it('tennis: sets handicap orientation, set markets, number of sets', () => {
    const e = byId('3853160');
    expect([e.home, e.away]).toEqual(['Joint, Maya', 'Kraus, Sinja']);
    expect(e.competition).toBe('Beijing (CHN, tvrdý p.)');
    expect(price(e, 'ML|MATCH', 'HOME')).toBe(1.31);
    // detail "Tým 1 (+1.5)" / "Tým 2 (-1.5)" i "Tým 1 (-1.5)" / "Tým 2 (+1.5)" → dvě linie
    expect(price(e, 'AH_SETS|MATCH|-1.5', 'HOME')).toBe(1.72);
    expect(price(e, 'AH_SETS|MATCH|1.5', 'HOME')).toBe(1.11);
    expect(price(e, 'AH_SETS|MATCH|1.5', 'AWAY')).toBe(4.8);
    expect(price(e, 'OU_SETS|MATCH|2.5', 'OVER')).toBe(2.63);
    expect(price(e, 'ML|S2', 'AWAY')).toBe(2.87);
    expect(price(e, 'OU|S1|9.5', 'OVER')).toBe(2.16);
    expect(price(e, 'AH|S1|-2.5', 'AWAY')).toBe(1.62);
  });

  it('basketball: ML incl. OT, quarters, 1st half; 2nd half and Q4 skipped', () => {
    const e = byId('3828511');
    expect([e.home, e.away]).toEqual(['Dubai Basketball', 'Barcelona']);
    expect(e.competition).toBe('Euroliga');
    expect(price(e, 'ML|MATCH', 'HOME')).toBe(1.31);
    expect(price(e, 'AH|MATCH|-1.5', 'AWAY')).toBe(3.1);
    expect(price(e, '1X2|Q1', 'DRAW')).toBe(15.2);
    expect(price(e, 'DNB|Q3', 'HOME')).toBe(1.52);
    expect(price(e, '1X2|H1', 'AWAY')).toBe(2.66);
    const scopes = new Set(events.filter((x) => x.sport === 'basketball').flatMap((x) => x.markets.map((m) => parseMarketKey(m.key).scope)));
    expect(scopes.has('H2')).toBe(false);
    expect(scopes.has('Q4')).toBe(false);
    expect(scopes.has('REG')).toBe(false); // prematch nabídka 1X2 základní doby nevypisuje
  });
});

describe('synot live – starší endpoint GetLIPEvtsDsk (stejný tvar JSON)', async () => {
  const live = await loadFixture<SynLiveResponse>('synot', 'live.json');
  const events = parseLive(live, { now: NOW });
  const byId = (id: string) => events.find((e) => e.sourceId === id)!;

  it('parses live events of all supported sports and validates', () => {
    const by: Record<string, number> = {};
    for (const e of events) by[e.sport] = (by[e.sport] ?? 0) + 1;
    // od přidání dalších sportů parsuje i házenou, volejbal, stolní tenis a snooker
    expect(by).toEqual({ football: 12, hockey: 18, tennis: 19, basketball: 5, handball: 2, volleyball: 1, table_tennis: 11, snooker: 1 });
    expect(events.every((e) => e.state)).toBe(true);
    // "Nezačalo" = v live nabídce, ale ještě se nehraje → live: false
    expect(events.every((e) => e.live === (e.state?.statusText !== 'Nezačalo'))).toBe(true);
    expect(events.some((e) => !e.live)).toBe(true);
    const v = validateRawOdds(odds(events, 'live'), { minEvents: 1, maxAgeMs: 60_000, now: NOW });
    expect(v.ok).toBe(true);
    const keys = new Set(events.flatMap((e) => e.markets.map((m) => m.key)));
    expect([...keys].sort()).toEqual(['1X2|REG', 'ML|MATCH']);
  });

  it('football half-time: breakFlag from "Poločas", period + score from Results', () => {
    const e = byId('3848852');
    expect([e.home, e.away]).toEqual(['FC Slovan Rosice', 'Boskovice']);
    expect(e.url).toBe('https://sport.synottip.cz/live/live-zapas/3848852');
    expect(e.state).toEqual({ statusText: 'Poločas', score: [0, 0], periodScores: [[0, 0]], period: 1, breakFlag: true, clockRunning: false });
    expect(price(e, '1X2|REG', 'HOME')).toBe(2.84);
    expect(price(e, '1X2|REG', 'DRAW')).toBe(3.06);
  });

  it('hockey intermission: "Přestávka" after 2nd period', () => {
    const e = byId('3783116');
    expect(e.state).toMatchObject({ statusText: 'Přestávka', period: 2, breakFlag: true, clockRunning: false, score: [1, 2], periodScores: [[0, 1], [1, 1]] });
  });

  it('basketball clock: StateTime = elapsed, RemainingPeriodTime, ClockStopped; ML incl. OT + 1X2 regular time', () => {
    const e = byId('3848865');
    expect(e.state).toMatchObject({ statusText: '2. čtvrtina', period: 2, clockSec: 936, periodRemainingSec: 264, clockRunning: false, score: [37, 26] });
    expect(price(e, 'ML|MATCH', 'HOME')).toBe(1.33);
    expect(price(e, '1X2|REG', 'DRAW')).toBe(11.95);
  });

  it('tennis: sets, games in current set, points; finished and suspended matches', () => {
    const e = byId('3850530');
    expect(e.state).toEqual({ statusText: '2. set', score: [1, 0], periodScores: [[7, 6], [2, 3]], period: 2, games: [2, 3], points: '15:15' });
    expect(price(e, 'ML|MATCH', 'HOME')).toBe(1.48);
    const done = byId('3854409');
    expect(done.state).toMatchObject({ statusText: 'Ukončeno', finished: true });
    expect(done.markets).toEqual([]);
    // "Přerušeno": výběr 1 má Rate 0 (State 3) → trh bez kurzu vynechán
    const stopped = byId('3851942');
    expect(stopped.state).toMatchObject({ statusText: 'Přerušeno', clockRunning: false });
    expect(stopped.state?.breakFlag).toBeUndefined();
    expect(stopped.markets).toEqual([]);
  });

  it('older snapshot with more breaks parses too', async () => {
    const older = parseLive(await loadFixture<SynLiveResponse>('synot', 'live-breaks.json'), { now: NOW });
    expect(older.length).toBe(55);
    expect(older.filter((e) => e.state?.breakFlag).map((e) => e.sport).sort()).toEqual(['football', 'football', 'football', 'handball', 'hockey']);
  });
});

interface WlFixture extends SynLiveResponse {
  recordedAt: string;
  requestStart: number;
  responseEnd: number;
}

describe('synot live (ebet-api: GetLiveEventsWL = live stránka webu)', async () => {
  // výřez skutečné odpovědi 30. 9. 2026 21:49:57 (17 událostí), token vynulován
  const fx = await loadFixture<WlFixture>('synot', 'live-wl.json');
  const events = parseLive(fx, { now: fx.responseEnd });
  const byId = (id: string) => events.find((e) => e.sourceId === id)!;

  it('ISO dates, all four sports, validates; OU/AH/sets present, replacement markets absent', () => {
    expect(events.length).toBe(17);
    expect(new Set(events.map((e) => e.sport))).toEqual(new Set(['football', 'hockey', 'tennis', 'basketball']));
    const v = validateRawOdds({ ...odds(events, 'live'), fetchedAt: fx.responseEnd }, { minEvents: 1, maxAgeMs: 60_000, now: fx.responseEnd });
    expect(v.ok).toBe(true);
    expect(v.stats.droppedOdds).toBe(0);
    const keys = new Set(events.flatMap((e) => e.markets.map((m) => m.key.split('|').slice(0, 2).join('|'))));
    expect([...keys].sort()).toEqual(['1X2|REG', 'AH|MATCH', 'AH|REG', 'ML|MATCH', 'ML|S1', 'ML|S2', 'OU_HOME|REG', 'OU|MATCH', 'OU|REG', 'OU|S1']);
    // live `Date` = plánovaný začátek (výkop 20:45 SELČ), ISO s posunem
    expect(byId('3853986').startTime).toBe(Date.parse('2026-09-30T18:45:00Z'));
  });

  it('football: full-match 1X2 / OU / AH incl. line 0 (web: 4,04 2,89 1,94 | Pod 2.5 4,70 | Tým 1 (0) 2,69)', () => {
    const e = byId('3853986');
    expect([e.home, e.away]).toEqual(['AFC Whyteleafe', 'Brentwood Town FC']);
    expect(e.state).toMatchObject({ statusText: 'Poločas', score: [1, 1], breakFlag: true, period: 1 });
    expect(price(e, '1X2|REG', 'HOME')).toBe(4.04);
    expect(price(e, '1X2|REG', 'DRAW')).toBe(2.89);
    expect(price(e, '1X2|REG', 'AWAY')).toBe(1.94);
    expect(price(e, 'OU|REG|2.5', 'UNDER')).toBe(4.7);
    expect(price(e, 'OU|REG|2.5', 'OVER')).toBe(1.11);
    // AH na celý zápas (góly už padlé se počítají): při 1:1 musí domácí vyhrát → 2.69
    expect(price(e, 'AH|REG|0', 'HOME')).toBe(2.69);
    expect(price(e, 'AH|REG|0', 'AWAY')).toBe(1.36);
    // celá čísla linií zůstávají (asijský handicap s vrácením)
    expect(price(byId('3844566'), 'AH|REG|-1', 'HOME')).toBe(5.52);
    expect(price(byId('3856021'), 'AH|REG|-7', 'HOME')).toBe(4.57);
  });

  it('replacement / locked markets: "zbytek zápasu" (365) skipped, Rate 0 → line omitted, x.25 omitted, team total mapped', () => {
    // FAS 6:0: v "Hlavní sázky" místo Zápasu "Který tým vyhraje zbytek zápasu od skóre 5:0" (typ 365)
    const fas = byId('3856021');
    expect(fas.markets.map((m) => m.key)).toEqual(['OU|REG|6.5', 'AH|REG|-7']);
    // Portugalsko U21: 1 zamčený (Rate 0) → Zápas vynechán; "Pod (4.25)" čtvrtinová linie vynechána
    expect(byId('3813523').markets.map((m) => m.key)).toEqual(['AH|REG|-6.5']);
    // West Ham: skupina Góly nese "Tým1 celkový počet gólů" (80) → OU_HOME, Zápas se zamčeným favoritem vynechán
    const wh = byId('3855878');
    expect(wh.markets.map((m) => m.key)).toEqual(['OU_HOME|REG|3.5']);
    expect(price(wh, 'OU_HOME|REG|3.5', 'OVER')).toBe(4.32);
    // tenis Chodur: "2" Rate 0 → vítěz i set vynechány
    expect(byId('3848353').markets).toEqual([]);
  });

  it('event State 3 (Suspended) is not "finished"; only "Ukončeno" is', () => {
    // Middlesbrough: State 3 v 90:00 (nastavení, sázky zastaveny) → hraje se dál
    const mb = byId('3856432');
    expect(mb.state?.finished).toBeUndefined();
    expect(mb.live).toBe(true);
    expect(mb.markets).toEqual([]);
    // basket 4. čtvrtina 2:10 před koncem, State 3 → nekončí
    expect(byId('3853077').state).toMatchObject({ statusText: '4. čtvrtina', period: 4, clockSec: 2270, periodRemainingSec: 130 });
    expect(byId('3853077').state?.finished).toBeUndefined();
    expect(byId('3857157').state).toMatchObject({ statusText: 'Ukončeno', finished: true });
    expect(byId('3852064').state).toMatchObject({ statusText: 'Ukončeno', finished: true });
  });

  it('tennis: winner, set winner, games totals (whole match / set); basketball incl. OT markets + clock', () => {
    const t = byId('3840842');
    expect(t.state).toEqual({ statusText: '2. set', score: [0, 1], periodScores: [[3, 6], [5, 5]], period: 2, games: [5, 5], points: '0:0' });
    expect(price(t, 'ML|MATCH', 'HOME')).toBe(8.47);
    expect(price(t, 'ML|S2', 'AWAY')).toBe(1.25);
    expect(price(t, 'OU|MATCH|21.5', 'OVER')).toBe(1.46);
    expect(price(byId('3852054'), 'OU|S1|10.5', 'UNDER')).toBe(2.18);
    const b = byId('3785232');
    expect(b.state).toMatchObject({ statusText: '2. čtvrtina', period: 2, clockSec: 1044, periodRemainingSec: 156, clockRunning: false, score: [37, 32] });
    expect(price(b, 'ML|MATCH', 'HOME')).toBe(1.33);
    expect(price(b, 'AH|MATCH|-9.5', 'HOME')).toBe(2.92);
    expect(price(b, 'OU|MATCH|157.5', 'OVER')).toBe(1.46);
    // Napoli: přestávka po 3. čtvrtině, vítěz se zamčeným favoritem vynechán, handicap/body zůstávají
    const n = byId('3853623');
    expect(n.state).toMatchObject({ statusText: 'Přestávka', period: 3, breakFlag: true });
    expect(n.markets.map((m) => m.key)).toEqual(['OU|MATCH|153.5', 'AH|MATCH|-18.5']);
  });
});

describe('synot live – sequences (hockey intermission, State 3 with 3 min left, not started)', async () => {
  const seq = await loadFixture<(SynLiveResponse & { t: number })[]>('synot', 'live-wl-sequence.json');
  const [s0, s1, s2] = seq.map((s) => parseLive(s, { now: s.t }));
  const find = (evs: RawEvent[], id: string) => evs.find((e) => e.sourceId === id)!;

  it('hockey intermission with REG markets; "Nezačalo" → live false', () => {
    const l = find(s0, '3785233');
    expect(l.state).toMatchObject({ statusText: 'Přestávka', period: 2, breakFlag: true, score: [2, 4] });
    expect(price(l, '1X2|REG', 'HOME')).toBe(45.05);
    expect(price(l, 'OU|REG|6.5', 'OVER')).toBe(1.08);
    expect(price(l, 'AH|REG|0.5', 'HOME')).toBe(6.59);
    const ns = find(s0, '3848721');
    expect(ns.state?.statusText).toBe('Nezačalo');
    expect(ns.live).toBe(false);
    expect(price(ns, 'ML|MATCH', 'HOME')).toBe(1.07);
  });

  it('hockey 3 min before end: State 2 with markets → State 3 without markets, still live and not finished', () => {
    const a = find(s1, '3855866');
    expect(a.markets.map((m) => m.key)).toEqual(['1X2|REG', 'OU|REG|5.5', 'AH|REG|-1.5']);
    const b = find(s2, '3855866');
    expect(b.markets).toEqual([]);
    expect(b.live).toBe(true);
    expect(b.state).toMatchObject({ statusText: '3. třetina', clockSec: 3420, periodRemainingSec: 180 });
    expect(b.state?.finished).toBeUndefined();
  });
});

describe('synot suspension & state semantics', () => {
  const game = { ID: '2d1', Name: 'Zápas', State: 2, Details: [{ ID: 1, State: 2, OddsList: [{ Name: '1', Rate: 2.1, State: 2 }, { Name: '0', Rate: 3.2, State: 2 }, { Name: '2', Rate: 3.5, State: 2 }] }] };

  it('event-level Suspended/Closed and game-level state close the markets', () => {
    expect(mapGame('football', game)[0].open).toBe(true);
    expect(mapGame('football', game, false)[0].open).toBe(false);
    expect(mapGame('football', { ...game, State: 3 })[0].open).toBe(false);
    const ev = (State: number): SynLiveResponse => ({
      Result: 1,
      ReturnValue: [{ DisciplineID: 12, Events: [{ ID: 1, Name: 'A - B', Date: '2026-09-30T20:45:00+02:00', State, StateName: '1. poločas', GameGroups: [{ Games: [game] }] }] }],
    });
    expect(parseLive(ev(2), { now: NOW })[0].markets[0].open).toBe(true);
    expect(parseLive(ev(3), { now: NOW })[0].markets[0].open).toBe(false);
    expect(parseLive(ev(4), { now: NOW })[0].markets[0].open).toBe(false);
  });

  it('finished only from text; waiting for OT is a break; OT has no period', () => {
    const st = (StateName: string, State = 3, sport: Sport = 'hockey') => parseState({ ID: 1, Name: 'A - B', Date: '', State, StateName } as SynLiveEvent, sport);
    expect(st('2. poločas', 3, 'football').finished).toBeUndefined();
    expect(st('Prodloužení').finished).toBeUndefined();
    expect(st('Prodloužení').period).toBeUndefined();
    expect(st('1. prodloužení', 2, 'basketball').period).toBeUndefined();
    expect(st('Čekání na prodloužení')).toMatchObject({ breakFlag: true, clockRunning: false });
    expect(st('Čekání na prodloužení').finished).toBeUndefined();
    expect(st('Po prodloužení').finished).toBe(true);
    expect(st('Po sam. nájezdech').finished).toBe(true);
    expect(st('Ukončeno').finished).toBe(true);
    expect(st('Nezačalo', 3, 'tennis').finished).toBeUndefined();
  });
});

describe('synot live snapshot clock (fetchedAt)', () => {
  // server: snapshot každých ~1030 ms, TimeStamp = 100ns tiky; posun hodin uzlu C
  const C = 1_790_000_000_000;
  const ts = (gen: number) => (gen - C) * 10_000;

  it('conservative until calibrated, then ≈ generation time; same snapshot keeps its time', () => {
    const clock = new SnapshotClock();
    let gen = C + 5_000_000;
    const out: number[] = [];
    for (let i = 0; i < 20; i++) {
      gen += 1030;
      const t0 = gen + ((i * 97) % 1000); // dotaz v náhodné fázi
      const t1 = t0 + 60;
      out.push(clock.generatedAt(ts(gen), t0, t1) - gen);
      if (i < 9) expect(out[i]).toBeLessThanOrEqual(t0 - LIVE_SNAPSHOT_MS - gen);
    }
    // po kalibraci chyba jen desítky ms (nejkratší pozorované zpoždění 60 ms + prosakování 2 ms/vzorek)
    for (const d of out.slice(12)) expect(Math.abs(d)).toBeLessThanOrEqual(120);
    // opakovaný dotaz na stejný snapshot nesmí data "omladit"
    const again = clock.generatedAt(ts(gen), gen + 900, gen + 950);
    expect(again).toBe(out[19] + gen);
  });

  it('node switch (other TimeStamp base) recalibrates; missing TimeStamp → t0 − snapshot period', () => {
    const clock = new SnapshotClock();
    let gen = C + 1_000_000;
    for (let i = 0; i < 15; i++) clock.generatedAt(ts((gen += 1030)), gen + 200, gen + 260);
    // jiný uzel: báze tiků o 214 s větší → offset o 214 s menší → okamžitá nová kalibrace (konzervativně)
    gen += 1030;
    const r = clock.generatedAt(ts(gen) + 214_000 * 10_000, gen + 200, gen + 260);
    expect(r).toBe(gen + 200 - LIVE_SNAPSHOT_MS);
    // uzel s menší bází (offset o 214 s větší): nejednoznačné → konzervativně, nikdy "214 s staré"
    const clock2 = new SnapshotClock();
    let g2 = C + 2_000_000;
    for (let i = 0; i < 15; i++) clock2.generatedAt(ts((g2 += 1030)), g2 + 200, g2 + 260);
    g2 += 1030;
    expect(clock2.generatedAt(ts(g2) - 214_000 * 10_000, g2 + 200, g2 + 260)).toBe(g2 + 200 - LIVE_SNAPSHOT_MS);
    expect(new SnapshotClock().generatedAt(undefined, 10_000, 10_100)).toBe(10_000 - LIVE_SNAPSHOT_MS);
  });
});

describe('synot helpers', () => {
  it('game type id, names, dates', () => {
    expect(gameTypeId('233d462443661')).toBe(233);
    expect(gameTypeId('79')).toBe(79);
    expect(gameTypeId('x')).toBeUndefined();
    expect(splitName('Khachanov, Karen - Auger Aliassime, Felix')).toEqual(['Khachanov, Karen', 'Auger Aliassime, Felix']);
    expect(splitName('A - B - C')).toBeNull();
    expect(splitName('Vítěz Ligy mistrů')).toBeNull();
    expect(parseWcfDate('/Date(1790690400000+0200)/')).toBe(1790690400000);
    expect(parseWcfDate('2026-09-30T20:45:00+02:00')).toBe(Date.parse('2026-09-30T18:45:00Z'));
    expect(parseWcfDate('30.9.2026')).toBeUndefined();
    expect(wcfDate(1790690400000)).toBe('/Date(1790690400000)/');
    expect(marketsBody('t', 'hockey', [79], 0, 1)).toMatchObject({ CategoryID: '14', GameIds: [79], From: '/Date(0)/', To: '/Date(1)/' });
    expect(PREMATCH_GAME_IDS.football).not.toContain(2);
    expect(PREMATCH_GAME_IDS.basketball).not.toContain(251);
  });

  it('mapGame: quarter lines, unknown selections, OT guard, suspended lines', () => {
    const ou = mapGame('football', {
      ID: '79',
      Name: 'Celkový počet gólů',
      Details: [
        { ID: 1, OddsList: [{ Name: 'Pod (2.5)', Rate: 2.0999999 }, { Name: 'Nad (2.5)', Rate: 1.75 }] },
        { ID: 2, OddsList: [{ Name: 'Pod (2.75)', Rate: 1.9 }, { Name: 'Nad (2.75)', Rate: 1.9 }] },
        { ID: 3, State: 3, OddsList: [{ Name: 'Pod (3.5)', Rate: 1.4, State: 3 }, { Name: 'Nad (3.5)', Rate: 2.8, State: 3 }] },
      ],
    });
    expect(ou.map((m) => [m.key, m.open, m.selections.map((s) => s.odds)])).toEqual([
      ['OU|REG|2.5', true, [2.1, 1.75]],
      ['OU|REG|3.5', false, [1.4, 2.8]],
    ]);
    // hokej: "Celkový počet gólů" = základní doba; varianta s prodloužením pod jiným ID
    expect(mapGame('hockey', { ID: '79', Name: 'Celkový počet gólů (včetně prodloužení)', Details: [] })).toEqual([]);
    expect(mapGame('hockey', { ID: '228d1', Name: 'Vítěz', Details: [{ OddsList: [{ Name: '1', Rate: 2 }, { Name: '2', Rate: 2 }] }] })).toEqual([]);
    // nezlomitelná mezera v názvu výběru
    const ah = mapGame('hockey', { ID: '7', Name: 'Handicap', Details: [{ ID: 9, OddsList: [{ Name: 'Tým 1 (-1.5)', Rate: 2.5 }, { Name: 'Tým 2 (+1.5)', Rate: 1.5 }] }] });
    expect(ah.map((m) => m.key)).toEqual(['AH|REG|-1.5']);
    // 3-cestný evropský handicap (ID 5) se nemapuje
    expect(mapGame('football', { ID: '5d1', Name: 'Handicap 0:1', Details: [{ OddsList: [{ Name: 'Tým 1', Rate: 2 }, { Name: 'Remíza', Rate: 3 }, { Name: 'Tým 2', Rate: 3 }] }] })).toEqual([]);
  });
});
