import { describe, expect, it } from 'vitest';
import { loadFixture } from '../fixtures.js';
import { validateRawOdds } from '../../core/validate.js';
import { parseMarketKey } from '../../core/markets.js';
import type { RawEvent, RawOdds } from '../../core/types.js';
import { parseAltenarRaw, type AltenarRaw } from '../common/altenar-api.js';
import { altenarState, type AltEvent } from '../common/altenar.js';
import { KINGSBET } from './index.js';

type Fixture = AltenarRaw & { recordedAt: string };

async function load(name: string, scope: 'prematch' | 'live'): Promise<{ events: RawEvent[]; now: number }> {
  const raw = await loadFixture<Fixture>('kingsbet', name);
  const now = Date.parse(raw.recordedAt);
  return { events: parseAltenarRaw(raw, KINGSBET, scope, now), now };
}

function odds(e: RawEvent, key: string): Record<string, number> {
  const m = e.markets.find((x) => x.key === key);
  if (!m) throw new Error(`market ${key} missing on ${e.home} – ${e.away}`);
  return Object.fromEntries(m.selections.map((s) => [s.key, s.odds]));
}

function validate(events: RawEvent[], scope: 'prematch' | 'live', now: number, strategy: string) {
  const raw: RawOdds = { bookmaker: 'kingsbet', strategy, scope, fetchedAt: now, events };
  return validateRawOdds(raw, { minEvents: 1, maxAgeMs: 60_000, now });
}

