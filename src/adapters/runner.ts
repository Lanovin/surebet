// Spouštění adaptéru: plánování sběru podle režimu, žebříček strategií a circuit breaker.
//  - 3 selhání po sobě -> (pokus o repair) -> strategie DEGRADED -> přepnutí na další úroveň
//  - každých 10 min zkouška levnější strategie, při úspěchu návrat
//  - každá změna stavu / přepnutí -> hook onHealth (tabulka adapter_health + živá notifikace)
import type { AdapterState, BookmakerId, FeedScope, RawOdds, Sport } from '../core/types.js';
import { SPORTS } from '../core/types.js';
import { validateRawOdds } from '../core/validate.js';
import type { Settings } from '../core/settings.js';
import type { Adapter, AdapterContext, Strategy } from './types.js';
import { StrategyError } from './types.js';

export const FAILURES_TO_DEGRADE = 3;
export const PROBE_INTERVAL_MS = 10 * 60_000;
export const BLOCKED_RETRY_MS = 60_000;
const IDLE_LIVE_POLL_MS = 5_000;
const PUSH_WATCHDOG_MS = 15_000;

export type LiveDemand = 'LIVE' | 'PAUSED' | 'IDLE';

export interface HealthEvent {
  bookmaker: BookmakerId;
  scope: FeedScope;
  event: 'state_change' | 'strategy_switch' | 'probe' | 'diagnostic';
  strategy: string;
  level: number;
  state: AdapterState;
  prevState?: AdapterState;
  prevStrategy?: string;
  reason?: string;
  details?: Record<string, unknown>;
}

export interface StrategyStatus {
  name: string;
  level: number;
  status: 'OK' | 'DEGRADED' | 'UNTESTED';
  failures: number;
  lastError?: string;
  degradedAt?: number;
  lastOkAt?: number;
}

export interface ScopeStatus {
  scope: FeedScope;
  state: AdapterState;
  active: string | null;
  activeLevel: number | null;
  push: boolean;
  lastOkAt: number | null;
  lastDataAt: number | null;
  lastError: string | null;
  lastLatencyMs: number | null;
  events: number;
  intervalMs: number;
  strategies: StrategyStatus[];
}

export interface RunnerHooks {
  onData(raw: RawOdds, meta: { latencyMs: number; strategy: Strategy }): void | Promise<void>;
  onHealth(ev: HealthEvent): void;
  liveDemand(bk: BookmakerId): LiveDemand;
  /** Dodatečná kontrola (např. konsenzus s ostatními sázkovkami); vrací chybu nebo null. */
  postValidate?(raw: RawOdds): string | null;
  settings(): Settings;
}

class ScopeLadder {
  private strategies: Strategy[];
  private st: StrategyStatus[];
  private active = 0;
  private state: AdapterState = 'OK';
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = true;
  private lastProbeAt = Date.now();
  private lastRepairAt = new Map<string, number>();
  private unsubscribe?: () => Promise<void>;
  private pushWatchdog?: NodeJS.Timeout;
  private status: Omit<ScopeStatus, 'scope' | 'state' | 'active' | 'activeLevel' | 'strategies' | 'push'> = {
    lastOkAt: null,
    lastDataAt: null,
    lastError: null,
    lastLatencyMs: null,
    events: 0,
    intervalMs: 0,
  };

  constructor(
    readonly bk: BookmakerId,
    readonly scope: FeedScope,
    strategies: Strategy[],
    private ctx: AdapterContext,
    private hooks: RunnerHooks,
  ) {
    // žebříček od nejlehčí; v LIVE s preferPush jdou websocket (push) strategie první
    const push = scope === 'live' && hooks.settings().modes.LIVE.preferPush;
    this.strategies = strategies
      .filter((s) => s.supports[scope])
      .sort((a, b) => (push ? Number(!a.subscribe) - Number(!b.subscribe) : 0) || a.level - b.level);
    this.st = this.strategies.map((s) => ({ name: s.name, level: s.level, status: 'UNTESTED', failures: 0 }));
  }

  get hasStrategies(): boolean {
    return this.strategies.length > 0;
  }

  start(): void {
    if (!this.hasStrategies) return;
    this.stopped = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.stopPush();
  }

