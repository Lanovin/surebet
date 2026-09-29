// SYNOT TIP strategie: L2 interní JSON/protobuf API webu (Node fetch), L5 totéž API přes fetch ve stránce.
import type { HealthResult, RawEvent, RawOdds, Sport } from '../../core/types.js';
import type { AdapterContext, FetchRequest, Strategy, StrategyLevel } from '../types.js';
import { StrategyError } from '../types.js';
import type { PbEventsResponse } from './proto.js';
import { decodeEventsResponse } from './proto.js';
import type { SynLiveDiscipline } from './parse.js';
import { ORIGIN, parseLive, parsePrematch, PREMATCH_GAME_IDS } from './parse.js';
import type { CallStats, Transport } from './api.js';
import { API, HTTP_HEADERS, LANGUAGE_ID, liveBody, mainBody, marketsBody, SESSION_API, SynotApi } from './api.js';

export interface SynotOptions {
  /**
   * Prematch: vedlejší trhy (totaly, handicapy, poločasy, třetiny, sety …) jen pro zápasy
   * začínající do N hodin. Hlavní trh (1X2 / vítěz) se stahuje pro všechny zápasy.
   * Celá nabídka bez omezení má ~7 MB (API nekomprimuje) – proto okno.
   */
  marketsHorizonHours?: number;
}
const DEFAULTS: Required<SynotOptions> = { marketsHorizonHours: 24 };

export class SynotCore {
  readonly o: Required<SynotOptions>;
  readonly api: SynotApi;
  constructor(
    private readonly ctx: AdapterContext,
    transport: Transport,
    opts: SynotOptions = {},
  ) {
    this.o = { ...DEFAULTS, ...opts };
    this.api = new SynotApi(transport);
  }

  private async events(body: (token: string) => unknown, stats: CallStats, timeoutMs: number): Promise<PbEventsResponse> {
    const r = await this.api.call<string>(`${API}/GetWebStandardEvents`, body, timeoutMs, stats);
    if (typeof r.ReturnValue !== 'string') throw new StrategyError('synot: GetWebStandardEvents without ReturnValue', 'structure');
    try {
      return decodeEventsResponse(r.ReturnValue);
    } catch (e) {
      throw new StrategyError(`synot: protobuf decode failed: ${(e as Error).message}`, 'structure', { sample: r.ReturnValue.slice(0, 200) });
    }
  }

  async fetch(strategy: string, req: FetchRequest): Promise<RawOdds> {
    const stats: CallStats = { requests: 0, bytes: 0 };
    const t0 = performance.now();
    let events: RawEvent[];
    if (req.scope === 'live') {
      const r = await this.api.call<SynLiveDiscipline[]>(`${API}/GetLIPEvtsDsk`, liveBody, 10_000, stats);
      if (!Array.isArray(r.ReturnValue)) throw new StrategyError('synot: live feed without ReturnValue', 'structure');
      events = parseLive({ Result: r.Result, ReturnValue: r.ReturnValue }, { now: Date.now(), sports: req.sports });
    } else {
      const now = Date.now();
      const to = now + this.o.marketsHorizonHours * 3600_000;
      const perSport = async (s: Sport) => {
        const main = await this.events((t) => mainBody(t, s), stats, 30_000);
        const extra = PREMATCH_GAME_IDS[s].length
          ? await this.events((t) => marketsBody(t, s, PREMATCH_GAME_IDS[s], now, to), stats, 45_000).catch((err: Error) => {
              // vedlejší trhy nejsou nutné – hlavní trh stačí, zbytek dorazí příště
              this.ctx.log.debug('markets request failed', { sport: s, err: err.message });
              return null;
            })
          : null;
        if ((main.UnpaginatedEventCount ?? 0) > 5000) this.ctx.log.warn('synot listing truncated', { sport: s, total: main.UnpaginatedEventCount });
        return extra ? [main, extra] : [main];
      };
      const responses = (await Promise.all(req.sports.map(perSport))).flat();
      events = parsePrematch(responses, { now, sports: req.sports });
      if (!events.length) throw new StrategyError('synot: no prematch events parsed', 'empty', { ...stats });
    }
    const fetchedAt = Math.min(Date.now(), stats.oldest ?? Date.now());
    this.ctx.log.debug('fetched', { strategy, scope: req.scope, ...stats, ms: Math.round(performance.now() - t0), events: events.length });
    return { bookmaker: 'synot', strategy, scope: req.scope, fetchedAt, events };
  }

