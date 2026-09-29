import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdapterRunner, PROBE_INTERVAL_MS, type HealthEvent } from '../../src/adapters/runner.js';
import type { AdapterContext, Strategy } from '../../src/adapters/types.js';
import { StrategyError } from '../../src/adapters/types.js';
import { defaultSettings } from '../../src/core/settings.js';
import type { RawOdds } from '../../src/core/types.js';

function strategy(name: string, level: 1 | 2 | 3 | 4 | 5, behaviour: { fail: () => boolean }): Strategy & { calls: number } {
  const s = {
    name,
    level,
    calls: 0,
    supports: { prematch: true, live: false },
    async fetch(): Promise<RawOdds> {
      s.calls++;
      if (behaviour.fail()) throw new StrategyError('HTTP 503', 'http', { status: 503 });
      return {
        bookmaker: 'fortuna',
        strategy: name,
        scope: 'prematch',
        fetchedAt: Date.now(),
        events: Array.from({ length: 5 }, (_, i) => ({
          sourceId: String(i), sport: 'football' as const, competition: 'L', home: `H${i}`, away: `A${i}`, startTime: Date.now() + 3600e3, live: false,
          markets: [{ key: '1X2|REG', open: true, selections: [{ key: 'HOME' as const, odds: 2 }, { key: 'DRAW' as const, odds: 3 }, { key: 'AWAY' as const, odds: 4 }] }],
        })),
      };
    },
    async healthCheck() {
      return { ok: true, latencyMs: 1 };
    },
  };
  return s;
}

const ctx = {
  bookmaker: 'fortuna',
  fixtures: { saveBroken: async () => null },
  log: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } },
} as unknown as AdapterContext;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('circuit breaker / strategy ladder', () => {
  it('degrades after 3 failures, switches to next level, probes back after 10 min', async () => {
    let primaryDown = true;
    const primary = strategy('rest', 2, { fail: () => primaryDown });
    const fallback = strategy('browser', 5, { fail: () => false });
    const health: HealthEvent[] = [];
    const data: RawOdds[] = [];
    const settings = defaultSettings();
    settings.modes.PREMATCH.pollMinMs = 1000;
    settings.modes.PREMATCH.pollMaxMs = 1000;
    const r = new AdapterRunner({ bookmaker: 'fortuna', strategies: [fallback, primary] }, ctx, {
      onData: (raw) => void data.push(raw),
      onHealth: (e) => health.push(e),
      liveDemand: () => 'IDLE',
      settings: () => settings,
    });
    r.start();
    await vi.advanceTimersByTimeAsync(3500);
    expect(primary.calls).toBe(3);
    expect(health.map((h) => h.event)).toEqual(['diagnostic', 'strategy_switch']);
    expect(health[1]).toMatchObject({ strategy: 'browser', prevStrategy: 'rest', state: 'DEGRADED' });
    expect(data.at(-1)?.strategy).toBe('browser');
    expect(r.status().state).toBe('DEGRADED');

    primaryDown = false;
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS + 2000);
    const back = health.find((h) => h.event === 'strategy_switch' && h.strategy === 'rest');
    expect(back?.reason).toMatch(/probe/);
    expect(r.status().state).toBe('OK');
    expect(data.at(-1)?.strategy).toBe('rest');
    await r.stop();
  });

  it('goes BLOCKED when every strategy fails and recovers later', async () => {
    let down = true;
    const a = strategy('a', 2, { fail: () => down });
    const b = strategy('b', 5, { fail: () => down });
    const health: HealthEvent[] = [];
    const settings = defaultSettings();
    settings.modes.PREMATCH.pollMinMs = 500;
    settings.modes.PREMATCH.pollMaxMs = 500;
    const r = new AdapterRunner({ bookmaker: 'fortuna', strategies: [a, b] }, ctx, {
      onData: () => {},
      onHealth: (e) => health.push(e),
      liveDemand: () => 'IDLE',
      settings: () => settings,
    });
    r.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(r.status().state).toBe('BLOCKED');
    expect(health.some((h) => h.event === 'state_change' && h.state === 'BLOCKED')).toBe(true);
    down = false;
    await vi.advanceTimersByTimeAsync(61_000);
    expect(r.status().state).toBe('OK');
    await r.stop();
  });
});
