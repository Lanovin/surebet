// BetX: dvojtip a nové sporty (házená, volejbal, americký fotbal, baseball, box, MMA, snooker, stolní tenis, šipky).
// Zkrácené skutečné payloady z 1. 10. 2026 (~00:10 CEST): listing matches/flat (BasicOffer + jeden BetTypeKey)
// a plné nabídky match/offers (listing je pro tyto sporty nevrací – fixture jen ověřuje mapování UOF id).
import { describe, expect, it } from 'vitest';
import { loadFixture } from '../fixtures.js';
import { validateRawOdds } from '../../core/validate.js';
import { isValidMarketKey, parseMarketKey } from '../../core/markets.js';
import { SPORTS } from '../../core/types.js';
import type { RawEvent, RawOdds } from '../../core/types.js';
import { DEFAULT_OPTIONS, flatUrl, PUSH_DEFAULTS, parseRaw, prematchPasses, type BetxRaw } from './strategies.js';
import { BETX_SPORTS, betxState, checkPushTable, parseBetxMatches, SPORT_IDS, type BetxMatch } from './parse.js';

type Fixture = BetxRaw & { recordedAt: string };

const keys = (e: RawEvent) => e.markets.map((m) => m.key);
function odds(e: RawEvent, key: string): Record<string, number> {
  const m = e.markets.find((x) => x.key === key);
  if (!m) throw new Error(`market ${key} missing on ${e.home} – ${e.away}`);
  return Object.fromEntries(m.selections.map((s) => [s.key, s.odds]));
}

describe('betx / sporty a průchody prematch listingu', () => {
  it('SportId: všech 13 sportů (BETX Šance/Superšance 449/425 se neberou)', () => {
    expect(Object.keys(SPORT_IDS).sort()).toEqual([...SPORTS].sort());
    expect(SPORT_IDS).toMatchObject({ handball: 392, volleyball: 397, american_football: 404, baseball: 394, boxing: 414, mma: 455, snooker: 406, table_tennis: 417, darts: 401 });
    expect(new Set(Object.values(SPORT_IDS)).size).toBe(13);
    expect(BETX_SPORTS[425]).toBeUndefined();
    expect(BETX_SPORTS[449]).toBeUndefined();
  });

  it('počet průchodů: sporty se stejným typem a horizontem sdílejí požadavek (SportIds=a,b,…)', () => {
    const passes = prematchPasses([...SPORTS], DEFAULT_OPTIONS);
    // před: 8 průchodů (4 sporty × 2 typy), teď 12 prvních stránek pro 13 sportů
    expect(passes).toHaveLength(12);
    const by = (bt: string, h?: number) => passes.find((p) => p.bt === bt && p.hours === h);
    // dvojtip: fotbal + hokej v jednom průchodu, jen nejbližších 24 h
    expect(by('3', 24)?.sportIds.sort()).toEqual([388, 398]);
    // házená jede s fotbalem (handicap) a hokejem (total) v jejich 72h průchodech
    expect(by('4', 72)?.sportIds).toContain(392);
    expect(by('60', 72)?.sportIds.sort()).toEqual([392, 398]);
    // sporty, kde listing vrací jen BasicOffer, dohromady v jednom průchodu (bez BetTypeKey)
    const basic = passes.find((p) => p.bt === '')!;
    expect(basic.sportIds.sort()).toEqual([394, 401, 404, 406, 414, 417, 455]);
    expect(flatUrl(basic.sportIds, basic.bt, 0, '2026-10-01T00:00:00.000Z')).not.toContain('BetTypeKey');
    // ostatní (existující) sporty zůstaly: fotbal 60 přes celou nabídku, tenis/basket/hokej beze změny
    expect(by('60', undefined)?.sportIds).toEqual([388]);
    expect(by('911', undefined)?.sportIds).toEqual([389]);
    expect(by('2', undefined)?.sportIds).toEqual([398]);
  });

  it('runner s jedním sportem nevolá nic navíc', () => {
    expect(prematchPasses(['tennis'], DEFAULT_OPTIONS).map((p) => p.bt)).toEqual(['911', '910']);
    expect(prematchPasses(['darts'], DEFAULT_OPTIONS).map((p) => p.bt)).toEqual(['']);
  });
});