  snapshot(): ScopeStatus {
    const s = this.strategies[this.active];
    return {
      scope: this.scope,
      state: this.state,
      active: s?.name ?? null,
      activeLevel: s?.level ?? null,
      push: !!this.unsubscribe,
      ...this.status,
      strategies: this.st.map((x) => ({ ...x })),
    };
  }

  private intervalMs(): number {
    const floor = this.strategies[this.active]?.minIntervalMs?.[this.scope] ?? 0;
    return Math.max(floor, this.modeIntervalMs());
  }

  private modeIntervalMs(): number {
    const cfg = this.hooks.settings().modes;
    const pick = (m: { pollMinMs: number; pollMaxMs: number }) => m.pollMinMs + Math.random() * Math.max(0, m.pollMaxMs - m.pollMinMs);
    if (this.scope === 'prematch') return pick(cfg.PREMATCH);
    const demand = this.hooks.liveDemand(this.bk);
    if (demand === 'LIVE') return pick(cfg.LIVE);
    if (demand === 'PAUSED') return pick(cfg.PAUSED);
    return Math.max(IDLE_LIVE_POLL_MS, cfg.PAUSED.pollMaxMs);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.runOnce(), ms);
  }

  private async runOnce(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      if (this.state === 'BLOCKED') {
        await this.retryBlocked();
      } else {
        await this.maybeProbe();
        const s = this.strategies[this.active];
        const wantPush =
          this.scope === 'live' && !!s.subscribe && this.hooks.settings().modes.LIVE.preferPush && this.hooks.liveDemand(this.bk) !== 'IDLE';
        if (wantPush) {
          if (!this.unsubscribe) await this.startPush(s);
        } else {
          if (this.unsubscribe) await this.stopPush();
          await this.pollOnce(s);
        }
      }
    } finally {
      this.running = false;
      const next = this.state === 'BLOCKED' ? BLOCKED_RETRY_MS : this.intervalMs();
      this.status.intervalMs = Math.round(next);
      this.schedule(next);
    }
  }

  private sports(): Sport[] {
    return [...SPORTS];
  }

  /** Stáhne data jednou strategií a zvaliduje je. Vyhazuje StrategyError. */
  private async fetchValid(s: Strategy): Promise<{ raw: RawOdds; ms: number }> {
    const t0 = performance.now();
    const raw = await s.fetch({ scope: this.scope, sports: this.sports() });
    const ms = performance.now() - t0;
    const modes = this.hooks.settings().modes;
    // live feed slouží LIVE i PAUSED – odmítnout jen data stará i pro PAUSED; přísnost na nohu řeší detektor
    const maxAge = this.scope === 'prematch' ? modes.PREMATCH.maxLegAgeMs : Math.max(modes.LIVE.maxLegAgeMs, modes.PAUSED.maxLegAgeMs);
    const v = validateRawOdds(raw, {
      minEvents: this.scope === 'prematch' ? 3 : 0,
      maxAgeMs: maxAge + ms,
    });
    if (!v.ok || !v.data) throw new StrategyError(`validation failed: ${v.errors.join('; ')}`, 'validation', { errors: v.errors, stats: v.stats });
    const post = this.hooks.postValidate?.(v.data);
    if (post) throw new StrategyError(`consensus check failed: ${post}`, 'validation', { reason: post });
    return { raw: v.data, ms };
  }

  private async pollOnce(s: Strategy): Promise<void> {
    try {
      const { raw, ms } = await this.fetchValid(s);
      await this.onSuccess(s, raw, ms);
    } catch (e) {
      await this.onFailure(s, e as Error);
    }
  }

  private async onSuccess(s: Strategy, raw: RawOdds, ms: number): Promise<void> {
    const i = this.strategies.indexOf(s);
    const st = this.st[i];
    st.failures = 0;
    st.status = 'OK';
    st.lastOkAt = Date.now();
    this.status.lastOkAt = Date.now();
    this.status.lastDataAt = raw.fetchedAt;
    this.status.lastLatencyMs = Math.round(ms);
    this.status.events = raw.events.length;
    // stav adaptéru: OK na primární strategii, DEGRADED na záložní
    this.setState(this.active === 0 ? 'OK' : 'DEGRADED', 'data ok');
    try {
      await this.hooks.onData(raw, { latencyMs: ms, strategy: s });
    } catch (e) {
      this.ctx.log.error('onData failed', { error: (e as Error).message });
    }
  }

  private async onFailure(s: Strategy, err: Error): Promise<void> {
    const i = this.strategies.indexOf(s);
    const st = this.st[i];
    st.failures++;
    st.lastError = err.message.slice(0, 300);
    this.status.lastError = st.lastError;
    this.ctx.log.warn(`${this.scope}/${s.name} failed (${st.failures}/${FAILURES_TO_DEGRADE})`, { error: err.message.slice(0, 200) });
    if (st.failures < FAILURES_TO_DEGRADE) return;

    // 1) diagnostika + uložení rozbité odpovědi
    const se = err instanceof StrategyError ? err : undefined;
    const details = { kind: se?.kind ?? 'other', ...(se?.details ?? {}) };
    const file = await this.ctx.fixtures.saveBroken({ strategy: s.name, error: err.message, details }).catch(() => null);
    this.hooks.onHealth({
      bookmaker: this.bk,
      scope: this.scope,
      event: 'diagnostic',
      strategy: s.name,
      level: s.level,
      state: this.state,
      reason: err.message.slice(0, 300),
      details: { ...details, sample: undefined, brokenFixture: file },
    });

    // 2) nejdřív zkusit opravit stávající strategii
    const lastRepair = this.lastRepairAt.get(s.name) ?? 0;
    if (s.repair && Date.now() - lastRepair > PROBE_INTERVAL_MS) {
      this.lastRepairAt.set(s.name, Date.now());
      try {
        if (await s.repair()) {
          const { raw, ms } = await this.fetchValid(s);
          this.ctx.log.info(`${this.scope}/${s.name} repaired`);
          await this.onSuccess(s, raw, ms);
          return;
        }
      } catch (e) {
        this.ctx.log.warn(`${this.scope}/${s.name} repair failed`, { error: (e as Error).message });
      }
    }

    // 3) teprve pak další úroveň
    st.status = 'DEGRADED';
    st.degradedAt = Date.now();
    await this.stopPush();
    const next = this.st.findIndex((x, j) => j > i && x.status !== 'DEGRADED');
    const prev = s.name;
    if (next >= 0) {
      this.active = next;
      this.lastProbeAt = Date.now();
      this.hooks.onHealth({
        bookmaker: this.bk,
        scope: this.scope,
        event: 'strategy_switch',
        strategy: this.strategies[next].name,
        level: this.strategies[next].level,
        state: 'DEGRADED',
        prevState: this.state,
        prevStrategy: prev,
        reason: `${FAILURES_TO_DEGRADE}× selhání: ${err.message.slice(0, 200)}`,
      });
      this.setState('DEGRADED', `switched from ${prev}`, true);
      this.schedule(0);
    } else {
      this.setState('BLOCKED', `všechny strategie selhaly (${err.message.slice(0, 200)})`);
    }
  }

  private setState(next: AdapterState, reason: string, silent = false): void {
    if (next === this.state) return;
    const prev = this.state;
    this.state = next;
    if (silent) return;
    const s = this.strategies[this.active];
    this.hooks.onHealth({
      bookmaker: this.bk,
      scope: this.scope,
      event: 'state_change',
      strategy: s?.name ?? '-',
      level: s?.level ?? -1,
      state: next,
      prevState: prev,
      reason,
    });
  }

  /** Každých 10 min zkus znovu levnější strategie. */
  private async maybeProbe(): Promise<void> {
    if (this.active === 0 || Date.now() - this.lastProbeAt < PROBE_INTERVAL_MS) return;
    this.lastProbeAt = Date.now();
    for (let j = 0; j < this.active; j++) {
      const s = this.strategies[j];
      try {
        const { raw, ms } = await this.fetchValid(s);
        const prev = this.strategies[this.active].name;
        await this.stopPush();
        this.active = j;
        this.st[j].status = 'OK';
        this.st[j].failures = 0;
        this.hooks.onHealth({
          bookmaker: this.bk,
          scope: this.scope,
          event: 'strategy_switch',
          strategy: s.name,
          level: s.level,
          state: j === 0 ? 'OK' : 'DEGRADED',
          prevState: this.state,
          prevStrategy: prev,
          reason: 'probe: levnější strategie opět funguje',
        });
        this.state = j === 0 ? 'OK' : 'DEGRADED';
        await this.onSuccess(s, raw, ms);
        return;
      } catch (e) {
        this.hooks.onHealth({
          bookmaker: this.bk,
          scope: this.scope,
          event: 'probe',
          strategy: s.name,
          level: s.level,
          state: this.state,
          reason: `probe failed: ${(e as Error).message.slice(0, 200)}`,
        });
      }
    }
  }

  /** BLOCKED: zkoušej postupně všechny strategie od nejlevnější. */
  private async retryBlocked(): Promise<void> {
    for (let j = 0; j < this.strategies.length; j++) {
      const s = this.strategies[j];
      try {
        const { raw, ms } = await this.fetchValid(s);
        this.active = j;
        this.st.forEach((x, k) => {
          if (k >= j) (x.status = k === j ? 'OK' : x.status), (x.failures = 0);
        });
        this.hooks.onHealth({
          bookmaker: this.bk,
          scope: this.scope,
          event: 'strategy_switch',
          strategy: s.name,
          level: s.level,
          state: j === 0 ? 'OK' : 'DEGRADED',
          prevState: 'BLOCKED',
          reason: 'obnoveno po zablokování',
        });
        this.state = j === 0 ? 'OK' : 'DEGRADED';
        await this.onSuccess(s, raw, ms);
        return;
      } catch (e) {
        this.st[j].lastError = (e as Error).message.slice(0, 300);
      }
    }
  }

  private async startPush(s: Strategy): Promise<void> {
    try {
      let last = Date.now();
      this.unsubscribe = await s.subscribe!(
        { scope: this.scope, sports: this.sports() },
        (raw) => {
          last = Date.now();
          const m = this.hooks.settings().modes;
          const v = validateRawOdds(raw, { minEvents: 0, maxAgeMs: Math.max(m.LIVE.maxLegAgeMs, m.PAUSED.maxLegAgeMs) });
          if (v.ok && v.data) void this.onSuccess(s, v.data, 0);
          else void this.onFailure(s, new StrategyError(`push validation: ${v.errors.join('; ')}`, 'validation'));
        },
        (err) => void this.onFailure(s, err),
      );
      clearInterval(this.pushWatchdog);
      this.pushWatchdog = setInterval(() => {
        if (Date.now() - last > PUSH_WATCHDOG_MS) {
          last = Date.now();
          void this.onFailure(s, new StrategyError('push feed silent', 'timeout'));
        }
      }, 5_000);
    } catch (e) {
      await this.onFailure(s, e as Error);
    }
  }

  private async stopPush(): Promise<void> {
    clearInterval(this.pushWatchdog);
    const u = this.unsubscribe;
    this.unsubscribe = undefined;
    await u?.().catch(() => {});
  }
}

