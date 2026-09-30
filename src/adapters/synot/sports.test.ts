// Synot: dvojtip (DC) a další sporty (házená, volejbal, stolní tenis, baseball, americký fotbal, MMA, box,
// snooker, šipky). Fixtures jsou zkrácené skutečné odpovědi z 1. 10. 2026 (~00:40 CEST):
//  - prematch-newsports.json: GetWebStandardEvents (protobuf, přeložený zpět do base64), vybrané zápasy
//    + trhy typů z RULES + pár nemapovaných typů, které se musí zahodit
//  - live-wl-newsports.json: GetLiveEventsWL, volejbal / stolní tenis / baseball (kompozit z pár snímků večera)
import { describe, expect, it } from 'vitest';
import { loadFixture } from '../fixtures.js';
import { validateRawOdds } from '../../core/validate.js';
import { isValidMarketKey, parseMarketKey } from '../../core/markets.js';
import type { RawEvent, RawOdds, Sport } from '../../core/types.js';
import type { ApiEnvelope } from './api.js';
import { decodeEventsResponse } from './proto.js';
import type { PbEventsResponse } from './proto.js';
import type { SynLiveResponse } from './parse.js';
import { NICHE_SPORTS, parseLive, parsePrematch, PREMATCH_GAME_IDS, prematchGameIds, SPORT_IDS } from './parse.js';
import { SynotCore } from './strategies.js';
import type { Transport } from './api.js';

const NOW = Date.parse('2026-10-01T00:40:00+02:00');
const odds = (events: RawEvent[], scope: 'prematch' | 'live'): RawOdds => ({ bookmaker: 'synot', strategy: 'ebet-api', scope, fetchedAt: NOW, events });
const mk = (e: RawEvent, key: string) => e.markets.find((m) => m.key === key);
const price = (e: RawEvent, key: string, sel: string) => mk(e, key)?.selections.find((s) => s.key === sel)?.odds;
const keysOf = (e: RawEvent) => e.markets.map((m) => m.key);
const types = (e: RawEvent) => new Set(e.markets.map((m) => parseMarketKey(m.key).type));
const scopes = (e: RawEvent) => new Set(e.markets.map((m) => parseMarketKey(m.key).scope));

const env = await loadFixture<ApiEnvelope<string>>('synot', 'prematch-newsports.json');
const response = decodeEventsResponse(env.ReturnValue!);
const events = parsePrematch([response], { now: NOW });
const byId = (id: string) => events.find((e) => e.sourceId === id)!;