describe('betx / dvojtip a nové sporty – prematch (1. 10. 2026)', async () => {
  const raw = await loadFixture<Fixture>('betx', 'betx-prematch-newsports-2026-10-01.json');
  const now = Date.parse(raw.recordedAt);
  const events = parseRaw(raw, 'prematch', now);
  const ev = (id: string) => events.find((e) => e.sourceId === id)!;

  it('dvojtip: BetTypeKey 3 „Dvojtip“ = UOF 10 (9 = 1X, 10 = 12, 11 = X2), fotbal i hokej (základní doba)', () => {
    const f = ev('74598542'); // Cerro Porteño – Rubio Nu: 1X2 1.49 / 4.01 / 6.35
    expect(odds(f, '1X2|REG')).toEqual({ HOME: 1.49, DRAW: 4.01, AWAY: 6.35 });
    // listing řadí výsledky 1X, X2, 12 (UofKey 10/9, 10/11, 10/10) – mapuje se podle UOF id, ne podle pořadí
    expect(odds(f, 'DC|REG')).toEqual({ HOME_DRAW: 1.11, DRAW_AWAY: 2.49, HOME_AWAY: 1.19 });
    const h = ev('72886412'); // Philadelphia – Pittsburgh
    expect(odds(h, 'DC|REG')).toEqual({ HOME_DRAW: 1.43, DRAW_AWAY: 1.72, HOME_AWAY: 1.22 });
    expect(keys(h)).not.toContain('DC|MATCH');
  });

  it('házená: 1X2 (60 min), DNB, handicap a total gólů, týmové totaly, poločasy vč. dvojtipu (UOF 60/63, 83/85)', () => {
    const e = ev('75148530'); // Zamalek – Al Ahli
    expect(odds(e, '1X2|REG')).toEqual({ HOME: 3.33, DRAW: 9.65, AWAY: 1.48 });
    expect(odds(e, 'DNB|REG')).toEqual({ HOME: 2.96, AWAY: 1.35 });
    expect(odds(e, 'OU|REG|55.5')).toEqual({ OVER: 1.85, UNDER: 1.85 });
    expect(odds(e, 'AH|REG|2.5')).toEqual({ HOME: 1.78, AWAY: 1.93 });
    expect(odds(e, 'OU_HOME|REG|26.5')).toEqual({ OVER: 1.81, UNDER: 1.86 });
    expect(odds(e, 'OE|REG')).toEqual({ ODD: 1.92, EVEN: 1.86 }); // sudý = UOF 72, lichý = 70
    expect(odds(e, '1X2|H1')).toEqual({ HOME: 2.83, DRAW: 8, AWAY: 1.58 });
    // 1X = 2.07, X2 = 1.34, 12 = 1.09 (UofKey 63/9, 63/11, 63/10)
    expect(odds(e, 'DC|H1')).toEqual({ HOME_DRAW: 2.07, DRAW_AWAY: 1.34, HOME_AWAY: 1.09 });
    expect(odds(e, 'DC|H2')).toEqual({ HOME_DRAW: 1.98, DRAW_AWAY: 1.38, HOME_AWAY: 1.09 });
    expect(keys(e).some((k) => k.startsWith('ML|'))).toBe(false);
    // listing průchod „47“ dává DNB i zápasům bez dalších trhů
    expect(keys(ev('75146124'))).toEqual(['1X2|REG', 'DNB|REG']);
  });

  it('volejbal: vítěz zápasu, vítěz setů, handicap a total bodů (UOF 237/238), body v 1. setu; bez 1X2', () => {
    const l = ev('73534908'); // z listingu BetTypeKey 502
    expect(odds(l, 'ML|MATCH')).toEqual({ HOME: 4.5, AWAY: 1.15 });
    expect(odds(l, 'ML|S1')).toEqual({ HOME: 2.95, AWAY: 1.33 });
    const e = ev('75174500'); // Empire – Enerdzhi (plná nabídka)
    expect(odds(e, 'AH|MATCH|-2.5')).toEqual({ HOME: 1.83, AWAY: 1.84 });
    expect(odds(e, 'AH|MATCH|1.5')).toEqual({ HOME: 1.61, AWAY: 2.14 });
    expect(odds(e, 'OU|MATCH|177.5')).toEqual({ OVER: 1.74, UNDER: 1.94 });
    expect(odds(e, 'OU|S1|45.5')).toEqual({ OVER: 1.82, UNDER: 1.85 });
    for (const s of ['S1', 'S2', 'S3', 'S4', 'S5']) expect(keys(e)).toContain(`ML|${s}`);
    // přesný výsledek, počet setů (916), „vyhraje alespoň 1 set“ atd. se nemapují
    expect(keys(e).every((k) => /^(ML|AH|OU)\|/.test(k))).toBe(true);
    expect(keys(e).some((k) => k.startsWith('1X2'))).toBe(false);
  });

  it('americký fotbal: vítěz a handicap/total vč. prodloužení, 1X2 základní doby (s remízou), poločasy', () => {
    const e = ev('71515842'); // Cleveland Browns – Pittsburgh Steelers
    // vítěz vč. prodl. (219) se nemapuje: NFL může skončit remízou a pravidlo není potvrzeno
    expect(keys(e)).not.toContain('ML|MATCH');
    expect(odds(e, '1X2|REG')).toEqual({ HOME: 2.34, DRAW: 13, AWAY: 1.71 });
    expect(odds(e, 'AH|MATCH|2.5')).toEqual({ HOME: 1.99, AWAY: 1.73 });
    expect(odds(e, 'OU|MATCH|38.5')).toEqual({ OVER: 1.87, UNDER: 1.84 });
    expect(odds(e, 'OU_HOME|MATCH|17.5')).toEqual({ OVER: 1.92, UNDER: 1.78 });
    expect(odds(e, '1X2|H1')).toEqual({ HOME: 2.3, DRAW: 8.4, AWAY: 1.82 });
    expect(odds(e, '1X2|H2')).toEqual({ HOME: 2.25, DRAW: 9.2, AWAY: 1.9 });
    expect(odds(e, 'DNB|H1')).toEqual({ HOME: 2.11, AWAY: 1.65 });
    // „Počet bodů 2. poločas“ (UOF 90, bez zmínky o prodloužení) a „Čtvrtina s nejvyšším skóre“ se nemapují
    expect(keys(e).filter((k) => k.includes('|H2'))).toEqual(['1X2|H2']);
    expect(keys(e).some((k) => k.endsWith('|Q4'))).toBe(false);
  });

  it('baseball: vítěz (vč. extra směn), run line, total a týmové totaly; směny se nemapují', () => {
    const e = ev('75060834'); // New York Yankees – Boston Red Sox
    expect(odds(e, 'ML|MATCH')).toEqual({ HOME: 1.72, AWAY: 2.09 });
    expect(odds(e, 'AH|MATCH|-1.5')).toEqual({ HOME: 2.47, AWAY: 1.48 });
    expect(odds(e, 'OU|MATCH|6.5')).toEqual({ OVER: 1.76, UNDER: 1.96 });
    expect(odds(e, 'OU_AWAY|MATCH|2.5')).toEqual({ OVER: 1.66, UNDER: 2.09 });
    for (const m of e.markets) expect(parseMarketKey(m.key).scope).toBe('MATCH');
  });

  it('box a MMA: jen 1X2 včetně remízy; 2-cestný vítěz (vrácení při remíze nepotvrzeno) ani ML se nemapuje', () => {
    for (const id of ['74124484', '74249958']) {
      const e = ev(id);
      expect(keys(e)).toEqual(['1X2|REG']);
    }
    expect(odds(ev('74249958'), '1X2|REG')).toEqual({ HOME: 2.85, DRAW: 15, AWAY: 1.42 });
  });

  it('snooker, šipky, stolní tenis: vítěz (ML|MATCH) z BasicOffer', () => {
    expect(odds(ev('75142654'), 'ML|MATCH')).toEqual({ HOME: 2.12, AWAY: 1.65 });
    expect(odds(ev('75177204'), 'ML|MATCH')).toEqual({ HOME: 1.27, AWAY: 3.4 });
    expect(odds(ev('75139022'), 'ML|MATCH')).toEqual({ HOME: 1.99, AWAY: 1.64 });
    for (const id of ['75142654', '75177204', '75139022']) expect(keys(ev(id))).toEqual(['ML|MATCH']);
  });

  it('všechny klíče jsou platné, kurzy as-is (max. 2 desetinná místa pod 10) a validateRawOdds projde', () => {
    expect(events.length).toBeGreaterThanOrEqual(18);
    for (const e of events) for (const m of e.markets) expect(isValidMarketKey(m.key), m.key).toBe(true);
    const r: RawOdds = { bookmaker: 'betx', strategy: 'betx-api', scope: 'prematch', fetchedAt: now, events };
    expect(validateRawOdds(r, { minEvents: 1, maxAgeMs: 60_000, now }).ok).toBe(true);
  });
});

