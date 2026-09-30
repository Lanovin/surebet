// Strategie pro sázkovky na platformě Altenar (Kingsbet, MerkurXtip): L2 přímé volání veřejného
// widget API (CORS *, bez cookies a tokenu), L5 stejné URL přes fetch() uvnitř Chromia (TLS otisk
// prohlížeče) – záloha, kdyby API začalo blokovat node klienta. Parsování sdílí ./altenar.ts.
import type { FeedScope, HealthResult, RawEvent, RawOdds, Sport } from '../../core/types.js';
import type { AdapterContext, FetchRequest, Strategy, StrategyLevel } from '../types.js';
import { StrategyError } from '../types.js';
import {
  ALTENAR_API,
  ALTENAR_SPORT_IDS,
  mergeAltenarDetails,
  parseAltenarList,
  type AltDetailResponse,
  type AltenarSite,
  type AltListResponse,
} from './altenar.js';

export interface AltenarOptions {
  /**
   * Prematch: kolik nejbližších zápasů doplnit detailem (AH, BTTS, DNB, poločasy, třetiny, čtvrtiny,
   * sety, další linie). Každý = 1 požadavek (~15 kB gzip). 0 = jen listing (4 požadavky).
   */
  detailLimit: number;
  /** Detail jen pro zápasy začínající do tolika hodin. */
  detailHorizonHours: number;
}

export const ALTENAR_DEFAULTS: AltenarOptions = { detailLimit: 50, detailHorizonHours: 24 };

/** Společné parametry všech volání (stejné jako posílá web). */
export const altenarQuery = (integration: string): string =>
  `culture=cs-CZ&timezoneOffset=-120&integration=${integration}&deviceType=1&numFormat=en-GB&countryCode=CZ`;

export const altenarUrls = (integration: string) => {
  const q = altenarQuery(integration);
  return {
    /** prematch sportu: všechny zápasy (ne outrighty) s hlavními trhy („headers“) */
    events: (sport: Sport) => `${ALTENAR_API}GetEvents?${q}&eventCount=0&sportId=${ALTENAR_SPORT_IDS[sport]}`,
    /** live sportu: hlavní trhy + stav (ls, score, timer) */
    live: (sport: Sport) => `${ALTENAR_API}GetLiveEvents?${q}&eventCount=0&sportId=${ALTENAR_SPORT_IDS[sport]}`,
    /** detail zápasu: všechny trhy a linie */
    detail: (eventId: number | string) => `${ALTENAR_API}GetEventDetails?${q}&eventId=${eventId}&showNonBoosts=false`,
    health: `${ALTENAR_API}GetSportInfo?${q}`,
  };
};

/** Transport: Node fetch nebo fetch uvnitř stránky. `ageMs` = stáří odpovědi v CDN cache (hlavička Age). */
export type AltenarTransport = (url: string, timeoutMs: number) => Promise<{ status: number; body: string; ageMs: number }>;

/** Surové odpovědi jednoho fetch() – pro fixtures a testy. */
export interface AltenarRaw {
  lists: { sport: Sport; url: string; body: AltListResponse }[];
  details: { sport: Sport; url: string; body: AltDetailResponse }[];
  requests: number;
  bytes: number;
  /** nejstarší okamžik vzniku dat (čas požadavku − Age) přes všechny odpovědi */
  oldest?: number;
}

/** Převod surových odpovědí na události (čistá funkce – sdílí ji test i obě strategie). */
export function parseAltenarRaw(raw: AltenarRaw, site: AltenarSite, scope: FeedScope, now: number): RawEvent[] {
  const byId = new Map<string, RawEvent>();
  for (const l of raw.lists)
    for (const ev of parseAltenarList(l.body, site, { scope, now, sports: [l.sport] })) if (!byId.has(ev.sourceId)) byId.set(ev.sourceId, ev);
  const details = new Map(raw.details.map((d) => [String(d.body.id), d.body]));
  return mergeAltenarDetails([...byId.values()], details, site);
}

export class AltenarCore {
  readonly urls: ReturnType<typeof altenarUrls>;

  constructor(
    private readonly ctx: AdapterContext,
    readonly site: AltenarSite,
    private readonly transport: AltenarTransport,
    readonly opts: AltenarOptions = ALTENAR_DEFAULTS,
  ) {
    this.urls = altenarUrls(site.integration);
  }