describe('synot prematch – dvojtip (DC)', () => {
  it('football: DC|REG, DC|H1, DC|H2 with 10 / 12 / 02 → HOME_DRAW / HOME_AWAY / DRAW_AWAY', () => {
    const e = byId('3852168');
    expect([e.home, e.away]).toEqual(['Ázerbájdžán', 'Lichtenštejnsko']);
    expect(price(e, 'DC|REG', 'HOME_DRAW')).toBe(1.02);
    expect(price(e, 'DC|REG', 'HOME_AWAY')).toBe(1.07);
    expect(price(e, 'DC|REG', 'DRAW_AWAY')).toBe(4.71);
    expect(price(e, 'DC|H1', 'DRAW_AWAY')).toBe(2.24);
    expect(price(e, 'DC|H2', 'HOME_AWAY')).toBe(1.22);
    // dvojtip je konzistentní s 1X2 (1X ≈ P1 + PX): 1/1.02 ≈ 0.98 ≈ 1/1.13 + 1/8.12 + marže
    const p = (k: string, s: string) => 1 / price(e, k, s)!;
    expect(p('DC|REG', 'DRAW_AWAY')).toBeCloseTo(p('1X2|REG', 'DRAW') + p('1X2|REG', 'AWAY'), 0);
    // kombinace "Dvojtip a počet gólů" / "Dvojtip a oba týmy dají gól" (103, 102, 189 …) se nemapují
    expect(e.markets.filter((m) => m.key.startsWith('DC')).map((m) => m.key).sort()).toEqual(['DC|H1', 'DC|H2', 'DC|REG']);
  });

  it('football: Synot nevypisuje výběr s kurzem ≤ 1.00 → dvojtip jen s ostatními výběry', () => {
    const e = byId('3848221');
    const dc = mk(e, 'DC|REG')!;
    expect(dc.selections.map((s) => s.key).sort()).toEqual(['DRAW_AWAY', 'HOME_AWAY']);
    expect(price(e, 'DC|REG', 'HOME_AWAY')).toBe(1.03);
    expect(price(e, 'DC|H1', 'HOME_DRAW')).toBe(1.03);
  });

  it('hockey: DC|REG = 60 minut (ne vč. prodloužení), DC|P1–P3 z názvu třetiny', () => {
    const e = byId('3853059');
    expect(price(e, 'DC|REG', 'HOME_DRAW')).toBe(1.17);
    expect(price(e, 'DC|REG', 'DRAW_AWAY')).toBe(2.05);
    expect(price(e, 'DC|P1', 'HOME_AWAY')).toBe(1.34);
    expect(price(e, 'DC|P2', 'DRAW_AWAY')).toBe(1.65);
    expect(price(e, 'DC|P3', 'HOME_DRAW')).toBe(1.22);
    // DC|REG odpovídá 1X2|REG, ne ML|MATCH: 1/1.17 ≈ 1/1.56 + 1/4.58 (+ marže)
    expect(1 / price(e, 'DC|REG', 'HOME_DRAW')!).toBeCloseTo(1 / price(e, '1X2|REG', 'HOME')! + 1 / price(e, '1X2|REG', 'DRAW')!, 1);
    expect(mk(e, 'ML|MATCH')).toBeDefined();
    expect(mk(e, 'DC|MATCH')).toBeUndefined();
  });

  it('handball: DC|REG, DC|H1, DC|H2', () => {
    const e = byId('3857779');
    expect(price(e, 'DC|REG', 'HOME_DRAW')).toBe(2.29);
    expect(price(e, 'DC|REG', 'HOME_AWAY')).toBe(1.07);
    expect(price(e, 'DC|REG', 'DRAW_AWAY')).toBe(1.27);
    expect(price(e, 'DC|H1', 'HOME_DRAW')).toBe(1.91);
    expect(price(e, 'DC|H2', 'DRAW_AWAY')).toBe(1.32);
    const partial = byId('3857780');
    expect(mk(partial, 'DC|REG')!.selections.map((s) => s.key)).toEqual(['HOME_DRAW', 'DRAW_AWAY']);
  });

  it('DC jen v rozsazích, které mohou skončit remízou; basketbal dvojtip nemá', () => {
    for (const e of events) {
      for (const m of e.markets.filter((x) => x.key.startsWith('DC'))) {
        expect(['REG', 'H1', 'H2', 'P1', 'P2', 'P3']).toContain(parseMarketKey(m.key).scope);
        for (const s of m.selections) expect(['HOME_DRAW', 'HOME_AWAY', 'DRAW_AWAY']).toContain(s.key);
      }
    }
    expect(PREMATCH_GAME_IDS.basketball).not.toContain(3);
    expect(PREMATCH_GAME_IDS.football).toEqual(expect.arrayContaining([3, 13, 124]));
    expect(PREMATCH_GAME_IDS.hockey).toContain(245);
    expect(PREMATCH_GAME_IDS.handball).toEqual(expect.arrayContaining([3, 13, 124]));
  });
});

