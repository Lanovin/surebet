import { describe, expect, it } from 'vitest';
import { loadFixture } from '../fixtures.js';
import { validateRawOdds } from '../../core/validate.js';
import { parseMarketKey } from '../../core/markets.js';
import type { RawEvent, RawOdds } from '../../core/types.js';
import { parseRaw, type AltenarRaw } from './strategies.js';
import { altenarState, type AltenarEvent } from './parse.js';
import { uofDef, uofMarketKey } from '../common/uof.js';

type Fixture = AltenarRaw & { recordedAt: string };

async function load(name: string, scope: 'prematch' | 'live'): Promise<{ events: RawEvent[]; now: number }> {
  const raw = await loadFixture<Fixture>('kingsbet', name);
  const now = Date.parse(raw.recordedAt);
  return { events: parseRaw(raw, scope, now), now };
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

  it('fotbal: listing + detail (1X2, OU, AH z pohledu domácích, BTTS, DNB, poločasy)', () => {
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
    expect(odds(e, '1X2|REG')).toEqual({ HOME: 4.2, DRAW: 3.3334, AWAY: 1.7778 });
    expect(odds(e, 'OU|REG|2.5')).toEqual({ OVER: 2.125, UNDER: 1.6154 });
    // domácí jsou outsider -> kladný handicap domácích
    expect(odds(e, 'AH|REG|0.5')).toEqual({ HOME: 1.9, AWAY: 1.7778 });
    expect(odds(e, 'BTTS|REG')).toEqual({ YES: 2, NO: 1.6924 });
    expect(odds(e, 'DNB|REG')).toEqual({ HOME: 3, AWAY: 1.32 });
    expect(odds(e, '1X2|H1')).toEqual({ HOME: 4.75, DRAW: 2.05, AWAY: 2.375 });
    expect(odds(e, 'AH|H1|0')).toEqual({ HOME: 2.6, AWAY: 1.4 });
  });

  it('hokej: 1X2 a totaly v základní době vs. vítěz/totaly vč. prodloužení', () => {
    const e = byId.get('17846461')!;
    expect(e).toMatchObject({ sport: 'hockey', home: 'Amur Chabarovsk', away: 'CHK Neftěchimik Nižněkamsk', competition: 'KHL' });
    expect(odds(e, '1X2|REG')).toEqual({ HOME: 2.2858, DRAW: 4, AWAY: 2.625 });
    expect(odds(e, 'ML|MATCH')).toEqual({ HOME: 1.7858, AWAY: 1.96 });
    expect(odds(e, 'OU|REG|5.5')).toEqual({ OVER: 2.2, UNDER: 1.625 });
    expect(odds(e, 'OU|MATCH|5.5')).toEqual({ OVER: 2.1667, UNDER: 1.6471 });
    expect(odds(e, 'AH|REG|-1.5')).toEqual({ HOME: 3.1429, AWAY: 1.3334 });
  });

  it('tenis: vítěz, handicap/počet gemů, 1. set', () => {
    const e = byId.get('17866749')!;
    expect(e).toMatchObject({ sport: 'tennis', home: 'Gurmanat Kaur Sandhu', away: 'Monique Barry' });
    expect(odds(e, 'ML|MATCH')).toEqual({ HOME: 3.5, AWAY: 1.2308 });
    expect(odds(e, 'AH|MATCH|5.5')).toEqual({ HOME: 1.76, AWAY: 1.8572 });
    expect(odds(e, 'OU|MATCH|19.5')).toEqual({ OVER: 1.9231, UNDER: 1.7143 });
    expect(odds(e, 'ML|S1')).toEqual({ HOME: 3.1, AWAY: 1.2858 });
  });

  it('basket: vítěz/handicap/total vč. prodloužení, 1X2 základní doby, čtvrtiny', () => {
    const e = byId.get('17842210')!;
    expect(e).toMatchObject({ sport: 'basketball', home: 'Club Ateletico Lanus', away: 'Gimnasia de Comodoro' });
    expect(odds(e, 'ML|MATCH')).toEqual({ HOME: 2.4, AWAY: 1.5264 });
    expect(odds(e, 'AH|MATCH|3.5')).toEqual({ HOME: 1.9091, AWAY: 1.7693 });
    expect(odds(e, 'OU|MATCH|156.5')).toEqual({ OVER: 1.8334, UNDER: 1.8334 });
    expect(odds(e, '1X2|REG')).toEqual({ HOME: 2.4546, DRAW: 11, AWAY: 1.5556 });
    expect(odds(e, '1X2|Q1')).toEqual({ HOME: 2.1667, DRAW: 13, AWAY: 1.75 });
    expect(odds(e, 'AH|Q1|2.5')).toEqual({ HOME: 1.6451, AWAY: 2.15 });
  });

  it('scope trhů odpovídá sportu', () => {
    for (const e of events)
      for (const m of e.markets) {
        const { type, scope } = parseMarketKey(m.key);
        if (e.sport === 'football') expect(['REG', 'H1', 'H2']).toContain(scope);
        if (e.sport === 'tennis') expect(scope === 'MATCH' || scope.startsWith('S')).toBe(true);
        if (e.sport === 'basketball') expect(scope).not.toBe('H2');
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

describe('kingsbet / altenar-api live (GetLiveEvents)', async () => {
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
    expect(odds(e, '1X2|REG')).toEqual({ HOME: 1.3125, DRAW: 4.1, AWAY: 9 });
    expect(odds(e, 'OU|REG|4.5')).toEqual({ OVER: 2.6, UNDER: 1.425 });
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

describe('kingsbet / altenar-browser live (stejné API přes Chromium)', async () => {
  const { events, now } = await load('altenar-browser-live.json', 'live');
  it('parsuje se stejně jako HTTP varianta', () => {
    expect(events.length).toBeGreaterThan(0);
    expect(validate(events, 'live', now, 'altenar-browser').ok).toBe(true);
  });
});

describe('kingsbet / přestávky v live stavu (pozorované payloady)', () => {
  const now = Date.parse('2026-09-28T20:51:30Z');
  it('fotbalový poločas: ls "Poločas", timer.isPaused, matchPhase 3', () => {
    const e = {
      liveTime: 'Poločas',
      ls: 'Poločas',
      score: [2, 0],
      timer: { playtime: 2700000, timeUtc: '2026-09-28T20:51:29.655Z', isPaused: true, matchPhase: 3 },
    } as AltenarEvent;
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
    const e = { liveTime: "19'", ls: 'První přestávka', score: [2, 0] } as AltenarEvent;
    expect(altenarState(e, 'hockey', now)).toEqual({ statusText: 'První přestávka', score: [2, 0], period: 1, breakFlag: true, clockSec: 1140 });
  });
  it('tenis přerušen ("Pozastaveno") není přestávka', () => {
    const e = { liveTime: 'Pozastaveno', ls: 'Pozastaveno', score: [0, 0], currentSetScore: [1, 2], pointScore: ['30', '30'] } as AltenarEvent;
    expect(altenarState(e, 'tennis', now)).toEqual({ statusText: 'Pozastaveno', score: [0, 0], games: [1, 2], points: '30:30' });
  });
});

describe('UOF specifikátory v Altenar sv', () => {
  it('period/set/quarter + linie v abecedním pořadí', () => {
    expect(uofMarketKey(uofDef('hockey', 446)!, { periodnr: '1', total: '1.5' })).toBe('OU|P1|1.5');
    expect(uofMarketKey(uofDef('hockey', 460)!, { hcp: '-0.5', periodnr: '2' })).toBe('AH|P2|-0.5');
    expect(uofMarketKey(uofDef('tennis', 204)!, { setnr: '1', total: '10.5' })).toBe('OU|S1|10.5');
    expect(uofMarketKey(uofDef('basketball', 303)!, { hcp: '+2.5', quarternr: '4' })).toBe('AH|Q4|2.5');
    expect(uofDef('hockey', 460)!.specs).toEqual(['hcp', 'periodnr']);
  });
  it('evropský handicap a neznámé trhy se vynechají', () => {
    expect(uofDef('football', 14)).toBeUndefined();
    expect(uofMarketKey(uofDef('football', 16)!, { hcp: '0:1' })).toBeUndefined();
    expect(uofDef('basketball', 83)).toBeUndefined();
  });
});