describe('kingsbet / altenar-api prematch (GetEvents + GetEventDetails)', async () => {
  const { events, now } = await load('altenar-api-prematch.json', 'prematch');
  const byId = new Map(events.map((e) => [e.sourceId, e]));

  it('parsuje všechny čtyři sporty', () => {
    expect(events).toHaveLength(160);
    for (const s of ['basketball', 'football', 'hockey', 'tennis']) expect(events.filter((e) => e.sport === s)).toHaveLength(40);
    expect(events.every((e) => !e.live && e.startTime > now && !e.state)).toBe(true);
  });

  it('fotbal: listing + detail, kurzy zaokrouhlené jako na webu (1X2, OU, AH z pohledu domácích, BTTS, DNB, poločasy)', () => {
    const e = byId.get('17726915')!;
    expect(e).toMatchObject({
      sport: 'football',
      home: 'América-MG',
      away: 'Juventude',
      competition: '2. Brazílie',
      country: 'Brazílie',
      startTime: Date.parse('2026-09-28T22:30:00Z'),
      url: 'https://www.kingsbet.cz/sport?page=event&eventId=17726915&sportId=66',
    });
    // API 3.3334 / 1.7778 → web i tiket 3.33 / 1.78
    expect(odds(e, '1X2|REG')).toEqual({ HOME: 4.2, DRAW: 3.33, AWAY: 1.78 });
    expect(odds(e, 'OU|REG|2.5')).toEqual({ OVER: 2.13, UNDER: 1.62 });
    // domácí jsou outsider -> kladný handicap domácích
    expect(odds(e, 'AH|REG|0.5')).toEqual({ HOME: 1.9, AWAY: 1.78 });
    expect(odds(e, 'BTTS|REG')).toEqual({ YES: 2, NO: 1.69 });
    expect(odds(e, 'DNB|REG')).toEqual({ HOME: 3, AWAY: 1.32 });
    expect(odds(e, '1X2|H1')).toEqual({ HOME: 4.75, DRAW: 2.05, AWAY: 2.38 });
    expect(odds(e, 'AH|H1|0')).toEqual({ HOME: 2.6, AWAY: 1.4 });
  });

  it('čtvrtinové linie (dělené sázky) se nemapují', () => {
    for (const e of events)
      for (const m of e.markets) {
        const { line } = parseMarketKey(m.key);
        if (line !== undefined) expect(Math.abs(line * 2 - Math.round(line * 2))).toBeLessThan(1e-9);
      }
  });

  it('hokej: 1X2 a totaly v základní době vs. vítěz/totaly vč. prodloužení', () => {
    const e = byId.get('17846461')!;
    expect(e).toMatchObject({ sport: 'hockey', home: 'Amur Chabarovsk', away: 'CHK Neftěchimik Nižněkamsk', competition: 'KHL' });
    expect(odds(e, '1X2|REG')).toEqual({ HOME: 2.29, DRAW: 4, AWAY: 2.63 });
    expect(odds(e, 'ML|MATCH')).toEqual({ HOME: 1.79, AWAY: 1.96 });
    expect(odds(e, 'OU|REG|5.5')).toEqual({ OVER: 2.2, UNDER: 1.63 });
    expect(odds(e, 'OU|MATCH|5.5')).toEqual({ OVER: 2.17, UNDER: 1.65 });
    expect(odds(e, 'AH|REG|-1.5')).toEqual({ HOME: 3.14, AWAY: 1.33 });
  });

  it('tenis: vítěz, handicap/počet gemů, 1. set', () => {
    const e = byId.get('17866749')!;
    expect(e).toMatchObject({ sport: 'tennis', home: 'Gurmanat Kaur Sandhu', away: 'Monique Barry' });
    expect(odds(e, 'ML|MATCH')).toEqual({ HOME: 3.5, AWAY: 1.23 });
    expect(odds(e, 'AH|MATCH|5.5')).toEqual({ HOME: 1.76, AWAY: 1.86 });
    expect(odds(e, 'OU|MATCH|19.5')).toEqual({ OVER: 1.92, UNDER: 1.71 });
    expect(odds(e, 'ML|S1')).toEqual({ HOME: 3.1, AWAY: 1.29 });
  });

  it('basket: vítěz/handicap/total vč. prodloužení, 1X2 základní doby, čtvrtiny (sv "40.5|1" = total|čtvrtina)', () => {
    const e = byId.get('17842210')!;
    expect(e).toMatchObject({ sport: 'basketball', home: 'Club Ateletico Lanus', away: 'Gimnasia de Comodoro' });
    expect(odds(e, 'ML|MATCH')).toEqual({ HOME: 2.4, AWAY: 1.53 });
    expect(odds(e, 'AH|MATCH|3.5')).toEqual({ HOME: 1.91, AWAY: 1.77 });
    expect(odds(e, 'OU|MATCH|156.5')).toEqual({ OVER: 1.83, UNDER: 1.83 });
    expect(odds(e, '1X2|REG')).toEqual({ HOME: 2.45, DRAW: 11, AWAY: 1.56 });
    expect(odds(e, '1X2|Q1')).toEqual({ HOME: 2.17, DRAW: 13, AWAY: 1.75 });
    expect(odds(e, 'AH|Q1|2.5')).toEqual({ HOME: 1.65, AWAY: 2.15 });
    const q1 = e.markets.filter((m) => /^OU\|Q1\|/.test(m.key)).map((m) => parseMarketKey(m.key).line!);
    expect(q1.length).toBeGreaterThan(0);
    expect(q1.every((l) => l > 20)).toBe(true); // linie, ne číslo čtvrtiny
  });

  it('scope trhů odpovídá sportu', () => {
    for (const e of events)
      for (const m of e.markets) {
        const { type, scope } = parseMarketKey(m.key);
        if (e.sport === 'football') expect(['REG', 'H1', 'H2']).toContain(scope);
        if (e.sport === 'tennis') expect(scope === 'MATCH' || scope.startsWith('S')).toBe(true);
        if (e.sport === 'basketball') expect(scope).not.toBe('H2');
        if (e.sport === 'hockey') expect(['REG', 'MATCH', 'P1', 'P2', 'P3']).toContain(scope);
        if (type === 'ML') expect(scope === 'MATCH' || scope.startsWith('S')).toBe(true);
        if (type === '1X2') expect(scope).not.toBe('MATCH');
      }
  });

  it('validateRawOdds projde', () => {
    const v = validate(events, 'prematch', now, 'altenar-api');
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.stats.droppedOdds).toBe(0);
    expect(v.stats.markets).toBeGreaterThan(400);
  });
});