describe('synot prematch – nové sporty', () => {
  it('parses all eleven sports of the fixture, validates and uses only valid market keys', () => {
    const by: Record<string, number> = {};
    for (const e of events) by[e.sport] = (by[e.sport] ?? 0) + 1;
    expect(by).toEqual({
      football: 3,
      hockey: 2,
      handball: 3,
      volleyball: 1,
      table_tennis: 1,
      baseball: 3,
      snooker: 1,
      darts: 1,
      american_football: 1,
      mma: 1,
      boxing: 1,
    });
    expect(events.every((e) => !e.live && !e.state && e.startTime > NOW && e.markets.length > 0)).toBe(true);
    const v = validateRawOdds(odds(events, 'prematch'), { minEvents: 5, maxAgeMs: 60_000, now: NOW });
    expect(v.ok).toBe(true);
    for (const e of events) for (const m of e.markets) expect(isValidMarketKey(m.key)).toBe(true);
  });

  it('handball: 1X2/DNB/OU/AH/OE/team totals, halves; margin-type markets skipped', () => {
    const e = byId('3857779');
    expect([e.home, e.away]).toEqual(['Zamalek', 'Al Ahli SC (EGY)']);
    expect(e.competition).toBe('Mistrovství světa klubů');
    expect(price(e, '1X2|REG', 'HOME')).toBe(3.28);
    expect(price(e, '1X2|REG', 'DRAW')).toBe(9.49);
    expect(price(e, 'DNB|REG', 'AWAY')).toBe(1.34);
    expect(price(e, 'OU|REG|55.5', 'OVER')).toBe(1.85);
    expect(price(e, 'OE|REG', 'ODD')).toBe(1.86);
    const l = byId('3822960');
    // "Tým 1 (-4.5)" / "Tým 2 (+4.5)" → linie domácích -4.5
    expect(price(l, 'AH|REG|-4.5', 'HOME')).toBe(2.39);
    expect(price(l, 'AH|REG|-4.5', 'AWAY')).toBe(1.53);
    expect(price(l, 'OU_HOME|REG|30.5', 'UNDER')).toBe(2.38);
    expect(price(l, 'OU_AWAY|REG|27.5', 'OVER')).toBe(1.51);
    expect(price(l, '1X2|H1', 'AWAY')).toBe(3.14);
    expect(price(l, 'OU|H1|29.5', 'UNDER')).toBe(1.81);
    expect(price(l, 'OE|H2', 'EVEN')).toBe(1.86);
    // žádné prodloužení: vše REG / H1 / H2, nikdy MATCH
    expect(scopes(l)).toEqual(new Set(['REG', 'H1', 'H2']));
    // "Vítězný rozdíl", "1x2 a celkový počet gólů", "1. poločas / zápas" se nemapují
    expect(types(l)).toEqual(new Set(['1X2', 'DC', 'DNB', 'OU', 'OU_HOME', 'OU_AWAY', 'AH', 'OE']));
  });

  it('volleyball: ML, sets handicap / total, points total, per-set markets', () => {
    const e = byId('3857824');
    expect([e.home, e.away]).toEqual(['Indie', 'Pákistán']);
    expect(price(e, 'ML|MATCH', 'HOME')).toBe(2.21);
    expect(price(e, 'OU|MATCH|182.5', 'OVER')).toBe(1.81);
    expect(price(e, 'AH_SETS|MATCH|-1.5', 'HOME')).toBe(3.38);
    expect(price(e, 'AH_SETS|MATCH|1.5', 'AWAY')).toBe(2.13);
    expect(price(e, 'OU_SETS|MATCH|3.5', 'UNDER')).toBe(2.91);
    expect(price(e, 'ML|S2', 'AWAY')).toBe(1.63);
    expect(price(e, 'OU|S1|45.5', 'OVER')).toBe(1.81);
    expect(price(e, 'OE|S1', 'EVEN')).toBe(1.56);
    // žádná remíza, žádné 1X2; "Vyhraje set", "Přesný výsledek", "N. set a zápas" se nemapují
    expect(types(e)).toEqual(new Set(['ML', 'OU', 'OE', 'AH_SETS', 'OU_SETS']));
  });

  it('table tennis: ML, points handicap / total (AH|OU) and set markets; no sets handicap in prematch', () => {
    const e = byId('3858705');
    expect([e.home, e.away]).toEqual(['Castro, Rogelio', 'Pištej, Ľubomír']);
    expect(price(e, 'ML|MATCH', 'HOME')).toBe(2.3);
    expect(price(e, 'ML|S1', 'AWAY')).toBe(1.59);
    expect(price(e, 'OU|S1|18.5', 'OVER')).toBe(1.79);
    expect(price(e, 'AH|S1|-2.5', 'HOME')).toBe(3.06);
    expect(price(e, 'AH|S1|3.5', 'AWAY')).toBe(2.81);
    expect(price(e, 'OE|S1', 'ODD')).toBe(2.38);
    expect(keysOf(e).some((k) => k.startsWith('AH_SETS'))).toBe(false);
  });

  it('baseball: MLB has 1X2 (9 innings) and ML incl. extra innings, run line, totals; others only AH/OU/OE', () => {
    const mlb = byId('3849588');
    expect(mlb.competition).toBe('MLB');
    expect(price(mlb, '1X2|REG', 'DRAW')).toBe(8.02);
    expect(price(mlb, 'ML|MATCH', 'HOME')).toBe(1.75);
    // ML vč. extra směn ≈ P(1) + P(X)/2 z 1X2 na 9 směn
    const p = (k: string, s: string) => 1 / price(mlb, k, s)!;
    const ml = p('ML|MATCH', 'HOME') / (p('ML|MATCH', 'HOME') + p('ML|MATCH', 'AWAY'));
    const x = p('1X2|REG', 'HOME') + p('1X2|REG', 'DRAW') / 2;
    expect(ml).toBeCloseTo(x / (p('1X2|REG', 'HOME') + p('1X2|REG', 'DRAW') + p('1X2|REG', 'AWAY')), 1);
    expect(price(mlb, 'OU|MATCH|7.5', 'OVER')).toBe(2.27);
    expect(price(mlb, 'AH|MATCH|-3.5', 'HOME')).toBe(4.52);
    expect(price(mlb, 'OU_HOME|MATCH|3.5', 'UNDER')).toBe(1.78);
    expect(price(mlb, 'OU_AWAY|MATCH|2.5', 'OVER')).toBe(1.68);
    expect(price(mlb, 'OE|MATCH', 'ODD')).toBe(1.55);
    for (const m of mlb.markets) expect(parseMarketKey(m.key).scope).toMatch(/^(MATCH|REG)$/);
    // NPB / přátelské zápasy: remíza po extra směnách možná → žádné ML ani 1X2
    for (const id of ['3786697', '3859994']) {
      const e = byId(id);
      expect(mk(e, 'ML|MATCH')).toBeUndefined();
      expect(mk(e, '1X2|REG')).toBeUndefined();
      expect(keysOf(e).length).toBeGreaterThan(0);
    }
    expect(price(byId('3786697'), 'AH|MATCH|-1.5', 'HOME')).toBe(2.3);
    // směny 1–5, jednotlivé směny, odpaly, "bude extra směna" … se nemapují
    expect(types(mlb)).toEqual(new Set(['1X2', 'ML', 'OU', 'OU_HOME', 'OU_AWAY', 'OE', 'AH']));
  });

  it('american football: 1X2 (60 min), AH / OU incl. OT, halves and quarters; ML not mapped, Q4 / H2 skipped', () => {
    const e = byId('3787588');
    expect([e.home, e.away]).toEqual(['Cleveland Browns', 'Pittsburgh Steelers']);
    expect(e.competition).toBe('NFL');
    expect(price(e, '1X2|REG', 'DRAW')).toBe(13.04);
    expect(price(e, 'AH|MATCH|-4.5', 'HOME')).toBe(3.16);
    expect(price(e, 'AH|MATCH|-0.5', 'AWAY')).toBe(1.62);
    expect(price(e, 'OU|MATCH|38.5', 'OVER')).toBe(1.88);
    expect(price(e, 'OU_HOME|MATCH|17.5', 'UNDER')).toBe(1.78);
    expect(price(e, 'OE|MATCH', 'ODD')).toBe(1.68);
    expect(price(e, '1X2|H1', 'DRAW')).toBe(8.46);
    expect(price(e, 'DNB|Q2', 'AWAY')).toBe(1.72);
    expect(price(e, 'OU|Q3|7.5', 'OVER')).toBe(2.22);
    expect(price(e, 'AH|Q1|-2.5', 'HOME')).toBe(2.66);
    // "Vítěz (včetně prodloužení)" (251): neznámé vyhodnocení remízy po prodloužení → nemapovat
    expect(mk(e, 'ML|MATCH')).toBeUndefined();
    expect(scopes(e).has('Q4')).toBe(false);
    expect(scopes(e).has('H2')).toBe(false);
    expect(scopes(e).has('MATCH')).toBe(true);
  });

  it('MMA / boxing: only 1X2|REG incl. draw; "Vítěz zápasu" (2-way) is neither ML nor DNB', () => {
    for (const id of ['3845991', '3781192']) {
      const e = byId(id);
      expect(keysOf(e)).toEqual(['1X2|REG']);
      expect(mk(e, '1X2|REG')!.selections.map((s) => s.key)).toEqual(['HOME', 'DRAW', 'AWAY']);
    }
    expect(price(byId('3845991'), '1X2|REG', 'DRAW')).toBe(35);
    expect(price(byId('3781192'), '1X2|REG', 'AWAY')).toBe(8.55);
  });

  it('snooker: ML, frames handicap and total; darts: ML, sets (AH_SETS / OU_SETS), legs only per set', () => {
    const s = byId('3857814');
    expect(price(s, 'ML|MATCH', 'HOME')).toBe(2.14);
    expect(price(s, 'OU|MATCH|7.5', 'UNDER')).toBe(1.87);
    expect(price(s, 'AH|MATCH|1.5', 'AWAY')).toBe(2.07);
    const d = byId('3821586');
    expect(price(d, 'ML|MATCH', 'AWAY')).toBe(1.44);
    expect(price(d, 'AH_SETS|MATCH|1.5', 'HOME')).toBe(1.78);
    expect(price(d, 'OU_SETS|MATCH|3.5', 'OVER')).toBe(1.38);
    expect(price(d, 'ML|S1', 'HOME')).toBe(2.22);
    expect(price(d, 'AH|S1|1.5', 'AWAY')).toBe(2.16);
    expect(price(d, 'OU|S1|4.5', 'UNDER')).toBe(1.39);
    // handicap / total legů se nemíchá s handicapem na sety: žádný AH|MATCH ani OU|MATCH u šipek se sety
    expect(keysOf(d).some((k) => k.startsWith('AH|MATCH') || k.startsWith('OU|MATCH'))).toBe(false);
    // "180-tky", "Nejvíce 180", přesné výsledky se nemapují
    expect(types(d)).toEqual(new Set(['ML', 'AH_SETS', 'OU_SETS', 'AH', 'OU']));
  });

  it('competition rules: baseball non-MLB, darts league nights (draws possible) have no 2-way winner', () => {
    const clone: PbEventsResponse = JSON.parse(JSON.stringify(response));
    const rename = (c: NonNullable<PbEventsResponse['EventTree']>['Categories'] extends (infer C)[] | undefined ? C : never, from: string, to: string) => {
      if (c.Base?.Name === from) c.Base.Name = to;
      for (const s of (c.Categories ?? []) as (typeof c)[]) rename(s, from, to);
    };
    for (const c of clone.EventTree!.Categories!) {
      rename(c as never, 'MLB', 'NPB');
      rename(c as never, 'World Grand Prix', 'Premier League');
    }
    const ev = parsePrematch([clone], { now: NOW });
    const yankees = ev.find((e) => e.sourceId === '3849588')!;
    expect(mk(yankees, 'ML|MATCH')).toBeUndefined();
    expect(mk(yankees, '1X2|REG')).toBeUndefined();
    expect(mk(yankees, 'OU|MATCH|7.5')).toBeDefined();
    const darts = ev.find((e) => e.sourceId === '3821586')!;
    expect(mk(darts, 'ML|MATCH')).toBeUndefined();
    expect(mk(darts, 'AH_SETS|MATCH|1.5')).toBeDefined();
  });

  it('volleyball friendly matches / golden set are skipped entirely', () => {
    const clone: PbEventsResponse = JSON.parse(JSON.stringify(response));
    const walk = (c: { Base?: { Name?: string }; Categories?: unknown[] }) => {
      if (c.Base?.Name === 'Asijské hry') c.Base.Name = 'Přátelské zápasy';
      for (const s of (c.Categories ?? []) as (typeof c)[]) walk(s);
    };
    for (const c of clone.EventTree!.Categories!) walk(c as never);
    expect(parsePrematch([clone], { now: NOW }).some((e) => e.sport === 'volleyball')).toBe(false);
  });
});

