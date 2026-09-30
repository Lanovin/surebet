// SYNOT TIP strategie: L2 interní JSON/protobuf API webu (Node fetch), L5 totéž API přes fetch ve stránce.
import type { HealthResult, RawEvent, RawOdds, Sport } from '../../core/types.js';
import type { AdapterContext, FetchRequest, Strategy, StrategyLevel } from '../types.js';
import { StrategyError } from '../types.js';
import type { PbEventsResponse } from './proto.js';
import { decodeEventsResponse } from './proto.js';
import type { SynLiveDiscipline } from './parse.js';
import { NICHE_SPORTS, ORIGIN, parseLive, parsePrematch, prematchGameIds, SPORT_IDS } from './parse.js';
import type { CallStats, Transport } from './api.js';
import { API, HTTP_HEADERS, LANGUAGE_ID, LIVE_URL, liveBody, liveHeaders, mainBody, marketsBody, PAGE_SIZE, SESSION_API, SnapshotClock, SynotApi } from './api.js';

/** Pojistka stránkování výpisu (5000 řádků na stránku; dnes ~2000 řádků všech sportů). */
const MAX_PAGES = 4;

export interface SynotOptions {
  /**
   * Prematch: vedlejší trhy (totaly, handicapy, poločasy, třetiny, sety …) jen pro zápasy
   * začínající do N hodin. Hlavní trh (1X2 / vítěz) se stahuje pro všechny zápasy.
   * Celá nabídka bez omezení má ~7 MB (API nekomprimuje) – proto okno.
   */
  marketsHorizonHours?: number;
  /** Totéž pro sporty bez namapovaného hlavního trhu ve výpisu (americký fotbal, MMA, box – `NICHE_SPORTS`). */
  nicheHorizonHours?: number;
}
const DEFAULTS: Required<SynotOptions> = { marketsHorizonHours: 24, nicheHorizonHours: 168 };

export class SynotCore {
  readonly o: Required<SynotOptions>;
  readonly api: SynotApi;
  /** Odhad stáří live snapshotu z jeho TimeStamp (server ho cachuje ~1 s). */
  private readonly liveClock = new SnapshotClock();
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

  /** Výpis po stránkách (Top/Skip), dokud `UnpaginatedEventCount` říká, že něco chybí. */
  private async listing(body: (token: string, skip: number) => unknown, stats: CallStats, timeoutMs: number, sport: Sport | null): Promise<PbEventsResponse[]> {
    const out: PbEventsResponse[] = [];
    for (let skip = 0; ; ) {
      const r = await this.events((t) => body(t, skip), stats, timeoutMs);
      out.push(r);
      skip += PAGE_SIZE;
      if ((r.UnpaginatedEventCount ?? 0) <= skip) break;
      if (out.length >= MAX_PAGES) {
        this.ctx.log.warn('synot listing truncated', { sport: sport ?? 'all', total: r.UnpaginatedEventCount, pages: out.length });
        break;
      }
    }
    return out;
  }

  async fetch(strategy: string, req: FetchRequest): Promise<RawOdds> {
    const stats: CallStats = { requests: 0, bytes: 0 };
    const t0 = performance.now();
    let events: RawEvent[];
    let fetchedAt: number;
    if (req.scope === 'live') {
      const r = await this.api.call<SynLiveDiscipline[]>(LIVE_URL, liveBody, 10_000, stats, liveHeaders);
      if (!Array.isArray(r.ReturnValue)) throw new StrategyError('synot: live feed without ReturnValue', 'structure');
      const t1 = stats.lastEnd ?? Date.now();
      fetchedAt = this.liveClock.generatedAt(r.TimeStamp, stats.lastStart ?? t1, t1);
      events = parseLive({ Result: r.Result, ReturnValue: r.ReturnValue }, { now: Date.now(), sports: req.sports });
    } else {
      const now = Date.now();
      const sports = req.sports.filter((s) => SPORT_IDS[s] !== undefined);
      if (!sports.length) throw new StrategyError('synot: no supported sport requested', 'empty');
      const niche = sports.filter((s) => NICHE_SPORTS.includes(s));
      const common = sports.filter((s) => !NICHE_SPORTS.includes(s));
      // Víc sportů → jeden výpis pro všechny sporty (CategoryID null; seznam kategorií API nebere) + jeden požadavek
      // na vedlejší trhy se sjednocenými GameIds: 2 požadavky za cyklus místo 2 na sport. Navíc přijdou virtuální
      // kategorie a nepodporované sporty (~15 % dat). Niche sporty (hlavní trh výpisu se nemapuje) mají jen
      // požadavek na trhy s delším oknem a vlastní kategorií (ID typů trhů se mezi sporty překrývají).
      const one = sports.length === 1 ? sports[0] : undefined; // jediný sport → kategorie přímo (menší odpověď)
      const listingSport: Sport | null = one ?? null;
      const markets = async (sport: Sport | null, gameIds: number[], hours: number) =>
        gameIds.length
          ? await this.listing((t, skip) => marketsBody(t, sport, gameIds, now, now + hours * 3600_000, skip), stats, 45_000, sport).catch((err: Error) => {
              // vedlejší trhy nejsou nutné – hlavní trh stačí, zbytek dorazí příště
              this.ctx.log.debug('markets request failed', { sport: sport ?? 'all', err: err.message });
              return [];
            })
          : [];
      const parts = await Promise.all([
        this.listing((t, skip) => mainBody(t, listingSport, skip), stats, 30_000, listingSport),
        markets(common.length === 1 ? common[0] : null, prematchGameIds(common), this.o.marketsHorizonHours),
        ...niche.map((s) => markets(s, prematchGameIds([s]), this.o.nicheHorizonHours)),
      ]);
      const responses = parts.flat();
      events = parsePrematch(responses, { now, sports: req.sports });
      if (!events.length) throw new StrategyError('synot: no prematch events parsed', 'empty', { ...stats });
      fetchedAt = Math.min(Date.now(), stats.oldest ?? Date.now());
    }
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
  return async (url, body, timeoutMs, headers) => {
    const r = await ctx.http.text(url, {
      method: 'POST',
      body,
      headers: headers ? { ...HTTP_HEADERS, ...headers } : HTTP_HEADERS,
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
  // live snapshot server přegenerovává každých ~1,03 s (TimeStamp), rychlejší polling nemá smysl
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
    this.core = new SynotCore(ctx, (url, body, timeoutMs, headers) => this.transport(url, body, timeoutMs, headers), {
      marketsHorizonHours: 12,
      ...opts,
    });
  }

  private transport(url: string, body: string, timeoutMs: number, headers?: Record<string, string>): Promise<{ status: number; text: string }> {
    return this.ctx.browser.withPage('synot', async (page) => {
      if (!page.url().startsWith(ORIGIN)) await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      return page.evaluate(
        async ({ url, body, timeoutMs, headers }) => {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), timeoutMs);
          try {
            const res = await fetch(url, {
              method: 'POST',
              body,
              headers: { 'content-type': 'application/json;charset=UTF-8', accept: 'application/json', ...headers },
              credentials: 'same-origin',
              signal: ctrl.signal,
            });
            return { status: res.status, text: await res.text() };
          } finally {
            clearTimeout(timer);
          }
        },
        { url, body, timeoutMs, headers: headers ?? {} },
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
