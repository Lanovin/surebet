// Nové sporty a dvojtip na MerkurXtipu (Altenar, integrace merkurxtip) – zkrácené skutečné payloady z 1. 10. 2026.
// Rozdíl proti Kingsbetu: kurzy se ořezávají (floor) na 2 místa, nabídka stolního tenisu a volejbalu je širší.
import { describe, expect, it } from 'vitest';
import { loadFixture } from '../fixtures.js';
import { validateRawOdds } from '../../core/validate.js';
import { isValidMarketKey } from '../../core/markets.js';
import type { RawEvent, RawOdds } from '../../core/types.js';
import { parseAltenarRaw, type AltenarRaw } from '../common/altenar-api.js';
import { mergeAltenarDetails, parseAltenarList, type AltDetailResponse, type AltListResponse } from '../common/altenar.js';
import { MERKURXTIP } from './index.js';

type Fixture = AltenarRaw & { recordedAt: string };

async function load(name: string, scope: 'prematch' | 'live'): Promise<{ events: RawEvent[]; now: number }> {
  const raw = await loadFixture<Fixture>('merkurxtip', name);
  const now = Date.parse(raw.recordedAt);
  return { events: parseAltenarRaw(raw, MERKURXTIP, scope, now), now };
}

const keys = (e: RawEvent) => e.markets.map((m) => m.key);
function odds(e: RawEvent, key: string): Record<string, number> {
  const m = e.markets.find((x) => x.key === key);
  if (!m) throw new Error(`market ${key} missing on ${e.home} – ${e.away}`);
  return Object.fromEntries(m.selections.map((s) => [s.key, s.odds]));
}

describe('merkurxtip / nové sporty – prematch (1. 10. 2026)', async () => {
  const { events, now } = await load('altenar-api-prematch-newsports-2026-10-01.json', 'prematch');
  const ev = (id: string) => events.find((e) => e.sourceId === id)!;

  it('parsuje házenou, volejbal, americký fotbal, baseball, box, stolní tenis a šipky', () => {
    const by: Record<string, number> = {};
    for (const e of events) by[e.sport] = (by[e.sport] ?? 0) + 1;
    expect(by).toEqual({ handball: 1, volleyball: 1, american_football: 1, baseball: 1, boxing: 1, table_tennis: 2, darts: 1 });
  });

  it('volejbal: vítěz, 1. set, sety (AH_SETS), body celkem a v 1. setu – kurzy oříznuté (1.8334 → 1.83)', () => {
    const e = ev('17863016'); // Valparaiso – UIC
    expect(odds(e, 'ML|MATCH')).toEqual({ HOME: 1.4, AWAY: 2.75 });
    expect(odds(e, 'ML|S1')).toEqual({ HOME: 1.55, AWAY: 2.28 }); // API 1.5556 / 2.2858
    expect(odds(e, 'AH_SETS|MATCH|-1.5')).toEqual({ HOME: 1.83, AWAY: 1.83 });
    expect(odds(e, 'OU|MATCH|175.5')).toEqual({ OVER: 1.83, UNDER: 1.83 });
    expect(odds(e, 'OU|S1|45.5')).toEqual({ OVER: 2.05, UNDER: 1.7 });
    // „Přesný výsledek“ a „lichá/sudá“ se nemapují
    expect(keys(e).every((k) => /^(ML|AH_SETS|OU)\|/.test(k))).toBe(true);
  });

  it('stolní tenis: vítěz, handicap na sety, handicap na body, počet bodů (UOF 187 = sety, 237/238 = body)', () => {
    const e = ev('17876538'); // Svoboda – Kosar
    expect(odds(e, 'ML|MATCH')).toEqual({ HOME: 1.46, AWAY: 2.2 });
    expect(odds(e, 'AH_SETS|MATCH|-1.5')).toEqual({ HOME: 2.2, AWAY: 1.6 });
    expect(odds(e, 'AH|MATCH|-4.5')).toEqual({ HOME: 1.9, AWAY: 1.8 });
    expect(odds(e, 'OU|MATCH|75.5')).toEqual({ OVER: 1.83, UNDER: 1.83 });
    // listing: handicap +4.5 domácích (Smyrnov je outsider) a total 78.5
    const f = ev('17881525');
    expect(odds(f, 'AH|MATCH|4.5')).toEqual({ HOME: 1.77, AWAY: 1.84 });
    expect(odds(f, 'OU|MATCH|78.5')).toEqual({ OVER: 1.81, UNDER: 1.81 });
  });

  it('házená, americký fotbal, baseball: stejné mapování jako u Kingsbetu, jen oříznuté kurzy', () => {
    const h = ev('17885641'); // Ferro Carril Oeste – River Plate
    expect(odds(h, '1X2|REG')).toEqual({ HOME: 1.52, DRAW: 7.5, AWAY: 3 }); // API 1.5295
    expect(odds(h, 'DNB|REG')).toEqual({ HOME: 1.4, AWAY: 2.54 }); // API 2.5455
    expect(odds(h, 'AH|REG|-1.5')).toEqual({ HOME: 1.83, AWAY: 1.83 });
    const a = ev('16551345'); // CLE Browns – PIT Steelers
    expect(keys(a)).not.toContain('ML|MATCH'); // americký fotbal: remíza (NFL) – vítěz se nemapuje
    expect(keys(a).some((k) => k.startsWith('AH|MATCH|'))).toBe(true);
    const b = ev('17843781'); // New York Yankees – Boston Red Sox
    expect(keys(b)).toContain('ML|MATCH');
    expect(keys(b).filter((k) => !k.endsWith('|MATCH') && !k.includes('|MATCH|'))).toEqual([]);
  });

  it('box: 2-cestný vítěz se nemapuje (remíza není potvrzena); šipky: vítěz', () => {
    expect(keys(ev('17879219'))).toEqual([]);
    expect(keys(ev('17891536'))).toEqual(['ML|MATCH']);
  });

  it('klíče jsou platné a validateRawOdds projde; žádný kurz nemá víc než 2 desetinná místa', () => {
    for (const e of events)
      for (const m of e.markets) {
        expect(isValidMarketKey(m.key), m.key).toBe(true);
        for (const s of m.selections) expect(Math.abs(s.odds * 100 - Math.round(s.odds * 100)) < 1e-9, `${m.key} ${s.odds}`).toBe(true);
      }
    const raw: RawOdds = { bookmaker: 'merkurxtip', strategy: 'altenar-api', scope: 'prematch', fetchedAt: now, events };
    expect(validateRawOdds(raw, { minEvents: 1, maxAgeMs: 60_000, now }).ok).toBe(true);
  });
});

