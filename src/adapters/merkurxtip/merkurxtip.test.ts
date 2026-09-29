import { describe, expect, it } from 'vitest';
import { loadFixture } from '../fixtures.js';
import { validateRawOdds } from '../../core/validate.js';
import { isValidMarketKey, parseMarketKey } from '../../core/markets.js';
import type { RawEvent, RawOdds, Sport } from '../../core/types.js';
import type { AltDetailResponse, AltListResponse, AltMarket, AltOdd } from './parse.js';
import { mapMarket, mergeDetails, parseList, parseState } from './parse.js';
import { detailUrl, eventsUrl, liveUrl } from './api.js';

const NOW = Date.parse('2026-09-28T21:25:00Z');
const SPORTS: Sport[] = ['football', 'tennis', 'basketball', 'hockey'];
const odds = (events: RawEvent[], scope: 'prematch' | 'live'): RawOdds => ({
  bookmaker: 'merkurxtip',
  strategy: 'altenar-api',
  scope,
  fetchedAt: NOW,
  events,
});
const mk = (e: RawEvent, key: string) => e.markets.find((m) => m.key === key);
const price = (e: RawEvent, key: string, sel: string) => mk(e, key)?.selections.find((s) => s.key === sel)?.odds;

describe('merkurxtip prematch (altenar-api / browser-fetch: GetEvents + GetEventDetails)', async () => {
  const lists = await Promise.all(SPORTS.map((s) => loadFixture<AltListResponse>('merkurxtip', `prematch-events-${s}.json`)));
  const listed = lists.flatMap((r) => parseList(r, { scope: 'prematch', now: NOW }));
  const details = new Map<string, AltDetailResponse>();
  for (const s of SPORTS) {
    const d = await loadFixture<AltDetailResponse>('merkurxtip', `detail-${s}.json`);
    details.set(String(d.id), d);
  }
  const events = mergeDetails(listed, details);

  it('parses all four sports and validates', () => {
    const by: Record<string, number> = {};
    for (const e of events) by[e.sport] = (by[e.sport] ?? 0) + 1;
    expect(events.length).toBe(163);
    expect(by).toEqual({ football: 41, tennis: 41, basketball: 41, hockey: 40 });
    expect(events.every((e) => !e.live && !e.state)).toBe(true);
    const v = validateRawOdds(odds(events, 'prematch'), { minEvents: 5, maxAgeMs: 60_000, now: NOW });
    expect(v.ok).toBe(true);
    for (const e of events) for (const m of e.markets) expect(isValidMarketKey(m.key)).toBe(true);
  });

  it('listing event: Lens – Sporting CP (main markets, odds truncated to 2 dp)', () => {
    const e = events.find((x) => x.sourceId === '17672472')!;
    expect([e.home, e.away]).toEqual(['Lens', 'Sporting CP']);
    expect(e.competition).toBe('Liga Mistrů');
    expect(e.country).toBe('Evropa');
    expect(e.startTime).toBe(Date.parse('2026-10-13T16:45:00Z'));
    expect(price(e, '1X2|REG', 'HOME')).toBe(2.3);
    expect(price(e, '1X2|REG', 'AWAY')).toBe(2.71); // API 2.7143
    expect(price(e, 'OU|REG|2.5', 'OVER')).toBe(1.55);
    expect(e.url).toBe(`https://www.merkurxtip.cz/sazeni#/sport/66/category/${1133}/championship/16808/event/17672472`);
  });

  it('football detail: Zlín – Slavia Praha', () => {
    const e = events.find((x) => x.sourceId === '17788441')!;
    expect([e.home, e.away]).toEqual(['Zlín', 'Slavia Praha']);
    expect(e.competition).toBe('1.Česko');
    expect(e.country).toBe('Česko');
    expect(e.startTime).toBe(Date.parse('2026-10-09T16:00:00Z'));
    expect(price(e, '1X2|REG', 'HOME')).toBe(8);
    expect(price(e, '1X2|REG', 'DRAW')).toBe(5);
    expect(price(e, '1X2|REG', 'AWAY')).toBe(1.3);
    expect(price(e, 'DNB|REG', 'HOME')).toBe(5.66);
    expect(price(e, 'OU|REG|2.5', 'UNDER')).toBe(2.28);
    expect(price(e, 'BTTS|REG', 'YES')).toBe(1.92);
    // asijský handicap: "1 (+2.5)" 1.32 / "2 (-2.5)" 3.0 → linie z pohledu domácích +2.5
    expect(price(e, 'AH|REG|2.5', 'HOME')).toBe(1.32);
    expect(price(e, 'AH|REG|2.5', 'AWAY')).toBe(3);
    expect(price(e, '1X2|H1', 'DRAW')).toBe(2.57);
    expect(price(e, 'OU_AWAY|REG|2.5', 'OVER')).toBe(2.14);
    expect(price(e, 'OE|REG', 'ODD')).toBe(1.9);
    for (const m of e.markets) {
      const p = parseMarketKey(m.key);
      expect(['REG', 'H1', 'H2']).toContain(p.scope);
      if (p.line !== undefined) expect(Math.abs(p.line * 2 - Math.round(p.line * 2))).toBeLessThan(1e-9); // žádné .25/.75
    }
  });

  it('hockey detail: regular time vs. incl. OT & penalties', () => {
    const e = events.find((x) => x.sourceId === '17103372')!;
    expect([e.home, e.away]).toEqual(['Toronto Maple Leafs', 'Montreal Canadiens']);
    expect(e.competition).toBe('NHL');
    expect(price(e, '1X2|REG', 'DRAW')).toBe(4);
    expect(price(e, 'ML|MATCH', 'HOME')).toBe(1.83);
    expect(price(e, 'OU|REG|4.5', 'OVER')).toBe(1.3); // "Počet gólů" (typeId 18)
    expect(price(e, 'OU|MATCH|4.5', 'OVER')).toBe(1.18); // typeId 412 vč. prodl. a nájezdů
    expect(price(e, 'AH|MATCH|-1.5', 'HOME')).toBe(3);
    expect(price(e, 'AH|MATCH|-1.5', 'AWAY')).toBe(1.3);
    expect(price(e, 'DNB|REG', 'AWAY')).toBe(1.85);
    expect(price(e, '1X2|P1', 'HOME')).toBe(2.65);
    expect(price(e, 'AH|P1|-0.5', 'HOME')).toBe(2.54);
    expect(price(e, 'OU|P1|1.5', 'UNDER')).toBe(1.95);
    for (const m of e.markets) expect(['REG', 'MATCH', 'P1', 'P2', 'P3']).toContain(parseMarketKey(m.key).scope);
  });

  it('basketball and tennis detail', () => {
    const b = events.find((x) => x.sourceId === '17842234')!;
    expect(b.sport).toBe('basketball');
    expect(price(b, 'ML|MATCH', 'AWAY')).toBe(1.57);
    expect(price(b, 'AH|MATCH|5.5', 'HOME')).toBe(1.62);
    expect(price(b, 'OU|MATCH|173.5', 'OVER')).toBe(1.95);
    expect(b.markets.every((m) => parseMarketKey(m.key).scope === 'MATCH')).toBe(true);
    const t = events.find((x) => x.sourceId === '17868582')!;
    expect([t.home, t.away]).toEqual(['Hurkacz, Hubert', 'Davidovich Fokina, Alejandro']);
    expect(price(t, 'ML|MATCH', 'HOME')).toBe(1.64);
    expect(price(t, 'ML|S1', 'AWAY')).toBe(2.05);
    expect(price(t, 'AH_SETS|MATCH|1.5', 'HOME')).toBe(1.22);
    expect(price(t, 'AH|MATCH|-1.5', 'AWAY')).toBe(1.83);
    expect(price(t, 'OU|MATCH|23.5', 'OVER')).toBe(1.86);
    expect(price(t, 'AH|S1|-1.5', 'HOME')).toBe(2.2);
  });
});

