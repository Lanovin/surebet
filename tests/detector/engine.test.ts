import { beforeEach, describe, expect, it } from 'vitest';
import { ArbEngine, type ActiveArb } from '../../src/services/detector/engine.js';
import { defaultSettings, type Settings } from '../../src/core/settings.js';
import type { BookEventState, EventView, OddsDiffMessage } from '../../src/shared/protocol.js';
import type { BookmakerId } from '../../src/core/types.js';

let now = 1_000_000;
let settings: Settings;
let events: { kind: string; arb: ActiveArb }[];

function ev(mode: EventView['mode'] = 'PREMATCH', extra: Partial<EventView> = {}): EventView {
  return {
    id: 1, sport: 'football', competition: 'Liga', home: 'A', away: 'B', startTime: now + 3600e3, mode, live: mode !== 'PREMATCH',
    finished: false, books: ['tipsport', 'fortuna'], isSim: true, updatedAt: now, ...extra,
  };
}

function state(odds: Record<string, number>, open = true, seenAt = now): BookEventState {
  const sels: BookEventState['markets'][string]['sels'] = {};
  for (const [k, o] of Object.entries(odds)) sels[k as 'HOME'] = { odds: o, open, changedAt: now };
  return { sourceEventId: 'x', swapped: false, scope: 'prematch', seenAt, markets: { 'DNB|REG': { open, sels } } };
}

function diff(bk: BookmakerId | null, st: Record<number, BookEventState>, evs: EventView[] = []): OddsDiffMessage {
  const changes = Object.entries(st).flatMap(([id, s]) =>
    Object.entries(s.markets).flatMap(([m, mk]) => Object.entries(mk.sels).map(([sel, v]) => ({ eventId: Number(id), market: m, sel: sel as 'HOME', odds: v!.odds, prev: null, status: 'open' as const }))),
  );
  return { bk, scope: 'prematch', fetchedAt: now, publishedAt: now, seen: Object.keys(st).map(Number), removed: [], states: st, changes, events: evs };
}

function engine() {
  return new ArbEngine({
    settings: () => settings,
    now: () => now,
    predict: () => null,
    emit: (kind, arb) => events.push({ kind, arb: { ...arb } }),
    persistNew: () => {},
    persistTick: () => {},
    persistEnd: () => {},
  });
}

beforeEach(() => {
  now = 1_000_000;
  settings = defaultSettings();
  settings.consensus.minBooks = 5; // v testu jen 2 sázkovky – konsenzus vypnout
  settings.modes.LIVE.confirmMs = 0; // potvrzovací okno testuje samostatný test
  settings.modes.PAUSED.confirmMs = 0;
  events = [];
});