describe('kingsbet / altenar-api live (GetLiveEvents, 28. 9.)', async () => {
  const { events, now } = await load('altenar-api-live.json', 'live');
  const byId = new Map(events.map((e) => [e.sourceId, e]));

  it('parsuje live události s herním stavem', () => {
    expect(events).toHaveLength(17);
    expect(events.filter((e) => e.sport === 'football')).toHaveLength(5);
    expect(events.filter((e) => e.sport === 'tennis')).toHaveLength(11);
    expect(events.every((e) => e.live && e.state)).toBe(true);
  });

  it('fotbal: text stavu, skóre, perioda, běžící hodiny', () => {
    const e = byId.get('17783396')!;
    expect(e).toMatchObject({ home: 'Tembetary', away: 'Paraguari AC', sport: 'football' });
    expect(e.state).toMatchObject({ statusText: '2. poločas', score: [2, 1], period: 2, clockRunning: true });
    expect(e.state!.clockSec).toBeGreaterThan(45 * 60);
    expect(odds(e, '1X2|REG')).toEqual({ HOME: 1.31, DRAW: 4.1, AWAY: 9 });
    expect(odds(e, 'OU|REG|4.5')).toEqual({ OVER: 2.6, UNDER: 1.43 });
  });

  it('tenis: sety, gemy a body', () => {
    const e = byId.get('17865213')!;
    expect(e.state).toEqual({ statusText: '3. set', score: [1, 1], period: 3, games: [3, 1], points: '15:40' });
    expect(e.markets.find((m) => m.key === 'ML|MATCH')).toBeDefined();
  });

  it('hokej: třetina a skóre', () => {
    const e = byId.get('17822895')!;
    expect(e.state).toMatchObject({ statusText: '2. třetina', period: 2, score: [2, 1] });
  });

  it('validateRawOdds projde', () => {
    const v = validate(events, 'live', now, 'altenar-api');
    expect(v.ok).toBe(true);
    expect(v.stats.droppedOdds).toBe(0);
  });
});

describe('kingsbet / live 30. 9. – náhradní trhy, pozastavené zápasy, odpočet (skutečné payloady)', async () => {
  const { events, now } = await load('altenar-api-live-2026-09-30.json', 'live');
  const byName = (s: string) => events.find((e) => e.home.startsWith(s))!;

  it('náhradní trh „N. gól“ (typeId 1 + isAlt) se nesmí stát 1X2', () => {
    // Skotsko U21 3:1: listing má místo zavřeného 1X2 trh „5. gól“ (1 1.3704 / Nikdo 5.5 / 2 4.3334)
    const sk = byName('Skotsko U21');
    expect(sk.state).toMatchObject({ score: [3, 1], period: 1 });
    // dvojtip (typeId 10) zůstává: 1X a 12 suspendované (cena 1, oddStatus 7) → jen X2
    expect(sk.markets.map((m) => m.key)).toEqual(['DC|REG', 'OU|REG|5.5']);
    expect(odds(sk, 'DC|REG')).toEqual({ DRAW_AWAY: 12 });
    // Portugalsko U21 – Gibraltar U21 0:0: „1. gól“ (2 @ 9) dřív vypadal jako výhra Gibraltaru za 9
    expect(byName('Portugalsko U21').markets.find((m) => m.key === '1X2|REG')).toBeUndefined();
    // skutečné 1X2 („Výsledek zápasu“) zůstává
    expect(odds(byName('Lyon'), '1X2|REG')).toEqual({ HOME: 1.58, DRAW: 4, AWAY: 5 });
    // live dvojtip „Výsledek zápasu – dvojtip“: 9 = 1X, 10 = 12, 11 = X2 (API 1.1334 → web 1.13)
    expect(odds(byName('Lyon'), 'DC|REG')).toEqual({ HOME_DRAW: 1.13, HOME_AWAY: 1.2, DRAW_AWAY: 2.25 });
    // nikde žádný výběr "Nikdo" ani trh z „N. gól“
    for (const e of events) for (const m of e.markets) expect(m.rawName ?? '').not.toMatch(/gól$/);
  });

  it('status 5 (pozastaveno, i hodiny po konci) → všechny trhy zavřené', () => {
    const t = byName('Lehečka');
    expect(t.state).toMatchObject({ statusText: '2. set', score: [1, 0], games: [6, 3] });
    expect(t.markets.length).toBeGreaterThan(0);
    expect(t.markets.every((m) => !m.open && m.selections.every((s) => s.open === false))).toBe(true);
    expect(byName('Ferrari F').markets.every((m) => !m.open)).toBe(true);
  });

  it('suspendované výběry (oddStatus 7, cena 0) se vynechají, trh bez kurzů zmizí', () => {
    const r = byName('Rangers');
    expect(r.markets).toEqual([]);
  });

  it('basket: odpočet čtvrtiny → periodRemainingSec, ne uplynulý čas', () => {
    const b = byName('Maccabi');
    expect(b.state).toMatchObject({ statusText: '3. čtvrtina', period: 3, clockRunning: true, score: [46, 52] });
    expect(b.state!.clockSec).toBeUndefined();
    expect(b.state!.periodRemainingSec).toBeGreaterThan(0);
    expect(b.state!.periodRemainingSec).toBeLessThanOrEqual(600);
    expect(odds(b, 'ML|MATCH')).toEqual({ HOME: 1.84, AWAY: 1.9 });
  });

  it('hokej: přestávka, základní doba vs. vč. prodloužení', () => {
    const h = byName('Glasgow');
    expect(h.state).toMatchObject({ statusText: 'První přestávka', breakFlag: true, period: 1, clockRunning: false });
    expect(h.markets.map((m) => m.key).sort()).toEqual(['1X2|REG', 'AH|MATCH|-0.5', 'AH|REG|0.5', 'ML|MATCH', 'OU|MATCH|5.5', 'OU|REG|4.5']);
  });

  it('validateRawOdds projde', () => {
    const v = validate(events, 'live', now, 'altenar-api');
    expect(v.errors).toEqual([]);
    expect(v.stats.droppedOdds).toBe(0);
  });
});