describe('betx / live nových sportů (1. 10. 2026)', async () => {
  const f = await loadFixture<{ matches: BetxMatch[] }>('betx', 'betx-live-uofkeys.json');
  const events = parseBetxMatches(f.matches, { live: true });

  it('volejbal: set, sety ve skóre, body po setech; vítěz zápasu (UofKey 23/186)', () => {
    const e = events.find((x) => x.sourceId === '72066036')!; // Bebedouro U21 – Volei Mania Itaqua, 2. set
    expect(e.sport).toBe('volleyball');
    expect(e.state).toMatchObject({ statusText: '2. set', score: [0, 1], period: 2, periodScores: [[17, 25], [3, 3]] });
    expect(e.state?.clockSec).toBeUndefined();
    expect(odds(e, 'ML|MATCH')).toEqual({ HOME: 9.25, AWAY: 1.02 });
  });

  it('baseball: směna z LB_BASEBALL_3IB (i 3IT = horní půlka), skóre v bězích', () => {
    const e = events.find((x) => x.sport === 'baseball')!;
    expect(e.state).toMatchObject({ period: 2, score: [1, 4] });
    const st = betxState({ SportId: 394, Id: 1, MatchStartTime: '', LiveMatchTimeOrigName: 'LB_BASEBALL_3IB', LiveMatchTimeState: '3. směna', LiveMatchScore: '2 : 4', LiveSetScore: '1 : 4 - 1 : 0 - 0 : 0' }, 'baseball');
    expect(st).toMatchObject({ period: 3, score: [2, 4], periodScores: [[1, 4], [1, 0], [0, 0]] });
    expect(st.breakFlag).toBeUndefined();
    expect(odds(e, 'ML|MATCH')).toEqual({ HOME: 3.35, AWAY: 1.32 });
  });

  it('stolní tenis: 4. set, sety 2:1, „Začne brzy“ (NOTSTARTED) v live listingu se vynechá', () => {
    const tt = events.filter((x) => x.sport === 'table_tennis');
    expect(tt.every((x) => x.state?.statusText !== 'Začne brzy')).toBe(true);
    expect(f.matches.some((m) => m.LiveMatchTimeOrigName === 'LB_TABLE_TENNIS_NOTSTARTED')).toBe(true);
    expect(events.find((x) => x.sourceId === '75139020')).toBeUndefined();
    expect(events.find((x) => x.sourceId === '75139008')?.state).toMatchObject({ period: 2, score: [0, 1] });
  });

  it('push: volejbal, stolní tenis a baseball mají spojení jen s BasicOffer; ostatní nové sporty push nemá', () => {
    expect(Object.keys(PUSH_DEFAULTS.pushBetTypes).sort()).toEqual(['baseball', 'basketball', 'football', 'hockey', 'table_tennis', 'tennis', 'volleyball']);
    expect(PUSH_DEFAULTS.pushBetTypes.volleyball).toEqual([]);
    expect(checkPushTable(f.matches)).toEqual([]);
  });
});