describe('merkurxtip / nové sporty – live (1. 10. 2026)', async () => {
  const { events, now } = await load('altenar-api-live-newsports-2026-10-01.json', 'live');
  const by = (id: string) => events.find((e) => e.sourceId === id)!;

  it('volejbal: přestávka mezi sety („První přestávka“) je breakFlag, body sady z pointScore', () => {
    const e = by('17863015'); // Bebedouro U21: 1. set skončil 17:25
    expect(e.state).toMatchObject({ statusText: 'První přestávka', score: [0, 1], period: 1, breakFlag: true, clockRunning: false, points: '17:25' });
    const p = by('17886076');
    expect(p.state).toMatchObject({ statusText: '1. set', period: 1, points: '10:12' });
    expect(p.state?.breakFlag).toBeUndefined();
    // API 1.909 → oříznuto 1.90 (Kingsbet zaokrouhluje na 1.91)
    expect(odds(p, 'OU|MATCH|180.5')).toEqual({ OVER: 1.9, UNDER: 1.83 });
    expect(odds(p, 'ML|MATCH')).toEqual({ HOME: 2.75, AWAY: 1.4 });
  });

  it('baseball: 3. směna, skóre 2:4', () => {
    const e = by('17862972');
    expect(e.state).toMatchObject({ statusText: '3. směna', score: [2, 4], period: 3 });
    expect(odds(e, 'ML|MATCH')).toEqual({ HOME: 2.6, AWAY: 1.47 }); // API 1.476
  });

  it('stolní tenis: body v setu jen když se neliší zdroje (currentSetScore prázdné); zápas bez trhů zůstává s živým stavem', () => {
    const e = by('17878775'); // 2. set, sety 1:1
    expect(e.state).toMatchObject({ statusText: '2. set', score: [1, 1], period: 2, points: '0:0' });
    expect(odds(e, 'AH|MATCH|-3.5')).toEqual({ HOME: 1.8, AWAY: 1.86 });
    // liga, která dává body setu do currentSetScore (8:2) a pointScore 0:0 → body se neuvádějí (nejasný význam)
    const odd = by('17893646');
    expect(odd.state).toMatchObject({ statusText: '1. set', score: [0, 0], period: 1 });
    expect(odd.state?.points).toBeUndefined();
    expect(odd.markets).toEqual([]);
  });

  it('validateRawOdds projde (události bez trhů se do feedu nedávají, ale parser je vrací)', () => {
    const raw: RawOdds = { bookmaker: 'merkurxtip', strategy: 'altenar-api', scope: 'live', fetchedAt: now, events: events.filter((e) => e.markets.length) };
    expect(validateRawOdds(raw, { minEvents: 1, maxAgeMs: 60_000, now }).ok).toBe(true);
  });
});

