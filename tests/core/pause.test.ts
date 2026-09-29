import { describe, expect, it } from 'vitest';
import { statusSaysBreak, updatePause, type PauseTracker } from '../../src/core/pause.js';
import { PAUSE_EXPECTED_SEC, PAUSE_FALLBACK_SEC } from '../../config/modes.js';

const cfg = { expectedSec: PAUSE_EXPECTED_SEC, fallbackSec: PAUSE_FALLBACK_SEC };

describe('status text', () => {
  it('recognises breaks', () => {
    for (const t of ['HT', 'Poločas', 'Přestávka', 'Konec 1. třetiny', 'Break', 'End of 2nd quarter', 'Po 2. setu', 'Halftime'])
      expect(statusSaysBreak(t), t).toBe(true);
  });
  it('recognises play', () => {
    for (const t of ['1. poločas', '2. poločas', '2nd half', '3. třetina', '1. set']) expect(statusSaysBreak(t), t).toBe(false);
    expect(statusSaysBreak("67'")).toBe(null);
  });
});

describe('updatePause', () => {
  it('uses feed break flag with expected durations', () => {
    const tr: PauseTracker = {};
    const p = updatePause(tr, { sport: 'hockey', state: { breakFlag: true, period: 1 }, marketOpen: true, now: 1000 }, cfg)!;
    expect(p.type).toBe('hockey_intermission');
    expect(p.expectedSec).toBe(17 * 60);
    expect(p.source).toBe('feed');
    expect(updatePause(tr, { sport: 'hockey', state: { breakFlag: false, period: 2 }, marketOpen: true, now: 5000 }, cfg)).toBeUndefined();
  });

  it('classifies basketball halftime vs quarter break', () => {
    expect(updatePause({}, { sport: 'basketball', state: { statusText: 'Přestávka', period: 2 }, marketOpen: true, now: 0 }, cfg)!.type).toBe('basketball_ht');
    expect(updatePause({}, { sport: 'basketball', state: { statusText: 'Přestávka', period: 1 }, marketOpen: true, now: 0 }, cfg)!.type).toBe('basketball_quarter');
  });

  it('falls back to a stopped clock at the end of a period', () => {
    const tr: PauseTracker = {};
    const st = { clockSec: 45 * 60, score: [1, 0] as [number, number] };
    updatePause(tr, { sport: 'football', state: st, marketOpen: true, now: 0 }, cfg);
    expect(updatePause(tr, { sport: 'football', state: st, marketOpen: true, now: 20_000 }, cfg)).toBeUndefined();
    const p = updatePause(tr, { sport: 'football', state: st, marketOpen: true, now: 50_000 }, cfg)!;
    expect(p.type).toBe('football_ht');
    expect(p.source).toBe('clock_fallback');
    expect(p.startedAt).toBe(0);
    // hodiny se rozběhly -> konec přestávky
    expect(updatePause(tr, { sport: 'football', state: { ...st, clockSec: 45 * 60 + 5 }, marketOpen: true, now: 900_000 }, cfg)).toBeUndefined();
  });

  it('does not treat a mid-period stoppage as a break', () => {
    const tr: PauseTracker = {};
    const st = { clockSec: 23 * 60 + 12, score: [0, 0] as [number, number] };
    updatePause(tr, { sport: 'hockey', state: st, marketOpen: true, now: 0 }, cfg);
    expect(updatePause(tr, { sport: 'hockey', state: st, marketOpen: true, now: 120_000 }, cfg)).toBeUndefined();
  });

  it('detects tennis set break from a fresh set without progress', () => {
    const tr: PauseTracker = {};
    updatePause(tr, { sport: 'tennis', state: { period: 1, games: [5, 4], points: '40-15' }, marketOpen: true, now: 0 }, cfg);
    updatePause(tr, { sport: 'tennis', state: { period: 2, games: [0, 0], points: '0-0' }, marketOpen: true, now: 10_000 }, cfg);
    const p = updatePause(tr, { sport: 'tennis', state: { period: 2, games: [0, 0], points: '0-0' }, marketOpen: true, now: 45_000 }, cfg)!;
    expect(p.type).toBe('tennis_set_break');
    expect(p.expectedSec).toBe(120);
    expect(updatePause(tr, { sport: 'tennis', state: { period: 2, games: [0, 0], points: '15-0' }, marketOpen: true, now: 60_000 }, cfg)).toBeUndefined();
  });
});
