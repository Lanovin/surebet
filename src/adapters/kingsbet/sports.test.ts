// Dvojtip (DC) a další sporty na platformě Altenar (Kingsbet) – zkrácené skutečné payloady z 1. 10. 2026 (~00:10 CEST):
// GetEvents + GetEventDetails (prematch) a GetLiveEvents (volejbal, baseball, stolní tenis, fotbal).
import { describe, expect, it } from 'vitest';
import { loadFixture } from '../fixtures.js';
import { validateRawOdds } from '../../core/validate.js';
import { isValidMarketKey, parseMarketKey } from '../../core/markets.js';
import type { RawEvent, RawOdds } from '../../core/types.js';
import { ALTENAR_DETAIL_SPORTS, altenarUrls, parseAltenarRaw, type AltenarRaw } from '../common/altenar-api.js';
import { ALTENAR_SPORT_IDS } from '../common/altenar.js';
import { KINGSBET } from './index.js';

type Fixture = AltenarRaw & { recordedAt: string };

async function load(name: string, scope: 'prematch' | 'live'): Promise<{ events: RawEvent[]; now: number }> {
  const raw = await loadFixture<Fixture>('kingsbet', name);
  const now = Date.parse(raw.recordedAt);
  return { events: parseAltenarRaw(raw, KINGSBET, scope, now), now };
}

const keys = (e: RawEvent) => e.markets.map((m) => m.key);
function odds(e: RawEvent, key: string): Record<string, number> {
  const m = e.markets.find((x) => x.key === key);
  if (!m) throw new Error(`market ${key} missing on ${e.home} – ${e.away}`);
  return Object.fromEntries(m.selections.map((s) => [s.key, s.odds]));
}

