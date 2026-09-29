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

  it('does not duplicate an arb when equal odds flip between bookmakers', () => {
    const e = engine();
    e.applyDiff(diff('tipsport', { 1: state({ HOME: 2.2, AWAY: 1.7 }) }, [ev()]));
    e.applyDiff(diff('fortuna', { 1: state({ HOME: 1.7, AWAY: 2.2 }) }));
    e.applyDiff(diff('betano', { 1: state({ HOME: 2.2, AWAY: 1.7 }) }));
    expect(events.filter((x) => x.kind === 'new')).toHaveLength(1);
  });
});