describe('merkurxtip live (GetLiveEvents per sport)', async () => {
  const lists = await Promise.all(SPORTS.map((s) => loadFixture<AltListResponse>('merkurxtip', `live-events-${s}.json`)));
  const events = lists.flatMap((r) => parseList(r, { scope: 'live', now: NOW }));

  it('parses live events with state', () => {
    expect(events).toHaveLength(15);
    expect(events.filter((e) => e.sport === 'tennis')).toHaveLength(11);
    expect(events.every((e) => e.live && e.state?.statusText)).toBe(true);
    const v = validateRawOdds(odds(events, 'live'), { minEvents: 1, maxAgeMs: 60_000, now: NOW });
    expect(v.ok).toBe(true);
  });

  it('football halftime is flagged from ls="Poločas" + paused timer', () => {
    const e = events.find((x) => x.sourceId === '17803059')!;
    expect([e.home, e.away]).toEqual(['Independiente Yumbo', 'Orsomarso SC']);
    expect(e.state).toMatchObject({ statusText: 'Poločas', breakFlag: true, clockRunning: false, clockSec: 2700, score: [1, 0] });
    const k = events.find((x) => x.sourceId === '17588788')!;
    expect(k.state).toMatchObject({ statusText: '1. poločas', period: 1, clockRunning: true, score: [1, 0] });
    expect(k.state!.breakFlag).toBeUndefined();
    expect(k.state!.clockSec).toBeGreaterThan(1300);
    expect(price(k, '1X2|REG', 'HOME')).toBeGreaterThan(1);
  });

  it('tennis and hockey state', () => {
    const t = events.find((x) => x.sourceId === '17865213')!;
    expect(t.state).toMatchObject({ statusText: '3. set', period: 3, score: [1, 1], games: [4, 3], points: '40:0' });
    const h = events.find((x) => x.sourceId === '17822895')!;
    expect(h.sport).toBe('hockey');
    expect(h.state).toMatchObject({ statusText: '2. třetina', period: 2, score: [3, 1], clockSec: 38 * 60 }); // liveTime "39'"
    expect(mk(h, 'ML|MATCH')).toBeDefined();
    expect(mk(h, '1X2|REG')).toBeDefined();
  });

  it('hockey intermission: ls "Druhá přestávka"', async () => {
    const r = await loadFixture<AltListResponse>('merkurxtip', 'live-events-hockey-intermission.json');
    const [h] = parseList(r, { scope: 'live', now: NOW });
    expect(h.state).toMatchObject({ statusText: 'Druhá přestávka', breakFlag: true, period: 2, score: [3, 1], clockRunning: false });
  });

  it('break texts', () => {
    const base = { id: 1, name: 'a', sportId: 70, startDate: '2026-09-28T20:00:00Z' };
    expect(parseState({ ...base, ls: 'Přestávka' }, 'hockey', NOW).breakFlag).toBe(true);
    expect(parseState({ ...base, ls: '1. třetina' }, 'hockey', NOW).breakFlag).toBeUndefined();
  });
});