describe('kingsbet / dvojtip a nové sporty – prematch (1. 10. 2026)', async () => {
  const { events, now } = await load('altenar-api-prematch-newsports-2026-10-01.json', 'prematch');
  const byId = new Map(events.map((e) => [e.sourceId, e]));
  const ev = (id: string) => byId.get(id)!;

  it('všech 13 sportů má Altenar sportId a URL listingu; detail jen u sportů, kde něco přidá', () => {
    expect(Object.keys(ALTENAR_SPORT_IDS)).toHaveLength(13);
    expect(new Set(Object.values(ALTENAR_SPORT_IDS)).size).toBe(13);
    const u = altenarUrls('kingsbet');
    expect(u.events('table_tennis')).toContain('sportId=77');
    expect(u.live('mma')).toContain('sportId=84');
    expect([...ALTENAR_DETAIL_SPORTS]).not.toContain('mma');
    expect([...ALTENAR_DETAIL_SPORTS]).not.toContain('boxing');
  });

  it('parsuje všech devět nových sportů + fotbal a hokej', () => {
    const by: Record<string, number> = {};
    for (const e of events) by[e.sport] = (by[e.sport] ?? 0) + 1;
    expect(by).toEqual({
      football: 2,
      hockey: 1,
      handball: 2,
      volleyball: 2,
      american_football: 2,
      baseball: 2,
      boxing: 1,
      mma: 1,
      snooker: 1,
      table_tennis: 1,
      darts: 1,
    });
    expect(events.every((e) => !e.live && e.startTime > now && !e.state)).toBe(true);
  });

  it('fotbal: dvojtip Výsledek zápasu / 1. poločas / 2. poločas (UOF 10 / 63 / 85; 9 = 1X, 10 = 12, 11 = X2)', () => {
    const e = ev('17448026'); // Panama – Nový Zéland
    // 1X2 2.45 / 3.25 / 2.86 → 1X ≈ 1.40, 12 ≈ 1.32, X2 ≈ 1.52 před marží: sedí pořadí výběrů
    expect(odds(e, '1X2|REG')).toEqual({ HOME: 2.45, DRAW: 3.25, AWAY: 2.86 });
    expect(odds(e, 'DC|REG')).toEqual({ HOME_DRAW: 1.36, HOME_AWAY: 1.31, DRAW_AWAY: 1.47 });
    expect(odds(e, 'DC|H1')).toEqual({ HOME_DRAW: 1.27, HOME_AWAY: 1.6, DRAW_AWAY: 1.31 });
    expect(odds(e, 'DC|H2')).toEqual({ HOME_DRAW: 1.29, HOME_AWAY: 1.5, DRAW_AWAY: 1.36 });
    // kombinace „dvojtip a počet gólů / oba týmy dají gól“ ani „poločas/zápas – dvojtip“ se nemapují
    expect(keys(e).filter((k) => k.startsWith('DC|'))).toEqual(['DC|REG', 'DC|H1', 'DC|H2']);
    // listing (bez detailu) má dvojtip taky
    expect(odds(ev('17823227'), 'DC|REG')).toEqual({ HOME_DRAW: 1.11, HOME_AWAY: 1.18, DRAW_AWAY: 2.08 });
  });

  it('hokej: „Dvojtip“ = základní doba (REG), třetiny P1–P3; vítěz vč. prodloužení zůstává ML', () => {
    const e = ev('17103441'); // Colorado – Los Angeles Kings
    expect(odds(e, 'DC|REG')).toEqual({ HOME_DRAW: 1.29, HOME_AWAY: 1.25, DRAW_AWAY: 1.91 });
    for (const p of ['P1', 'P2', 'P3']) expect(e.markets.some((m) => m.key === `DC|${p}`), p).toBe(true);
    expect(odds(e, 'DC|P1')).toEqual({ HOME_DRAW: 1.3, HOME_AWAY: 1.4, DRAW_AWAY: 1.62 });
    expect(keys(e)).not.toContain('DC|MATCH');
    expect(keys(e)).toContain('ML|MATCH');
  });

  it('házená: 1X2 (60 min), DNB, handicap a total gólů – dvojtip Altenar u házené nenabízí', () => {
    const e = ev('17884165'); // Zamalek – Al Ahli
    expect(odds(e, '1X2|REG')).toEqual({ HOME: 3.25, DRAW: 8, AWAY: 1.5 });
    // API 2.8572 / 1.3334 → web 2.86 / 1.33
    expect(odds(e, 'DNB|REG')).toEqual({ HOME: 2.86, AWAY: 1.33 });
    expect(odds(e, 'AH|REG|2.5')).toEqual({ HOME: 1.76, AWAY: 1.93 });
    expect(odds(e, 'OU|REG|55.5')).toEqual({ OVER: 1.85, UNDER: 1.85 });
    expect(keys(e).some((k) => k.startsWith('ML|') || k.startsWith('DC|'))).toBe(false);
    expect(ev('17893596').markets.map((m) => m.key)).toEqual(['1X2|REG', 'OU|REG|56.5']);
  });

  it('volejbal: vítěz zápasu a 1. setu; bez remízy, bez 1X2', () => {
    const e = ev('17881288'); // Indie – Pákistán
    expect(odds(e, 'ML|MATCH')).toEqual({ HOME: 2.17, AWAY: 1.58 });
    expect(odds(e, 'ML|S1')).toEqual({ HOME: 1.96, AWAY: 1.69 });
    expect(keys(e).some((k) => k.startsWith('1X2|') || k.startsWith('DC|'))).toBe(false);
  });

  it('americký fotbal: vše vč. prodloužení (ML/AH/OU), 1X2 jen poločasy a čtvrtiny, 4. čtvrtina vč. prodl. pryč', () => {
    const e = ev('16551345'); // CLE Browns – PIT Steelers
    expect(e.home).toBe('CLE Browns');
    // vítěz vč. prodl. (219) se nemapuje: NFL může skončit remízou a pravidlo není potvrzeno
    expect(keys(e)).not.toContain('ML|MATCH');
    // handicap z pohledu domácích (odd.sv): domácí +12.5 za 1.22, hosté −12.5 za 4.03
    expect(odds(e, 'AH|MATCH|12.5')).toEqual({ HOME: 1.22, AWAY: 4.03 });
    expect(odds(e, 'OU|MATCH|38')).toEqual({ OVER: 1.87, UNDER: 1.95 });
    expect(odds(e, 'OU_HOME|MATCH|17.5')).toEqual({ OVER: 1.91, UNDER: 1.91 });
    expect(odds(e, 'OU_AWAY|MATCH|20.5')).toEqual({ OVER: 2.05, UNDER: 1.71 });
    expect(odds(e, '1X2|H1')).toEqual({ HOME: 2.2, DRAW: 9, AWAY: 1.87 });
    expect(odds(e, '1X2|H2')).toEqual({ HOME: 2.15, DRAW: 11, AWAY: 1.83 });
    expect(odds(e, '1X2|Q1')).toEqual({ HOME: 2.45, DRAW: 4.25, AWAY: 2.25 });
    expect(odds(e, 'DNB|Q2')).toEqual({ HOME: 2.1, AWAY: 1.71 });
    expect(odds(e, 'AH|Q3|0.5')).toEqual({ HOME: 1.63, AWAY: 2.21 });
    // 1X2 celého zápasu v základní době Altenar nenabízí; 2. poločas / 4. čtvrtina vč. prodloužení se nemapuje
    expect(keys(e)).not.toContain('1X2|REG');
    expect(keys(e).some((k) => k.endsWith('|Q4'))).toBe(false);
    expect(e.markets.some((m) => /prodl/i.test(m.rawName ?? '') && m.key.includes('|H2'))).toBe(false);
    // uzavřená linie (oddStatus) je open:false
    expect(e.markets.find((m) => m.key === 'OU|MATCH|28')?.open).toBe(false);
  });

  it('baseball: vše vč. extra směn – ML, run line, total, týmové totaly; směny a nadhazovači se nemapují', () => {
    const e = ev('17843781'); // NY Yankees – BOS Red Sox
    expect(odds(e, 'ML|MATCH')).toEqual({ HOME: 1.74, AWAY: 2.15 });
    expect(odds(e, 'AH|MATCH|-1.5')).toEqual({ HOME: 2.65, AWAY: 1.5 });
    expect(odds(e, 'AH|MATCH|1.5')).toEqual({ HOME: 1.38, AWAY: 2.9 });
    expect(odds(e, 'OU|MATCH|6.5')).toEqual({ OVER: 1.8, UNDER: 2.05 });
    expect(odds(e, 'OU_HOME|MATCH|3.5')).toEqual({ OVER: 1.95, UNDER: 1.74 });
    expect(odds(e, 'OU_AWAY|MATCH|2.5')).toEqual({ OVER: 1.65, UNDER: 2.15 });
    // žádné periody (N. směna, směny 1–5), žádný 1X2 / remíza
    for (const m of e.markets) expect(parseMarketKey(m.key).scope).toBe('MATCH');
    expect(keys(e).some((k) => k.startsWith('1X2|'))).toBe(false);
  });

  it('box a MMA: 2-cestný „Vítěz zápasu“ se nemapuje (vrácení při remíze není potvrzeno) – nikdy ML; počet kol také ne', () => {
    expect(keys(ev('17879219'))).toEqual([]);
    expect(keys(ev('17869100'))).toEqual([]);
  });

  it('snooker: vítěz + handicap a počet framů; šipky: sety (AH_SETS / OU_SETS) a legy (OU) zvlášť', () => {
    const s = ev('17887002'); // Wakelin – Robertson
    expect(odds(s, 'ML|MATCH')).toEqual({ HOME: 2.75, AWAY: 1.44 });
    expect(odds(s, 'AH|MATCH|1.5')).toEqual({ HOME: 2, AWAY: 1.71 });
    expect(odds(s, 'OU|MATCH|7.5')).toEqual({ OVER: 1.83, UNDER: 1.83 });
    // „N. frame – vítěz“ / „celkem bodů“ se nemapuje
    expect(keys(s).every((k) => ['ML|MATCH', 'AH|MATCH|1.5'].includes(k) || k.startsWith('OU|MATCH|'))).toBe(true);
    const d = ev('17882945'); // Zonneveld – Anderson
    expect(odds(d, 'ML|MATCH')).toEqual({ HOME: 2.75, AWAY: 1.48 });
    expect(odds(d, 'AH_SETS|MATCH|-1.5')).toEqual({ HOME: 3.75, AWAY: 1.24 });
    expect(odds(d, 'OU_SETS|MATCH|4.5')).toEqual({ OVER: 2.85, UNDER: 1.38 });
    expect(odds(d, 'OU|MATCH|16.5')).toEqual({ OVER: 2, UNDER: 1.71 });
    // „Více 180 v zápasu“ (1/X/2) a další 180ky nejsou vítěz zápasu
    expect(keys(d).filter((k) => k.startsWith('1X2'))).toEqual([]);
    expect(keys(d).some((k) => k.startsWith('AH|MATCH'))).toBe(false); // handicap na legy Altenar nenabízí
  });

  it('stolní tenis: Kingsbet má v listingu jen vítěze', () => {
    expect(ev('17881525').markets.map((m) => m.key)).toEqual(['ML|MATCH']);
  });

  it('všechny klíče jsou platné, scope odpovídá sportu a validateRawOdds projde', () => {
    for (const e of events) {
      for (const m of e.markets) {
        expect(isValidMarketKey(m.key), m.key).toBe(true);
        const p = parseMarketKey(m.key);
        if (['volleyball', 'baseball', 'snooker', 'table_tennis', 'darts'].includes(e.sport)) expect(p.type === '1X2' || p.type === 'DC').toBe(false);
        if (['mma', 'boxing'].includes(e.sport)) expect(p.type).toBe('DNB');
        if (p.type === 'DC') expect(['football', 'hockey']).toContain(e.sport);
      }
    }
    const raw: RawOdds = { bookmaker: 'kingsbet', strategy: 'altenar-api', scope: 'prematch', fetchedAt: now, events };
    expect(validateRawOdds(raw, { minEvents: 1, maxAgeMs: 60_000, now }).ok).toBe(true);
  });

  it('kurzy zaokrouhlené na 2 místa jako web (1.875 → 1.88, API 2.8572 → 2.86)', () => {
    // žádný kurz nemá víc než 2 desetinná místa
    for (const e of events) for (const m of e.markets) for (const s of m.selections) expect(Math.abs(s.odds * 100 - Math.round(s.odds * 100)) < 1e-9, `${e.sourceId} ${m.key} ${s.odds}`).toBe(true);
  });
});

