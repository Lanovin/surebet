// Strategie kingsbet: Altenar widget API. L2 přímo přes HTTP, L5 stejné URL přes fetch v prohlížeči.
import type { FeedScope, HealthResult, RawEvent, RawOdds, Sport } from '../../core/types.js';
import type { AdapterContext, FetchRequest, Strategy, StrategyLevel } from '../types.js';
import { StrategyError } from '../types.js';
import {
  mergeMarkets,
  parseAltenarDetails,
  parseAltenarList,
  SPORT_IDS,
  type AltenarDetailsResponse,
  type AltenarListResponse,
} from './parse.js';

export const API = 'https://sb2frontend-altenar2.biahosted.com/api/';
/** Společné parametry všech volání (stejné jako posílá web). */
export const COMMON_QS =
  'culture=cs-CZ&timezoneOffset=-120&integration=kingsbet&deviceType=1&numFormat=en-GB&countryCode=CZ';
const ORIGIN = 'https://www.kingsbet.cz';

export const listUrl = (scope: FeedScope, sportId: number): string =>
  `${API}widget/${scope === 'live' ? 'GetLiveEvents' : 'GetEvents'}?${COMMON_QS}&eventCount=0&sportId=${sportId}`;
export const detailsUrl = (eventId: number): string =>
  `${API}widget/GetEventDetails?${COMMON_QS}&eventId=${eventId}&showNonBoosts=false`;
const HEALTH_URL = `${API}Widget/GetSportInfo?${COMMON_QS}`;

export interface AltenarOptions {
  /**
   * Prematch: kolik nejbližších událostí doplnit o detail (AH, BTTS, DNB, poločasy, třetiny, sety…).
   * Každá = 1 požadavek (~14 kB gzip). 0 = jen listing (4 požadavky).
   */
  detailLimit?: number;
  /** Detail jen pro události začínající do tolika hodin. */
  detailHorizonHours?: number;
}

/** Surové odpovědi jednoho fetch() – pro fixtures a testy. */
export interface AltenarRaw {
  lists: { sport: Sport; url: string; body: AltenarListResponse }[];
  details: { sport: Sport; url: string; body: AltenarDetailsResponse }[];
  requests: number;
  bytes: number;
}

type Getter = (urls: string[]) => Promise<{ url: string; status: number; body: string }[]>;

abstract class AltenarBase implements Strategy {
  abstract readonly name: string;
  abstract readonly level: StrategyLevel;
  readonly supports = { prematch: true, live: true };

  constructor(
    protected readonly ctx: AdapterContext,
    protected readonly opts: AltenarOptions = {},
  ) {}

  /** Stáhne dávku URL (paralelně, v rámci rate limitu transportu). */
  protected abstract download: Getter;

  async fetchRaw(req: FetchRequest): Promise<AltenarRaw> {
    const sports = req.sports.filter((s) => SPORT_IDS[s] !== undefined);
    const urls = sports.map((s) => listUrl(req.scope, SPORT_IDS[s]));
    const res = await this.download(urls);
    const raw: AltenarRaw = { lists: [], details: [], requests: res.length, bytes: 0 };
    res.forEach((r, i) => {
      raw.bytes += r.body.length;
      raw.lists.push({ sport: sports[i], url: r.url, body: this.parseJson<AltenarListResponse>(r, 'events') });
    });
    const limit = this.opts.detailLimit ?? 0;
    if (req.scope === 'prematch' && limit > 0) {
      const now = Date.now();
      const horizon = now + (this.opts.detailHorizonHours ?? 24) * 3600_000;
      const cand: { id: number; sport: Sport; start: number }[] = [];
      for (const l of raw.lists)
        for (const e of l.body.events) {
          const start = Date.parse(e.startDate);
          if (start > now && start < horizon && (e.et ?? 0) === 0) cand.push({ id: e.id, sport: l.sport, start });
        }
      cand.sort((a, b) => a.start - b.start);
      const pick = cand.slice(0, limit);
      const det = await this.download(pick.map((p) => detailsUrl(p.id)));
      det.forEach((r, i) => {
        raw.requests++;
        raw.bytes += r.body.length;
        if (r.status !== 200) return; // událost mezitím zmizela – detail je jen doplněk
        try {
          raw.details.push({ sport: pick[i].sport, url: r.url, body: JSON.parse(r.body) as AltenarDetailsResponse });
        } catch {
          /* nevalidní detail přeskočíme */
        }
      });
    }
    return raw;
  }

