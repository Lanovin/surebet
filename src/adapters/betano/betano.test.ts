import { describe, expect, it } from 'vitest';
import { loadFixture } from '../fixtures.js';
import type { AdapterContext } from '../types.js';
import type { RawEvent } from '../../core/types.js';
import { createLogger } from '../../infra/logger.js';
import { validateRawOdds } from '../../core/validate.js';
import factory from './index.js';
import { parseBetano } from './parse.js';

const ORIGIN = 'https://www.betano.cz';
type Calendars = Record<string, { url: string; body: unknown }>;

const keys = (e: RawEvent) => e.markets.map((m) => m.key);
const odds = (e: RawEvent, key: string) => e.markets.find((m) => m.key === key)?.selections.map((s) => [s.key, s.odds]);
const valid = (events: RawEvent[], scope: 'prematch' | 'live') =>
  validateRawOdds({ bookmaker: 'betano', strategy: 'camoufox', scope, fetchedAt: Date.now(), events }, { minEvents: 1, maxAgeMs: 60_000 }).errors;

describe('betano adapter', () => {
  it('uses the camoufox strategy', () => {
    const ctx = { bookmaker: 'betano', log: createLogger('test') } as unknown as AdapterContext;
    expect(factory(ctx).strategies.map((s) => [s.name, s.level])).toEqual([['camoufox', 5]]);
  });
});

describe('betano parse – upcoming calendar (fixtures/betano/calendar-sports.json, 2026-10-01)', async () => {
  const cal = await loadFixture<Calendars>('betano', 'calendar-sports.json');
  const parse = (code: string) => parseBetano(cal[code].body, { scope: 'prematch', origin: ORIGIN });

  it('football: 1X2, DC, DNB, BTTS, OU and first-half OU', () => {
    const ev = parse('FOOT');
    expect(ev).toHaveLength(4);
    const e = ev[0];
    expect(e).toMatchObject({ sourceId: '93062328', sport: 'football', competition: 'Liga národů', country: 'UEFA', home: 'Řecko', away: 'Nizozemsko', live: false });
    expect(e.startTime).toBe(1790880300000);
    expect(e.url).toBe('https://www.betano.cz/zapas-sance/recko-nizozemsko/93062328/');
    expect(keys(e)).toEqual(['1X2|REG', 'OU|REG|2.5', 'BTTS|REG', 'DC|REG', 'OU|H1|1.5', 'DNB|REG']);
    expect(odds(e, '1X2|REG')).toEqual([['HOME', 3.3], ['DRAW', 3.6], ['AWAY', 2.1]]);
    expect(odds(e, 'DC|REG')).toEqual([['HOME_DRAW', 1.75], ['DRAW_AWAY', 1.35], ['HOME_AWAY', 1.28]]);
    expect(odds(e, 'DNB|REG')).toEqual([['HOME', 2.37], ['AWAY', 1.55]]);
    expect(valid(ev, 'prematch')).toEqual([]);
  });

  it('hockey: regular-time 1X2 and OU, handicap without explicit overtime rule skipped', () => {
    const e = parse('ICEH')[0];
    expect(e).toMatchObject({ sport: 'hockey', home: 'Sparta Praha', away: 'České Budějovice', competition: 'Extraliga', country: 'Česko' });
    expect(keys(e)).toEqual(['1X2|REG', 'OU|REG|5.5']);
    expect(odds(e, '1X2|REG')).toEqual([['HOME', 1.53], ['DRAW', 5], ['AWAY', 4.85]]);
  });

  it('basketball: winner from sixPackBlocks as ML|MATCH, handicap/total skipped', () => {
    const e = parse('BASK')[0];
    expect(e).toMatchObject({ sport: 'basketball', home: 'Hapoel Tel Aviv', away: 'Real Madrid' });
    expect(keys(e)).toEqual(['ML|MATCH']);
    expect(odds(e, 'ML|MATCH')).toEqual([['HOME', 2.45], ['AWAY', 1.55]]);
  });

  it('tennis: winner, games handicap (home line) and games total; selections named by player', () => {
    const e = parse('TENN')[0];
    expect(e).toMatchObject({ sport: 'tennis', home: 'Clement Chidekh', away: 'Ugo Blanchet', competition: 'Mouilleron-Le-Captif', country: 'Challenger' });
    expect(keys(e)).toEqual(['ML|MATCH', 'AH|MATCH|-3.5', 'OU|MATCH|22.5']);
    expect(odds(e, 'ML|MATCH')).toEqual([['HOME', 1.42], ['AWAY', 2.67]]);
    expect(odds(e, 'AH|MATCH|-3.5')).toEqual([['HOME', 1.85], ['AWAY', 1.75]]);
  });

  it('handball, volleyball, table tennis, darts', () => {
    expect(keys(parse('HAND')[0])).toEqual(['1X2|REG', 'OU|REG|55.5']);
    expect(keys(parse('VOLL')[0])).toEqual(['ML|MATCH']);
    expect(parse('TABL')[0]).toMatchObject({ sport: 'table_tennis', home: 'Lukasz Jarocki', away: 'Artur Grela' });
    expect(odds(parse('DART')[0], 'ML|MATCH')).toEqual([['HOME', 2.7], ['AWAY', 1.45]]);
  });

  it('boxing 2-way winner is skipped (draw refund rule unknown)', () => {
    expect(parse('BOXI')).toEqual([]);
  });

  it('all sports validate', () => {
    const all = Object.keys(cal).flatMap(parse);
    expect(new Set(all.map((e) => e.sport))).toEqual(new Set(['football', 'hockey', 'basketball', 'handball', 'volleyball', 'tennis', 'table_tennis', 'darts']));
    expect(valid(all, 'prematch')).toEqual([]);
  });
});

describe('betano parse – live overview (fixtures/betano/live-overview.json, normalized)', async () => {
  const json = await loadFixture('betano', 'live-overview.json');
  const ev = parseBetano(json, { scope: 'live', origin: ORIGIN });

  it('joins events, markets and selections; skips e-sports, golf outrights and unmapped markets', () => {
    expect(ev).toHaveLength(12);
    expect(ev.every((e) => e.live)).toBe(true);
    expect(ev.some((e) => /esport/i.test(`${e.home} ${e.away}`))).toBe(false);
    expect(valid(ev, 'live')).toEqual([]);
  });

  it('football with score and clock, league and zone names', () => {
    const e = ev.find((x) => x.sourceId === '93398260')!;
    expect(e).toMatchObject({ sport: 'football', competition: 'Ligový pohár', country: 'Spojené arabské emiráty', home: 'Al Sharjah Club', away: 'Al Dhafra' });
    expect(e.state).toEqual({ score: [1, 0], clockSec: 1523 });
    expect(odds(e, '1X2|REG')).toEqual([['HOME', 1.25], ['DRAW', 5], ['AWAY', 11.25]]);
    expect(keys(e)).toContain('DC|REG');
  });

  it('tennis: winner by column (doubles name order differs), sets and games in state', () => {
    const e = ev.find((x) => x.sourceId === '93350581')!;
    expect(e).toMatchObject({ sport: 'tennis', home: 'August Holmgren', away: 'Andrea Guerrieri' });
    expect(e.state).toMatchObject({ score: [0, 0], games: [0, 0], points: '0:0' });
    expect(odds(e, 'ML|MATCH')).toEqual([['HOME', 2.25], ['AWAY', 1.57]]);
  });

  it('handball: score and period text from liveData', () => {
    const e = ev.find((x) => x.sourceId === '92895091')!;
    expect(e.state).toMatchObject({ score: [12, 15], statusText: 'P1' });
  });
});