describe('synot live (GetLiveEventsWL) – nové sporty', async () => {
  const live = await loadFixture<SynLiveResponse>('synot', 'live-wl-newsports.json');
  const lev = parseLive(live, { now: NOW });
  const get = (id: string) => lev.find((e) => e.sourceId === id)!;

  it('parses volleyball, table tennis and baseball; validates', () => {
    const by: Record<string, number> = {};
    for (const e of lev) by[e.sport] = (by[e.sport] ?? 0) + 1;
    expect(by).toEqual({ volleyball: 4, table_tennis: 7, baseball: 1 });
    const v = validateRawOdds(odds(lev, 'live'), { minEvents: 0, maxAgeMs: 60_000, now: NOW });
    expect(v.ok).toBe(true);
    for (const e of lev) {
      expect(e.state).toBeDefined();
      expect(e.url).toBe(`https://sport.synottip.cz/live/live-zapas/${e.sourceId}`);
    }
  });

  it('volleyball: set state, sets score, points per set; break between sets', () => {
    const e = get('3704720');
    expect(e.live).toBe(true);
    expect(e.state).toMatchObject({ statusText: '2. set', period: 2, score: [0, 1], periodScores: [[17, 25], [19, 23]] });
    // volejbal nemá hodiny ani finished
    expect(e.state!.clockSec).toBeUndefined();
    expect(e.state!.finished).toBeUndefined();
    expect(e.state!.breakFlag).toBeUndefined();
    const b = get('3804720');
    expect(b.state).toMatchObject({ statusText: 'Přestávka', breakFlag: true, period: 2, clockRunning: false, score: [0, 2] });
    // suspendovaný výběr (Rate 0, State 3) → celá linie se vynechá, ne půlka trhu
    expect(mk(e, 'ML|MATCH')).toBeUndefined();
    expect(mk(e, 'ML|S2')).toBeUndefined();
    const f = get('3810602');
    expect(price(f, 'ML|MATCH', 'HOME')).toBe(4.26);
    expect(price(f, 'ML|MATCH', 'AWAY')).toBe(1.16);
    expect(price(f, 'ML|S2', 'HOME')).toBe(2.73);
  });

  it('table tennis: winner, points total, sets handicap vs points handicap, player total', () => {
    const a = get('3856320');
    expect(a.state).toMatchObject({ statusText: '2. set', period: 2, score: [1, 0], periodScores: [[11, 6], [10, 9]] });
    expect(price(a, 'ML|MATCH', 'HOME')).toBe(1.24);
    expect(price(a, 'OU|MATCH|74.5', 'UNDER')).toBe(1.93);
    // 209 "Sety - Handicap" u stolního tenisu = sety (u tenisu gamy)
    expect(price(a, 'AH_SETS|MATCH|-2.5', 'HOME')).toBe(2.54);
    const p = get('3860406');
    expect(price(p, 'AH|MATCH|7.5', 'HOME')).toBe(2.02); // "Tým 1 (+7.5)" – 268 "Body - Handicap"
    expect(price(p, 'AH|MATCH|7.5', 'AWAY')).toBe(1.62);
    const t = get('3856384');
    expect(price(t, 'OU_HOME|MATCH|36.5', 'OVER')).toBe(1.72); // 80 "Tým1 celkový počet bodů"
  });

  it('table tennis: "Ukončeno" = finished (no markets), "Nezačalo" = not live, event State 3 alone does not finish', () => {
    const fin = get('3856292');
    expect(fin.state).toMatchObject({ statusText: 'Ukončeno', finished: true, score: [3, 0] });
    expect(fin.markets).toEqual([]);
    const ns = get('3860445');
    expect(ns.live).toBe(false);
    expect(ns.state!.statusText).toBe('Nezačalo');
    expect(ns.state!.finished).toBeUndefined();
    const pause = get('3960406');
    expect(pause.state).toMatchObject({ statusText: 'Přestávka', breakFlag: true, period: 1 });
    expect(pause.state!.finished).toBeUndefined();
    // nikde jinde než u "Ukončeno" není finished
    expect(lev.filter((e) => e.state?.finished).map((e) => e.sourceId)).toEqual(['3856292']);
  });

  it('baseball: inning as period, runs as score, 1X2 (9 innings) + total incl. extra innings; scoreless-inning market skipped', () => {
    const e = get('3849593');
    expect(e.competition).toBe('MLB');
    expect(e.state).toMatchObject({ statusText: '4. směna bottom', period: 4, score: [3, 4], periodScores: [[1, 4], [1, 0], [0, 0], [1, 0]] });
    expect(e.state!.clockSec).toBeUndefined();
    expect(e.state!.finished).toBeUndefined();
    expect(price(e, '1X2|REG', 'DRAW')).toBe(6.55);
    expect(price(e, 'OU|MATCH|10.5', 'OVER')).toBe(1.42);
    expect(keysOf(e)).toEqual(['1X2|REG', 'OU|MATCH|10.5']); // "Počet bezbodových směn" (432) se nemapuje
  });
});