describe('merkurxtip / dvojtip (UOF 10 / 63 / 85 / 529) ze skutečných detailů', async () => {
  const NOW = Date.parse('2026-09-28T21:25:00Z');
  const events: RawEvent[] = [];
  for (const s of ['football', 'hockey'] as const) {
    const list = await loadFixture<AltListResponse>('merkurxtip', `prematch-events-${s}.json`);
    const detail = await loadFixture<AltDetailResponse>('merkurxtip', `detail-${s}.json`);
    events.push(...mergeAltenarDetails(parseAltenarList(list, MERKURXTIP, { scope: 'prematch', now: NOW }), new Map([[String(detail.id), detail]]), MERKURXTIP));
  }
  const ev = (id: string) => events.find((e) => e.sourceId === id)!;

  it('fotbal: názvy výsledků se liší („Neprohra Zlín“, „Nebude remíza“), rozhoduje UOF id výsledku 9 / 10 / 11', () => {
    const e = ev('17788441'); // Zlín – Slavia: 1X2 8 / 5 / 1.3
    // API 2.8572 / 1.1334 / 1.077 → oříznuto na 2.85 / 1.13 / 1.07
    expect(odds(e, 'DC|REG')).toEqual({ HOME_DRAW: 2.85, HOME_AWAY: 1.13, DRAW_AWAY: 1.07 });
    expect(odds(e, 'DC|H1')).toEqual({ HOME_DRAW: 1.86, HOME_AWAY: 1.4, DRAW_AWAY: 1.1 });
    expect(odds(e, 'DC|H2')).toEqual({ HOME_DRAW: 2.08, HOME_AWAY: 1.3, DRAW_AWAY: 1.09 });
    // dvojtip sedí k 1X2: 1X = 1/(1/8+1/5) ≈ 3.08, 12 ≈ 1.12, X2 ≈ 1.03
    const x = odds(e, '1X2|REG');
    expect(1 / (1 / x.HOME + 1 / x.DRAW)).toBeGreaterThan(odds(e, 'DC|REG').HOME_DRAW);
    expect(keys(e).filter((k) => k.startsWith('DC|'))).toEqual(['DC|REG', 'DC|H1', 'DC|H2']);
  });

  it('fotbalový listing má dvojtip u většiny zápasů', () => {
    expect(events.filter((e) => e.sport === 'football' && keys(e).includes('DC|REG')).length).toBeGreaterThan(30);
  });

  it('hokej: „Dvojtip“ = základní doba, „1 třetina - dvojitá šance“ = P1 (název bez tečky za číslem)', () => {
    const e = ev('17103372'); // Toronto – Montreal
    expect(odds(e, 'DC|REG')).toEqual({ HOME_DRAW: 1.45, HOME_AWAY: 1.22, DRAW_AWAY: 1.52 });
    expect(odds(e, 'DC|P1')).toEqual({ HOME_DRAW: 1.38, HOME_AWAY: 1.38, DRAW_AWAY: 1.41 });
    expect(keys(e)).not.toContain('DC|MATCH');
  });
});
