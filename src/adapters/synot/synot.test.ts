import { describe, expect, it } from 'vitest';
import { loadFixture } from '../fixtures.js';
import { validateRawOdds } from '../../core/validate.js';
import { isValidMarketKey, parseMarketKey } from '../../core/markets.js';
import type { RawEvent, RawOdds, Sport } from '../../core/types.js';
import type { ApiEnvelope } from './api.js';
import { marketsBody, wcfDate } from './api.js';
import { decodeEventsResponse } from './proto.js';
import type { SynLiveResponse } from './parse.js';
import { gameTypeId, mapGame, parseLive, parsePrematch, parseWcfDate, PREMATCH_GAME_IDS, splitName } from './parse.js';

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
    expect(events.length).toBe(1066);
    expect(by).toEqual({ football: 689, hockey: 133, tennis: 118, basketball: 126 });
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

describe('synot live (GetLIPEvtsDsk, JSON)', async () => {
  const live = await loadFixture<SynLiveResponse>('synot', 'live.json');
  const events = parseLive(live, { now: NOW });
  const byId = (id: string) => events.find((e) => e.sourceId === id)!;

  it('parses live events of the four sports and validates', () => {
    const by: Record<string, number> = {};
    for (const e of events) by[e.sport] = (by[e.sport] ?? 0) + 1;
    expect(by).toEqual({ football: 12, hockey: 18, tennis: 19, basketball: 5 });
    expect(events.every((e) => e.live && e.state)).toBe(true);
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
    expect(older.length).toBe(40);
    expect(older.filter((e) => e.state?.breakFlag).map((e) => e.sport).sort()).toEqual(['football', 'football', 'football', 'hockey']);
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