export class AdapterRunner {
  private ladders: ScopeLadder[];

  constructor(
    readonly adapter: Adapter,
    private ctx: AdapterContext,
    hooks: RunnerHooks,
  ) {
    this.ladders = (['prematch', 'live'] as FeedScope[]).map((scope) => new ScopeLadder(adapter.bookmaker, scope, adapter.strategies, ctx, hooks));
  }

  get bookmaker(): BookmakerId {
    return this.adapter.bookmaker;
  }

  start(): void {
    for (const l of this.ladders) l.start();
  }

  async stop(): Promise<void> {
    for (const l of this.ladders) await l.stop();
    for (const s of this.adapter.strategies) await s.dispose?.().catch(() => {});
  }

  status(): { bookmaker: BookmakerId; state: AdapterState; scopes: ScopeStatus[] } {
    const scopes = this.ladders.filter((l) => l.hasStrategies).map((l) => l.snapshot());
    const order: AdapterState[] = ['OK', 'DEGRADED', 'BLOCKED'];
    const state = scopes.reduce<AdapterState>((w, s) => (order.indexOf(s.state) > order.indexOf(w) ? s.state : w), 'OK');
    return { bookmaker: this.bookmaker, state: scopes.length ? state : 'BLOCKED', scopes };
  }
}