  private async get<T>(url: string, timeoutMs: number, raw: AltenarRaw, mustHave?: string): Promise<T> {
    const started = Date.now();
    const r = await this.transport(url, timeoutMs);
    raw.requests++;
    raw.bytes += r.body.length;
    const born = started - r.ageMs;
    if (raw.oldest === undefined || born < raw.oldest) raw.oldest = born;
    if (r.status !== 200) {
      throw new StrategyError(`${this.site.bookmaker} API HTTP ${r.status} ${url}`, r.status === 403 || r.status === 429 ? 'blocked' : 'http', {
        status: r.status,
        sample: r.body.slice(0, 500),
      });
    }
    let j: unknown;
    try {
      j = JSON.parse(r.body);
    } catch {
      const blocked = /cloudflare|captcha|access denied/i.test(r.body);
      throw new StrategyError(`${this.site.bookmaker}: invalid JSON from ${url}`, blocked ? 'blocked' : 'structure', { sample: r.body.slice(0, 500) });
    }
    if (!j || typeof j !== 'object' || (mustHave && !Array.isArray((j as Record<string, unknown>)[mustHave]))) {
      throw new StrategyError(`${this.site.bookmaker}: unexpected structure from ${url}`, 'structure', { sample: r.body.slice(0, 500) });
    }
    return j as T;
  }

  async fetchRaw(req: FetchRequest): Promise<AltenarRaw> {
    const sports = req.sports.filter((s) => ALTENAR_SPORT_IDS[s] !== undefined);
    const raw: AltenarRaw = { lists: [], details: [], requests: 0, bytes: 0 };
    const listUrl = req.scope === 'live' ? this.urls.live : this.urls.events;
    // 4 malé požadavky paralelně (CDN je cachuje 3 s)
    const bodies = await Promise.all(sports.map((s) => this.get<AltListResponse>(listUrl(s), req.scope === 'live' ? 10_000 : 30_000, raw, 'events')));
    bodies.forEach((body, i) => raw.lists.push({ sport: sports[i], url: listUrl(sports[i]), body }));
    if (req.scope === 'prematch' && this.opts.detailLimit > 0) {
      const now = Date.now();
      const horizon = now + this.opts.detailHorizonHours * 3600_000;
      const pick = raw.lists
        .flatMap((l) => parseAltenarList(l.body, this.site, { scope: 'prematch', now, sports: [l.sport] }).map((e) => ({ e, sport: l.sport })))
        .filter(({ e }) => e.startTime <= horizon)
        .sort((a, b) => a.e.startTime - b.e.startTime)
        .slice(0, this.opts.detailLimit);
      const det = await Promise.allSettled(pick.map(({ e }) => this.get<AltDetailResponse>(this.urls.detail(e.sourceId), 10_000, raw, 'markets')));
      det.forEach((r, i) => {
        // detail je jen doplněk – událost mezitím mohla zmizet (404) nebo odpověď selhat
        if (r.status === 'fulfilled') raw.details.push({ sport: pick[i].sport, url: this.urls.detail(pick[i].e.sourceId), body: r.value });
        else this.ctx.log.debug('detail failed', { id: pick[i].e.sourceId, error: (r.reason as Error)?.message });
      });
    }
    return raw;
  }

  async fetch(strategy: string, req: FetchRequest): Promise<RawOdds> {
    const t0 = Date.now();
    const raw = await this.fetchRaw(req);
    const now = Date.now();
    const events = parseAltenarRaw(raw, this.site, req.scope, now);
    if (req.scope === 'prematch' && !events.length) throw new StrategyError(`${this.site.bookmaker}: no prematch events parsed`, 'empty', { requests: raw.requests });
    const fetchedAt = Math.min(now, raw.oldest ?? now);
    this.ctx.log.debug('fetched', { strategy, scope: req.scope, events: events.length, requests: raw.requests, kb: Math.round(raw.bytes / 1024), ms: now - t0, ageMs: now - fetchedAt });
    return { bookmaker: this.site.bookmaker, strategy, scope: req.scope, fetchedAt, events };
  }