  async health(): Promise<HealthResult> {
    const t0 = performance.now();
    try {
      const r = await this.api.call(
        `${SESSION_API}/getServerTime`,
        (t) => ({ LanguageID: LANGUAGE_ID, Token: t, WithTokenCheck: true, SID: '' }),
        10_000,
      );
      return { ok: r.Result === 1, latencyMs: Math.round(performance.now() - t0), httpStatus: 200 };
    } catch (e) {
      const err = e as StrategyError;
      return { ok: false, latencyMs: Math.round(performance.now() - t0), httpStatus: err.details?.status as number | undefined, message: err.message };
    }
  }
}

export function httpTransport(ctx: AdapterContext): Transport {
  return async (url, body, timeoutMs) => {
    const r = await ctx.http.text(url, {
      method: 'POST',
      body,
      headers: HTTP_HEADERS,
      timeoutMs,
      allowStatus: [400, 403, 404, 429, 500, 502, 503],
    });
    return { status: r.status, text: r.body };
  };
}

export class SynotApiStrategy implements Strategy {
  readonly name = 'ebet-api';
  readonly level: StrategyLevel = 2;
  readonly supports = { prematch: true, live: true };
  // live data se na serveru mění zhruba každou sekundu (TimeStamp), rychlejší polling nemá smysl
  readonly minIntervalMs = { live: 1_000 };
  private readonly core: SynotCore;
  constructor(ctx: AdapterContext, opts?: SynotOptions) {
    this.core = new SynotCore(ctx, httpTransport(ctx), opts);
  }
  fetch(req: FetchRequest): Promise<RawOdds> {
    return this.core.fetch(this.name, req);
  }
  healthCheck(): Promise<HealthResult> {
    return this.core.health();
  }
  async repair(): Promise<boolean> {
    this.core.api.resetToken();
    return true;
  }
}

/** Záloha: stejné API voláme fetch() ze stránky sport.synottip.cz (same-origin, cookies prohlížeče). */
export class SynotBrowserStrategy implements Strategy {
  readonly name = 'browser-fetch';
  readonly level: StrategyLevel = 5;
  readonly supports = { prematch: true, live: true };
  readonly minIntervalMs = { live: 1_000 };
  private readonly core: SynotCore;
  constructor(private readonly ctx: AdapterContext, opts?: SynotOptions) {
    this.core = new SynotCore(ctx, (url, body, timeoutMs) => this.transport(url, body, timeoutMs), { marketsHorizonHours: 12, ...opts });
  }

  private transport(url: string, body: string, timeoutMs: number): Promise<{ status: number; text: string }> {
    return this.ctx.browser.withPage('synot', async (page) => {
      if (!page.url().startsWith(ORIGIN)) await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      return page.evaluate(
        async ({ url, body, timeoutMs }) => {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), timeoutMs);
          try {
            const res = await fetch(url, {
              method: 'POST',
              body,
              headers: { 'content-type': 'application/json;charset=UTF-8', accept: 'application/json' },
              credentials: 'same-origin',
              signal: ctrl.signal,
            });
            return { status: res.status, text: await res.text() };
          } finally {
            clearTimeout(timer);
          }
        },
        { url, body, timeoutMs },
      );
    });
  }

  fetch(req: FetchRequest): Promise<RawOdds> {
    return this.core.fetch(this.name, req);
  }
  healthCheck(): Promise<HealthResult> {
    return this.core.health();
  }
  async repair(): Promise<boolean> {
    this.core.api.resetToken();
    await this.ctx.browser.closePage('synot');
    return true;
  }
  async dispose(): Promise<void> {
    await this.ctx.browser.closePage('synot');
  }
}