describe('ArbEngine', () => {
  it('detects an arb from best odds across bookmakers and computes stakes', () => {
    const e = engine();
    e.applyDiff(diff('tipsport', { 1: state({ HOME: 2.2, AWAY: 1.7 }) }, [ev()]));
    expect(events).toHaveLength(0);
    e.applyDiff(diff('fortuna', { 1: state({ HOME: 1.7, AWAY: 2.2 }) }));
    expect(events.map((x) => x.kind)).toEqual(['new']);
    const arb = events[0].arb;
    expect(arb.margin).toBeCloseTo(10, 5);
    expect(arb.legs.map((l) => `${l.selection}:${l.bookmaker}`)).toEqual(['HOME:tipsport', 'AWAY:fortuna']);
    expect(arb.stakes.positive).toBe(true);
    expect(arb.stakes.stakes.every(Number.isInteger)).toBe(true);
  });

  it('ends with leg_odds_changed:<bookmaker> when a leg drops the margin below threshold', () => {
    const e = engine();
    e.applyDiff(diff('tipsport', { 1: state({ HOME: 2.2, AWAY: 1.7 }) }, [ev()]));
    e.applyDiff(diff('fortuna', { 1: state({ HOME: 1.7, AWAY: 2.2 }) }));
    now += 5000;
    e.applyDiff(diff('fortuna', { 1: state({ HOME: 1.7, AWAY: 1.8 }) }));
    const end = events.find((x) => x.kind === 'end')!;
    expect(end.arb.endReason).toBe('leg_odds_changed:fortuna');
    expect(end.arb.endedAt! - end.arb.firstSeen).toBe(5000);
  });

  it('tracks margin changes as updates while the arb survives', () => {
    const e = engine();
    e.applyDiff(diff('tipsport', { 1: state({ HOME: 2.2, AWAY: 1.7 }) }, [ev()]));
    e.applyDiff(diff('fortuna', { 1: state({ HOME: 1.7, AWAY: 2.2 }) }));
    now += 1000;
    e.applyDiff(diff('fortuna', { 1: state({ HOME: 1.7, AWAY: 2.3 }) }));
    const upd = events.find((x) => x.kind === 'update')!;
    expect(upd.arb.margin).toBeGreaterThan(upd.arb.prevMargin!);
    expect(upd.arb.maxMargin).toBe(upd.arb.margin);
  });

  it('ends with suspended when a leg market closes', () => {
    const e = engine();
    e.applyDiff(diff('tipsport', { 1: state({ HOME: 2.2, AWAY: 1.7 }) }, [ev()]));
    e.applyDiff(diff('fortuna', { 1: state({ HOME: 1.7, AWAY: 2.2 }) }));
    e.applyDiff(diff('tipsport', { 1: state({ HOME: 2.2, AWAY: 1.7 }, false) }));
    expect(events.at(-1)!.arb.endReason).toBe('suspended');
    expect(events.at(-1)!.arb.endBookmaker).toBe('tipsport');
  });

  it('ends with event_started / pause_ended on mode transitions (censored)', () => {
    const e = engine();
    e.applyDiff(diff('tipsport', { 1: state({ HOME: 2.2, AWAY: 1.7 }) }, [ev()]));
    e.applyDiff(diff('fortuna', { 1: state({ HOME: 1.7, AWAY: 2.2 }) }));
    e.applyDiff(diff(null, {}, [ev('LIVE')]));
    expect(events.find((x) => x.kind === 'end')!.arb.endReason).toBe('event_started');
    // v LIVE (práh 1,5 %) arb vznikne znovu, pak přestávka a konec přestávky
    expect(events.filter((x) => x.kind === 'new')).toHaveLength(2);
    expect(events.at(-1)!.arb.mode).toBe('LIVE');
    e.applyDiff(diff(null, {}, [ev('PAUSED', { pause: { type: 'football_ht', startedAt: now, expectedSec: 900, source: 'feed' } })]));
    expect(events.filter((x) => x.kind === 'end').at(-1)!.arb.endReason).toBe('pause_started');
    e.applyDiff(diff(null, {}, [ev('LIVE')]));
    expect(events.filter((x) => x.kind === 'end').at(-1)!.arb.endReason).toBe('pause_ended');
  });

  it('ends stale legs in sweep and on threshold change', () => {
    const e = engine();
    e.applyDiff(diff('tipsport', { 1: state({ HOME: 2.2, AWAY: 1.7 }) }, [ev()]));
    e.applyDiff(diff('fortuna', { 1: state({ HOME: 1.7, AWAY: 2.2 }) }));
    now += settings.modes.PREMATCH.maxLegAgeMs + 1;
    e.sweep();
    expect(events.at(-1)!.arb.endReason).toMatch(/^stale:/);

    now += 1;
    e.applyDiff(diff('tipsport', { 1: state({ HOME: 2.2, AWAY: 1.7 }) }));
    e.applyDiff(diff('fortuna', { 1: state({ HOME: 1.7, AWAY: 2.2 }) }));
    expect(e.active.size).toBe(1);
    settings.modes.PREMATCH.minMarginPct = 15;
    e.reevaluateAll();
    expect(events.at(-1)!.arb.endReason).toBe('threshold_changed');
    expect(e.active.size).toBe(0);
  });

  it('ignores outliers against consensus', () => {
    settings.consensus.minBooks = 2;
    const e = engine();
    e.applyDiff(diff('tipsport', { 1: state({ HOME: 1.9, AWAY: 1.9 }) }, [ev()]));
    e.applyDiff(diff('fortuna', { 1: state({ HOME: 1.9, AWAY: 1.9 }) }));
    e.applyDiff(diff('betano', { 1: state({ HOME: 5.0, AWAY: 1.9 }) })); // zjevně chybný kurz
    expect(events.filter((x) => x.kind === 'new')).toHaveLength(0);
  });

  it('live: arb z rozdílné fáze pollingu vznikne až po potvrzení čerstvými daty druhé sázkovky', () => {
    const e = engine();
    const live = (odds: Record<string, number>, changedAt: number, seenAt: number): BookEventState => {
      const st = state(odds, true, seenAt);
      st.scope = 'live';
      for (const s of Object.values(st.markets['DNB|REG'].sels)) s!.changedAt = changedAt;
      return st;
    };
    // tipsport stažen v t=0, fortuna v t=+800 ms s novým kurzem (např. po gólu)
    e.applyDiff({ ...diff('tipsport', { 1: live({ HOME: 2.2, AWAY: 1.7 }, now, now) }, [ev('LIVE')]), scope: 'live' });
    now += 800;
    e.applyDiff({ ...diff('fortuna', { 1: live({ HOME: 1.7, AWAY: 2.2 }, now, now) }), scope: 'live' });
    expect(events.filter((x) => x.kind === 'new')).toHaveLength(0); // data tipsportu jsou starší než změna fortuny
    // další stažení tipsportu: kurz se nezměnil (jen "seen") → teď je arb potvrzený
    now += 900;
    e.applyDiff({ bk: 'tipsport', scope: 'live', fetchedAt: now, publishedAt: now, seen: [1], removed: [], states: {}, changes: [], events: [] });
    expect(events.filter((x) => x.kind === 'new')).toHaveLength(1);
  });

  it('live: když druhá sázkovka mezitím kurz srovná, arb nevznikne vůbec', () => {
    const e = engine();
    const live = (odds: Record<string, number>): BookEventState => ({ ...state(odds), scope: 'live' });
    e.applyDiff({ ...diff('tipsport', { 1: live({ HOME: 2.2, AWAY: 1.7 }) }, [ev('LIVE')]), scope: 'live' });
    now += 800;
    e.applyDiff({ ...diff('fortuna', { 1: live({ HOME: 1.7, AWAY: 2.2 }) }), scope: 'live' });
    now += 900;
    e.applyDiff({ ...diff('tipsport', { 1: live({ HOME: 1.75, AWAY: 2.1 }) }), scope: 'live' });
    expect(events.filter((x) => x.kind === 'new')).toHaveLength(0);
  });

  it('live: potvrzovací okno – arb kratší než confirmMs se neukáže, delší ano (životnost od začátku)', () => {
    settings.modes.LIVE.confirmMs = 1500;
    const e = engine();
    const live = (odds: Record<string, number>): BookEventState => ({ ...state(odds), scope: 'live' });
    e.applyDiff({ ...diff('tipsport', { 1: live({ HOME: 2.2, AWAY: 1.7 }) }, [ev('LIVE')]), scope: 'live' });
    e.applyDiff({ ...diff('fortuna', { 1: live({ HOME: 1.7, AWAY: 2.2 }) }), scope: 'live' });
    expect(events).toHaveLength(0);
    // za 300 ms tipsport srovná kurz → kandidát zmizí, nic se neukáže ani po uplynutí okna
    now += 300;
    e.applyDiff({ ...diff('tipsport', { 1: live({ HOME: 1.75, AWAY: 2.1 }) }), scope: 'live' });
    now += 2000;
    e.sweep();
    expect(events).toHaveLength(0);
    // nový kandidát, který vydrží → vznikne v sweep po 1,5 s, firstSeen = začátek kandidáta
    e.applyDiff({ bk: 'fortuna', scope: 'live', fetchedAt: now, publishedAt: now, seen: [1], removed: [], states: {}, changes: [], events: [] });
    e.applyDiff({ ...diff('tipsport', { 1: live({ HOME: 2.2, AWAY: 1.7 }) }), scope: 'live' });
    const start = now;
    now += 1000;
    e.sweep();
    expect(events).toHaveLength(0);
    now += 600;
    e.applyDiff({ bk: 'fortuna', scope: 'live', fetchedAt: now, publishedAt: now, seen: [1], removed: [], states: {}, changes: [], events: [] });
    e.applyDiff({ bk: 'tipsport', scope: 'live', fetchedAt: now, publishedAt: now, seen: [1], removed: [], states: {}, changes: [], events: [] });
    e.sweep();
    const created = events.filter((x) => x.kind === 'new');
    expect(created).toHaveLength(1);
    expect(created[0].arb.firstSeen).toBe(start);
  });

  it('prematch arb nečeká (confirmMs 0)', () => {
    const e = engine();
    e.applyDiff(diff('tipsport', { 1: state({ HOME: 2.2, AWAY: 1.7 }) }, [ev()]));
    e.applyDiff(diff('fortuna', { 1: state({ HOME: 1.7, AWAY: 2.2 }) }));
    expect(events.filter((x) => x.kind === 'new')).toHaveLength(1);
  });

  it('does not duplicate an arb when equal odds flip between bookmakers', () => {
    const e = engine();
    e.applyDiff(diff('tipsport', { 1: state({ HOME: 2.2, AWAY: 1.7 }) }, [ev()]));
    e.applyDiff(diff('fortuna', { 1: state({ HOME: 1.7, AWAY: 2.2 }) }));
    e.applyDiff(diff('betano', { 1: state({ HOME: 2.2, AWAY: 1.7 }) }));
    expect(events.filter((x) => x.kind === 'new')).toHaveLength(1);
  });
});