  async health(): Promise<HealthResult> {
    const t0 = performance.now();
    try {
      const r = await this.transport(this.urls.health, 10_000);
      const ok = r.status === 200 && r.body.includes('"sports"');
      return { ok, latencyMs: Math.round(performance.now() - t0), httpStatus: r.status, message: ok ? undefined : r.body.slice(0, 200) };
    } catch (e) {
      return { ok: false, latencyMs: Math.round(performance.now() - t0), message: String((e as Error).message ?? e) };
    }
  }
}

function ageMs(header: string | null | undefined): number {
  const a = Number(header ?? 0);
  return Number.isFinite(a) && a > 0 ? a * 1000 : 0;
}

/** Level 2: přímé volání veřejného JSON API. */
export class AltenarHttpStrategy implements Strategy {
  readonly name = 'altenar-api';
  readonly level: StrategyLevel = 2;
  readonly supports = { prematch: true, live: true };
  /**
   * CDN drží odpověď 3 s (fetchedAt = čas požadavku − Age, takže data mají reálně 0–3 s). Nový objekt
   * vznikne až po vypršení, polling po 1 s ho jen dřív zachytí – stáří nohy tak zůstane pod ~4 s
   * (LIVE limit 5 s); při 2,5 s by běžně přesáhlo 5 s a arby by končily jako stale.
   */
  readonly minIntervalMs = { live: 1_000 };
  readonly core: AltenarCore;

  constructor(ctx: AdapterContext, site: AltenarSite, opts?: AltenarOptions) {
    const headers = { origin: site.origin, referer: `${site.origin}/` };
    this.core = new AltenarCore(
      ctx,
      site,
      async (url, timeoutMs) => {
        const r = await ctx.http.text(url, { headers, timeoutMs, allowStatus: [400, 403, 404, 429, 500, 502, 503] });
        return { status: r.status, body: r.body, ageMs: ageMs(r.headers.get('age')) };
      },
      opts,
    );
  }

  fetch(req: FetchRequest): Promise<RawOdds> {
    return this.core.fetch(this.name, req);
  }

  healthCheck(): Promise<HealthResult> {
    return this.core.health();
  }
}

/**
 * Level 5: stejné API přes fetch() uvnitř Chromia. Stránka stojí na malém dokumentu webu
 * (robots.txt), SPA se nenačítá. credentials: 'omit' – API vrací Access-Control-Allow-Origin: *,
 * s cookies by CORS selhal (proto ne ctx.browser.fetchInPage).
 */
export class AltenarBrowserStrategy implements Strategy {
  readonly level: StrategyLevel = 5;
  readonly supports = { prematch: true, live: true };
  readonly minIntervalMs = { live: 1_500 }; // fetch přes prohlížeč je pomalejší a dražší
  readonly core: AltenarCore;

  constructor(
    private readonly ctx: AdapterContext,
    site: AltenarSite,
    readonly name: string,
    opts: AltenarOptions = { ...ALTENAR_DEFAULTS, detailLimit: 10 },
  ) {
    this.core = new AltenarCore(ctx, site, (url, timeoutMs) => this.transport(site, url, timeoutMs), opts);
  }

  private transport(site: AltenarSite, url: string, timeoutMs: number): Promise<{ status: number; body: string; ageMs: number }> {
    return this.ctx.browser.withPage(this.ctx.bookmaker, async (page) => {
      if (!page.url().startsWith(site.origin)) await page.goto(`${site.origin}/robots.txt`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      const r = await page.evaluate(
        async ({ url, timeoutMs }) => {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), timeoutMs);
          try {
            const res = await fetch(url, { credentials: 'omit', signal: ctrl.signal });
            return { status: res.status, body: await res.text(), age: res.headers.get('age') };
          } finally {
            clearTimeout(timer);
          }
        },
        { url, timeoutMs },
      );
      return { status: r.status, body: r.body, ageMs: ageMs(r.age) };
    });
  }

  fetch(req: FetchRequest): Promise<RawOdds> {
    return this.core.fetch(this.name, req);
  }

  healthCheck(): Promise<HealthResult> {
    return this.core.health();
  }

  async dispose(): Promise<void> {
    await this.ctx.browser.closePage(this.ctx.bookmaker);
  }
}