  async fetch(req: FetchRequest): Promise<RawOdds> {
    const t0 = Date.now();
    const raw = await this.fetchRaw(req);
    const fetchedAt = Date.now();
    const events = parseRaw(raw, req.scope, fetchedAt);
    this.ctx.log.debug('fetched', {
      strategy: this.name,
      scope: req.scope,
      events: events.length,
      requests: raw.requests,
      kb: Math.round(raw.bytes / 1024),
      ms: fetchedAt - t0,
    });
    return { bookmaker: 'kingsbet', strategy: this.name, scope: req.scope, fetchedAt, events };
  }

  async healthCheck(): Promise<HealthResult> {
    const t0 = performance.now();
    try {
      const [r] = await this.download([HEALTH_URL]);
      const ok = r.status === 200 && r.body.includes('"sports"');
      return { ok, latencyMs: Math.round(performance.now() - t0), httpStatus: r.status, message: ok ? undefined : r.body.slice(0, 200) };
    } catch (e) {
      return { ok: false, latencyMs: Math.round(performance.now() - t0), message: String((e as Error).message ?? e) };
    }
  }

  protected parseJson<T>(r: { url: string; status: number; body: string }, mustHave: string): T {
    if (r.status !== 200) {
      throw new StrategyError(`HTTP ${r.status} ${r.url}`, r.status === 403 || r.status === 429 ? 'blocked' : 'http', {
        status: r.status,
        sample: r.body.slice(0, 500),
      });
    }
    let j: unknown;
    try {
      j = JSON.parse(r.body);
    } catch {
      throw new StrategyError(`invalid JSON from ${r.url}`, 'structure', { sample: r.body.slice(0, 500) });
    }
    if (!j || typeof j !== 'object' || !Array.isArray((j as Record<string, unknown>)[mustHave])) {
      throw new StrategyError(`unexpected structure from ${r.url}`, 'structure', { sample: r.body.slice(0, 500) });
    }
    return j as T;
  }
}

/** Převod surových odpovědí na události (čistá funkce – sdílí ji test i obě strategie). */
export function parseRaw(raw: AltenarRaw, scope: FeedScope, now: number): RawEvent[] {
  const byId = new Map<string, RawEvent>();
  for (const l of raw.lists)
    for (const ev of parseAltenarList(l.body, { live: scope === 'live', now })) {
      if (scope === 'prematch' && ev.startTime <= now) continue; // už začalo – kurzy by byly neaktuální
      byId.set(ev.sourceId, ev);
    }
  for (const d of raw.details) {
    const ev = byId.get(String(d.body.id));
    if (ev) ev.markets = mergeMarkets(ev.markets, parseAltenarDetails(d.body, d.sport));
  }
  return [...byId.values()];
}

/** Level 2: přímé volání veřejného JSON API (CORS *, bez cookies, bez tokenu). */
export class AltenarHttpStrategy extends AltenarBase {
  readonly name = 'altenar-api';
  readonly minIntervalMs = { live: 2_500 }; // Cloudflare cachuje odpovědi 3 s
  readonly level = 2 as const;

  protected download: Getter = (urls) =>
    Promise.all(
      urls.map(async (url) => {
        const r = await this.ctx.http.text(url, {
          headers: { origin: ORIGIN, referer: `${ORIGIN}/` },
          allowStatus: [400, 404],
          timeoutMs: 15_000,
        });
        return { url, status: r.status, body: r.body };
      }),
    );
}

/**
 * Level 5: stejné API voláno přes fetch() uvnitř Chromia (TLS otisk prohlížeče) –
 * záloha pro případ, že by API začalo blokovat node klienta. Stránka stojí na malém
 * dokumentu kingsbet.cz (robots.txt), SPA se nenačítá.
 */
export class AltenarBrowserStrategy extends AltenarBase {
  readonly name = 'altenar-browser';
  readonly minIntervalMs = { live: 2_500 }; // Cloudflare cachuje odpovědi 3 s
  readonly level = 5 as const;

  protected download: Getter = (urls) =>
    this.ctx.browser.withPage(this.ctx.bookmaker, async (page) => {
      if (!page.url().startsWith(ORIGIN)) await page.goto(`${ORIGIN}/robots.txt`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      const out: { url: string; status: number; body: string }[] = [];
      for (let i = 0; i < urls.length; i += 4) {
        // credentials: 'omit' – API vrací Access-Control-Allow-Origin: *, s cookies by CORS selhal
        const part = await page.evaluate(
          async (list) =>
            Promise.all(
              list.map(async (url) => {
                const r = await fetch(url, { credentials: 'omit' });
                return { url, status: r.status, body: await r.text() };
              }),
            ),
          urls.slice(i, i + 4),
        );
        out.push(...part);
      }
      return out;
    });

  async dispose(): Promise<void> {
    await this.ctx.browser.closePage(this.ctx.bookmaker);
  }
}