describe('kingsbet / altenar-browser live (stejné API přes Chromium)', async () => {
  const { events, now } = await load('altenar-browser-live.json', 'live');
  it('parsuje se stejně jako HTTP varianta', () => {
    expect(events.length).toBeGreaterThan(0);
    expect(validate(events, 'live', now, 'altenar-browser').ok).toBe(true);
  });
});

describe('kingsbet / přestávky v live stavu (pozorované payloady)', () => {
  const now = Date.parse('2026-09-28T20:51:30Z');
  const base = { id: 1, name: 'a vs. b', sportId: 66, startDate: '2026-09-28T20:00:00Z' };
  it('fotbalový poločas: ls "Poločas", timer.isPaused, matchPhase 3', () => {
    const e: AltEvent = {
      ...base,
      liveTime: 'Poločas',
      ls: 'Poločas',
      score: [2, 0],
      timer: { playtime: 2700000, timeUtc: '2026-09-28T20:51:29.655Z', isPaused: true, matchPhase: 3 },
    };
    expect(altenarState(e, 'football', now)).toEqual({
      statusText: 'Poločas',
      score: [2, 0],
      period: 1,
      breakFlag: true,
      clockSec: 2700,
      clockRunning: false,
    });
  });
  it('hokejová přestávka: ls "První přestávka"', () => {
    const e: AltEvent = { ...base, sportId: 70, liveTime: "19'", ls: 'První přestávka', score: [2, 0] };
    expect(altenarState(e, 'hockey', now)).toEqual({ statusText: 'První přestávka', score: [2, 0], period: 1, breakFlag: true, clockSec: 1140, clockRunning: false });
  });
  it('tenis přerušen ("Pozastaveno") není přestávka', () => {
    const e: AltEvent = { ...base, sportId: 68, liveTime: 'Pozastaveno', ls: 'Pozastaveno', score: [0, 0], currentSetScore: [1, 2], pointScore: ['30', '30'] };
    expect(altenarState(e, 'tennis', now)).toEqual({ statusText: 'Pozastaveno', score: [0, 0], games: [1, 2], points: '30:30' });
  });
});