describe('merkurxtip helpers', () => {
  it('builds URLs', () => {
    expect(eventsUrl('hockey')).toMatch(/\/api\/widget\/GetEvents\?.*integration=merkurxtip.*&sportId=70$/);
    expect(liveUrl('football')).toMatch(/GetLiveEvents\?.*&sportId=66$/);
    expect(detailUrl(123)).toMatch(/GetEventDetails\?.*&eventId=123$/);
  });

  it('maps listing AH from market.sv (home line) and rejects unknown selections', () => {
    const m: AltMarket = { id: 1, typeId: 410, name: 'Handicap (včetně prodloužení a nájezdů)', sv: '-1.5', oddIds: [1, 2] };
    const o = new Map<number, AltOdd>([
      [1, { id: 1, typeId: 1714, price: 2.1, oddStatus: 0 }],
      [2, { id: 2, typeId: 1715, price: 1.6, oddStatus: 1 }],
    ]);
    const r = mapMarket('hockey', m, o);
    expect(r).toHaveLength(1);
    expect(r[0].key).toBe('AH|MATCH|-1.5');
    expect(r[0].selections.find((s) => s.key === 'AWAY')!.open).toBe(false);
    // stejný typeId s názvem bez prodloužení → nemapovat jako MATCH
    expect(mapMarket('hockey', { ...m, name: 'Handicap' }, o)).toHaveLength(0);
    // neznámý typ výběru → celý trh pryč
    expect(mapMarket('hockey', m, new Map([[1, { id: 1, typeId: 9, price: 2 }], [2, { id: 2, typeId: 1715, price: 2 }]]))).toHaveLength(0);
  });
});