describe('kingsbet / nové sporty – live (1. 10. 2026)', async () => {
  const { events, now } = await load('altenar-api-live-newsports-2026-10-01.json', 'live');
  const by = (id: string) => events.find((e) => e.sourceId === id)!;

  it('parsuje live volejbal, baseball, stolní tenis a fotbal', () => {
    const cnt: Record<string, number> = {};
    for (const e of events) cnt[e.sport] = (cnt[e.sport] ?? 0) + 1;
    expect(cnt).toMatchObject({ volleyball: 1, baseball: 1, table_tennis: 7 });
    expect(events.every((e) => e.live && e.state)).toBe(true);
  });

  it('volejbal: sety ve skóre, body v setu, handicap a total bodů na celý zápas', () => {
    const e = by('17886076');
    expect(e.state).toMatchObject({ statusText: '1. set', score: [0, 0], period: 1, points: '10:12' });
    expect(e.state?.breakFlag).toBeUndefined();
    expect(e.state?.clockSec).toBeUndefined();
    expect(odds(e, 'ML|MATCH')).toEqual({ HOME: 2.75, AWAY: 1.4 });
    // API 1.833 → 1.83, 1.909 → 1.91
    expect(odds(e, 'AH|MATCH|8.5')).toEqual({ HOME: 1.83, AWAY: 1.83 });
    expect(odds(e, 'OU|MATCH|180.5')).toEqual({ OVER: 1.91, UNDER: 1.83 });
  });

  it('baseball: směna jako perioda, skóre v bězích, žádné hodiny', () => {
    const e = by('17862972');
    expect(e.state).toMatchObject({ statusText: '3. směna', score: [2, 4], period: 3 });
    expect(e.state?.clockSec).toBeUndefined();
    expect(odds(e, 'ML|MATCH')).toEqual({ HOME: 2.6, AWAY: 1.48 });
    expect(odds(e, 'OU|MATCH|11.5')).toEqual({ OVER: 1.83, UNDER: 1.91 });
    expect(odds(e, 'AH|MATCH|1.5')).toEqual({ HOME: 1.87, AWAY: 1.87 });
  });

  it('stolní tenis: set, sety ve skóre, body v setu; zápas bez vítěze (jen handicap/total) zůstává', () => {
    const e = by('17889840'); // 5. set, sety 2:2, v setu 8:3
    expect(e.state).toMatchObject({ statusText: '5. set', score: [2, 2], period: 5, points: '8:3' });
    expect(keys(e)).toEqual(['AH|MATCH|-4.5', 'OU|MATCH|85.5']);
    const f = by('17893572');
    expect(f.state).toMatchObject({ period: 4, score: [1, 2], points: '4:5' });
    expect(odds(f, 'ML|MATCH')).toEqual({ HOME: 5.67, AWAY: 1.09 });
  });

  it('fotbal live: dvojtip počítaný s aktuálním skóre, pozastavené výběry (1X při 1:0 vedení hostů) chybí', () => {
    const e = by('17879895'); // River – SE Picos 1:0
    expect(odds(e, 'DC|REG')).toEqual({ HOME_AWAY: 1.13, DRAW_AWAY: 2.8 });
  });

  it('validateRawOdds projde', () => {
    const raw: RawOdds = { bookmaker: 'kingsbet', strategy: 'altenar-api', scope: 'live', fetchedAt: now, events };
    expect(validateRawOdds(raw, { minEvents: 1, maxAgeMs: 60_000, now }).ok).toBe(true);
  });
});
