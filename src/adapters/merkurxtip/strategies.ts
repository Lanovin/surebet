// MerkurXtip strategie: L2 Altenar widget API (Node fetch), L5 totéž API přes fetch v prohlížeči.
import type { HealthResult, RawEvent, RawOdds } from '../../core/types.js';
import type { AdapterContext, FetchRequest, Strategy, StrategyLevel } from '../types.js';
import { StrategyError } from '../types.js';
import type { AltDetailResponse, AltListResponse } from './parse.js';
import { mergeDetails, parseList, SITE } from './parse.js';
import type { CallStats, Transport } from './api.js';
import { detailUrl, eventsUrl, getJson, HEALTH_URL, HTTP_HEADERS, liveUrl, ORIGIN } from './api.js';

export interface MerkurOptions {
  /** Prematch: kolik nejbližších zápasů doplnit detailem (1 požadavek / zápas, ~15 kB gzip). */
  detailMax?: number;
  /** Prematch: detail jen pro zápasy začínající do N hodin. */
  detailHorizonHours?: number;
}
const DEFAULTS: Required<MerkurOptions> = { detailMax: 30, detailHorizonHours: 12 };

export class MerkurCore {
  readonly o: Required<MerkurOptions>;
  constructor(
    private readonly ctx: AdapterContext,
    private readonly transport: Transport,
    opts: MerkurOptions = {},
  ) {
    this.o = { ...DEFAULTS, ...opts };
  }

  async fetch(strategy: string, req: FetchRequest): Promise<RawOdds> {
    const stats: CallStats = { requests: 0, bytes: 0 };
    const t = this.transport;
    const t0 = performance.now();
    let events: RawEvent[];
    if (req.scope === 'live') {
      // 4 malé požadavky paralelně (CDN je cachuje 3 s – Age hlavička → fetchedAt)
      const lists = await Promise.all(req.sports.map((s) => getJson<AltListResponse>(t, liveUrl(s), 10_000, stats)));
      const now = Date.now();
      events = lists.flatMap((r) => parseList(r, { scope: 'live', now, sports: req.sports }));
    } else {
      const lists = await Promise.all(req.sports.map((s) => getJson<AltListResponse>(t, eventsUrl(s), 30_000, stats)));
      const now = Date.now();
      events = lists.flatMap((r) => parseList(r, { scope: 'prematch', now, sports: req.sports }));
      if (this.o.detailMax > 0) {
        const horizon = now + this.o.detailHorizonHours * 3600_000;
        const pick = events
          .filter((e) => e.startTime > now && e.startTime <= horizon)
          .sort((a, b) => a.startTime - b.startTime)
          .slice(0, this.o.detailMax);
        const details = new Map<string, AltDetailResponse>();
        for (const e of pick) {
          try {
            details.set(e.sourceId, await getJson<AltDetailResponse>(t, detailUrl(e.sourceId), 10_000, stats));
          } catch (err) {
            this.ctx.log.debug('detail failed', { id: e.sourceId, err: (err as Error).message });
          }
        }
        events = mergeDetails(events, details);
      }
      if (!events.length) throw new StrategyError('merkurxtip: no prematch events parsed', 'empty', { ...stats });
    }
    const fetchedAt = Math.min(Date.now(), stats.oldest ?? Date.now());
    this.ctx.log.debug('fetched', { strategy, scope: req.scope, ...stats, ms: Math.round(performance.now() - t0), events: events.length });
    return { bookmaker: 'merkurxtip', strategy, scope: req.scope, fetchedAt, events };
  }

  async health(): Promise<HealthResult> {
    const t0 = performance.now();
    try {
      const r = await this.transport(HEALTH_URL, 10_000);
      return { ok: r.status === 200, latencyMs: Math.round(performance.now() - t0), httpStatus: r.status };
    } catch (e) {
      const err = e as StrategyError;
      return { ok: false, latencyMs: Math.round(performance.now() - t0), httpStatus: err.details?.status as number | undefined, message: err.message };
    }
  }
}

export function httpTransport(ctx: AdapterContext): Transport {
  return async (url, timeoutMs) => {
    const r = await ctx.http.text(url, { headers: HTTP_HEADERS, timeoutMs, allowStatus: [400, 403, 404, 429, 500, 502, 503] });
    let body: unknown;
    try {
      body = r.body ? JSON.parse(r.body) : null;
    } catch {
      throw new StrategyError('merkurxtip: non-JSON response', /cloudflare|captcha|access denied/i.test(r.body) ? 'blocked' : 'structure', {
        status: r.status,
        sample: r.body.slice(0, 300),
      });
    }
    const age = Number(r.headers.get('age') ?? 0);
    return { status: r.status, body, bytes: r.body.length, ageMs: Number.isFinite(age) ? age * 1000 : 0 };
  };
}

export class MerkurApiStrategy implements Strategy {
  readonly name = 'altenar-api';
  readonly minIntervalMs = { live: 2_500 }; // CDN cachuje odpovědi 3 s
  readonly level: StrategyLevel = 2;
  readonly supports = { prematch: true, live: true };
  private readonly core: MerkurCore;
  constructor(ctx: AdapterContext, opts?: MerkurOptions) {
    this.core = new MerkurCore(ctx, httpTransport(ctx), opts);
  }
  fetch(req: FetchRequest): Promise<RawOdds> {
    return this.core.fetch(this.name, req);
  }
  healthCheck(): Promise<HealthResult> {
    return this.core.health();
  }
}

/**
 * Záloha: stejné API voláme fetch() ze stránky www.merkurxtip.cz (TLS/cookies prohlížeče).
 * Pozn.: ctx.browser.fetchInPage posílá credentials:'include', což API s
 * "Access-Control-Allow-Origin: *" odmítne (CORS) → fetch bez credentials přes withPage.
 */
export class MerkurBrowserStrategy implements Strategy {
  readonly name = 'browser-fetch';
  readonly minIntervalMs = { live: 2_500 };
  readonly level: StrategyLevel = 5;
  readonly supports = { prematch: true, live: true };
  private readonly core: MerkurCore;
  constructor(private readonly ctx: AdapterContext, opts?: MerkurOptions) {
    this.core = new MerkurCore(ctx, (url, timeoutMs) => this.transport(url, timeoutMs), { detailMax: 10, ...opts });
  }

  private async transport(url: string, timeoutMs: number): Promise<{ status: number; body: unknown; bytes: number; ageMs?: number }> {
    const r = await this.ctx.browser.withPage('merkurxtip', async (page) => {
      if (!page.url().startsWith(ORIGIN)) await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      return page.evaluate(
        async ({ url, timeoutMs }) => {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), timeoutMs);
          try {
            const res = await fetch(url, { credentials: 'omit', signal: ctrl.signal });
            return { status: res.status, text: await res.text(), age: Number(res.headers.get('age') ?? 0) };
          } finally {
            clearTimeout(timer);
          }
        },
        { url, timeoutMs },
      );
    });
    let body: unknown;
    try {
      body = r.text ? JSON.parse(r.text) : null;
    } catch {
      throw new StrategyError('merkurxtip (browser): non-JSON response', 'structure', { status: r.status, sample: r.text.slice(0, 300) });
    }
    return { status: r.status, body, bytes: r.text.length, ageMs: (Number.isFinite(r.age) ? r.age : 0) * 1000 };
  }

  fetch(req: FetchRequest): Promise<RawOdds> {
    return this.core.fetch(this.name, req);
  }
  healthCheck(): Promise<HealthResult> {
    return this.core.health();
  }
  async dispose(): Promise<void> {
    await this.ctx.browser.closePage('merkurxtip');
  }
}
