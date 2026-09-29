// Simulované strategie pro každou sázkovku – "testovací kurzy" ze sdíleného SimWorld.
import type { BookmakerId, HealthResult, RawOdds } from '../../core/types.js';
import { StrategyError, type Adapter, type FetchRequest, type Strategy, type StrategyLevel } from '../types.js';
import { SimWorld } from './world.js';

class SimStrategy implements Strategy {
  readonly supports = { prematch: true, live: true };
  constructor(
    readonly bookmaker: BookmakerId,
    readonly name: string,
    readonly level: StrategyLevel,
    private latencyMs: [number, number],
  ) {}

  private async delay(): Promise<void> {
    const [a, b] = this.latencyMs;
    await new Promise((r) => setTimeout(r, a + Math.random() * (b - a)));
  }

  async fetch(req: FetchRequest): Promise<RawOdds> {
    const world = SimWorld.get();
    world.start();
    await this.delay();
    const fault = world.fault(this.bookmaker, this.level);
    if (fault) throw new StrategyError(fault, fault.includes('HTTP') ? 'http' : 'other', { simulated: true });
    const events = world.snapshot(this.bookmaker, req.scope).filter((e) => req.sports.includes(e.sport));
    return { bookmaker: this.bookmaker, strategy: this.name, scope: req.scope, fetchedAt: Date.now(), events };
  }

  async healthCheck(): Promise<HealthResult> {
    const t = performance.now();
    await this.delay();
    const fault = SimWorld.get().fault(this.bookmaker, this.level);
    return { ok: !fault, latencyMs: performance.now() - t, message: fault ?? 'ok' };
  }
}

export function createSimAdapter(bookmaker: BookmakerId): Adapter {
  return {
    bookmaker,
    strategies: [
      new SimStrategy(bookmaker, 'sim-json', 2, [15, 60]),
      new SimStrategy(bookmaker, 'sim-browser', 5, [150, 400]),
    ],
  };
}