describe('synot prematch – počet požadavků za cyklus', () => {
  const tokenEnv = JSON.stringify({ Result: 1, Token: 'tok', ReturnValue: null });
  const all = Object.keys(SPORT_IDS) as Sport[];

  it('all sports: one listing + one GameIds request + one per niche sport (5 instead of 2 × 13)', async () => {
    const bodies: { url: string; body: Record<string, unknown> }[] = [];
    const transport: Transport = async (url, body) => {
      if (url.endsWith('GetLiveInitData')) return { status: 200, text: tokenEnv };
      bodies.push({ url, body: JSON.parse(body) });
      return { status: 200, text: JSON.stringify(env) };
    };
    const log = { debug() {}, info() {}, warn() {}, error() {} };
    const core = new SynotCore({ log } as never, transport);
    const r = await core.fetch('ebet-api', { scope: 'prematch', sports: all });
    expect(r.events.length).toBe(events.length);
    const calls = bodies.filter((b) => b.url.endsWith('GetWebStandardEvents'));
    expect(calls.length).toBe(2 + NICHE_SPORTS.length);
    expect([...NICHE_SPORTS].sort()).toEqual(['american_football', 'boxing', 'mma']);
    // výpis a společné trhy: CategoryID null = všechny sporty
    expect(calls.filter((c) => c.body.CategoryID === null).length).toBe(2);
    expect(calls.filter((c) => c.body.CategoryID !== null).map((c) => c.body.CategoryID).sort()).toEqual(['17', '22', '35']);
    const common = calls.find((c) => c.body.CategoryID === null && c.body.GameIds)!;
    const commonIds = common.body.GameIds as number[];
    expect(commonIds).toEqual(prematchGameIds(all.filter((s) => !NICHE_SPORTS.includes(s))));
    expect(commonIds.length).toBeLessThan(100);
    // niche sporty: delší okno (7 dní) než ostatní (24 h)
    const span = (c: { body: Record<string, unknown> }) => Number(/\d+/.exec(String(c.body.To))![0]) - Number(/\d+/.exec(String(c.body.From))![0]);
    expect(span(common)).toBe(24 * 3600_000);
    expect(span(calls.find((c) => c.body.CategoryID === '22')!)).toBe(168 * 3600_000);
  });

  it('single sport: category directly, old behaviour (listing + markets)', async () => {
    const bodies: Record<string, unknown>[] = [];
    const transport: Transport = async (url, body) => {
      if (url.endsWith('GetLiveInitData')) return { status: 200, text: tokenEnv };
      bodies.push(JSON.parse(body));
      return { status: 200, text: JSON.stringify(env) };
    };
    const core = new SynotCore({ log: { debug() {}, info() {}, warn() {}, error() {} } } as never, transport);
    await core.fetch('ebet-api', { scope: 'prematch', sports: ['handball'] });
    expect(bodies.map((b) => b.CategoryID)).toEqual(['33', '33']);
    expect(bodies.filter((b) => b.GameIds).length).toBe(1);
  });
});
