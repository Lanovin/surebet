// Fortuna – strategie nad veřejným offer API (api.ifortuna.cz). Level 2 = plain HTTP,
// level 5 = stejné endpointy přes fetch() uvnitř stránky www.ifortuna.cz (fallback, kdyby API
// začalo blokovat ne-prohlížečové klienty). Parsování sdílí parse.ts.
import type { FeedScope, HealthResult, RawOdds, Sport } from '../../core/types.js';
import type { AdapterContext, FetchRequest, Strategy, StrategyLevel } from '../types.js';
import { StrategyError } from '../types.js';
import {
  API,
  OVERVIEW_TYPES,
  SITE,
  SPORTS_MAP,
  buildEvents,
  isMappedMarketType,
  mergeMini,
  selectFixtures,
  sportOfFixture,
  type FortunaBundle,
  type FtnMarket,
  type FtnMarketsByFixture,
  type FtnMatchesPage,
  type FtnMiniScoreboard,
} from './parse.js';

export const STRUCTURE = `${API}/offer/structure/api/v1_0`;
export const MARKETS = `${API}/offer/markets/api/v1_0`;
export const STATS = `${API}/offer/stats-v2/api/v2_0`;

/** Přenos: plain HTTP nebo fetch v prohlížeči. */
export interface Transport {
  readonly kind: 'http' | 'browser';
  get<T>(url: string, signal?: AbortSignal): Promise<T>;
}

export class HttpTransport implements Transport {
  readonly kind = 'http';
  constructor(private ctx: AdapterContext) {}
  async get<T>(url: string, signal?: AbortSignal): Promise<T> {
    const r = await this.ctx.http.json<T>(url, { headers: { origin: SITE, referer: `${SITE}/` }, signal, timeoutMs: 20_000 });
    return r.body;
  }
}

export class BrowserTransport implements Transport {
  readonly kind = 'browser';
  constructor(private ctx: AdapterContext) {}
  private async ensurePage(): Promise<void> {
    await this.ctx.browser.withPage('fortuna', async (page) => {
      if (!page.url().startsWith(SITE)) await page.goto(`${SITE}/`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    });
  }
  async get<T>(url: string): Promise<T> {
    await this.ensurePage();
    const r = await this.ctx.browser.fetchInPage('fortuna', url, { headers: { accept: 'application/json' } });
    if (r.status !== 200) {
      throw new StrategyError(`HTTP ${r.status} ${url}`, r.status === 403 || r.status === 429 ? 'blocked' : 'http', {
        status: r.status,
        sample: r.body.slice(0, 500),
      });
    }
    try {
      return JSON.parse(r.body) as T;
    } catch {
      throw new StrategyError(`invalid JSON from ${url}`, 'structure', { sample: r.body.slice(0, 500) });
    }
  }
}

const ids = (name: string, list: string[]) => list.map((v) => `${name}=${encodeURIComponent(v)}`).join('&');

/** Tenký klient offer API + počítadlo požadavků (pro logy / dokumentaci). */
export class FortunaApi {
  requests = 0;
  constructor(
    readonly t: Transport,
    /** Kolik fixtureIds na jeden požadavek (URL nad ~8 kB vrací 414). */
    readonly chunk = 180,
  ) {}

  private get<T>(url: string, signal?: AbortSignal): Promise<T> {
    this.requests++;
    return this.t.get<T>(url, signal);
  }

  /** Všechny zápasy sportu (stránkovaně po 500). Live: /live/sport/{id}/matches. */
  async sportMatches(sport: Sport, scope: FeedScope, signal?: AbortSignal): Promise<FtnMatchesPage[]> {
    const id = SPORTS_MAP[sport].id;
    const pages: FtnMatchesPage[] = [];
    for (let page = 0; page < 20; page++) {
      const url =
        scope === 'live'
          ? `${STRUCTURE}/live/sport/${id}/matches?pageSize=500&page=${page}`
          : `${STRUCTURE}/sport/${id}/matches?timeFilter=all&pageSize=500&page=${page}`;
      const p = await this.get<FtnMatchesPage>(url, signal);
      if (!p || !Array.isArray(p.fixtures)) throw new StrategyError(`unexpected matches response for ${sport}`, 'structure', { url });
      pages.push(p);
      if (!p.pagingInfo?.hasNext) break;
    }
    return pages;
  }

  /**
   * Hlavní trhy pro mnoho zápasů najednou. S explicitními typy (sports) vrací víc linií OU/AH
   * a jen dané typy; bez nich výchozí overview sadu (to, co web zobrazuje a websocket aktualizuje).
   */
  async overview(fixtureIds: string[], sports: Sport[] | null, signal?: AbortSignal): Promise<FtnMarketsByFixture> {
    const out: FtnMarketsByFixture = {};
    const types = sports ? '&' + ids('marketTypeIds', sports.flatMap((s) => OVERVIEW_TYPES[s]).map((t) => `ufo:mtyp:${t}`)) : '';
    for (let i = 0; i < fixtureIds.length; i += this.chunk) {
      const part = fixtureIds.slice(i, i + this.chunk);
      const r = await this.get<FtnMarketsByFixture>(`${MARKETS}/fixtures/markets/overview?${ids('fixtureIds', part)}${types}`, signal);
      if (!r || typeof r !== 'object' || Array.isArray(r)) throw new StrategyError('unexpected overview response', 'structure');
      Object.assign(out, r);
    }
    return out;
  }

  /** Všechny trhy jednoho zápasu (detail). */
  fixtureMarkets(fixtureId: string, signal?: AbortSignal): Promise<FtnMarket[]> {
    return this.get<FtnMarket[]>(`${MARKETS}/fixture/${encodeURIComponent(fixtureId)}/markets`, signal);
  }

  async miniscoreboards(fixtureIds: string[], signal?: AbortSignal): Promise<FtnMiniScoreboard[]> {
    const out: FtnMiniScoreboard[] = [];
    for (let i = 0; i < fixtureIds.length; i += this.chunk) {
      const r = await this.get<FtnMiniScoreboard[]>(`${STATS}/miniscoreboards?${ids('fixtureIds', fixtureIds.slice(i, i + this.chunk))}`, signal);
      if (!Array.isArray(r)) throw new StrategyError('unexpected miniscoreboards response', 'structure');
      out.push(...r);
    }
    return out;
  }

  liveSports(signal?: AbortSignal): Promise<unknown[]> {
    return this.get<unknown[]>(`${STRUCTURE}/live/sports`, signal);
  }
}

function bySport(fixtures: { id: string; sportId: string }[]): Map<Sport, string[]> {
  const m = new Map<Sport, string[]>();
  for (const f of fixtures) {
    const s = sportOfFixture(f as never);
    if (!s) continue;
    if (!m.has(s)) m.set(s, []);
    m.get(s)!.push(f.id);
  }
  return m;
}

export interface DetailOptions {
  /** Detail jen pro zápasy začínající do (ms). */
  windowMs: number;
  /** Sporty, jejichž klíčový trh v overview chybí (hokej: vítěz vč. prodloužení) – delší okno. */
  prioritySports: Sport[];
  priorityWindowMs: number;
  /** Kolik nejbližších zápasů sledovat. */
  maxTracked: number;
  /** Max detailů stažených v jednom fetchi. */
  maxPerFetch: number;
  /** Detail se obnovuje, když je starší než (ms). */
  refreshMs: number;
  /** Starší detail se do výstupu nedává (ms). */
  ttlMs: number;
}

export const DEFAULT_DETAIL: DetailOptions = {
  windowMs: 3 * 3600_000,
  prioritySports: ['hockey'],
  priorityWindowMs: 24 * 3600_000,
  maxTracked: 45,
  maxPerFetch: 15,
  refreshMs: 90_000,
  ttlMs: 4 * 60_000,
};

/** Sběr prematch: výpis per sport + hromadné overview + (volitelně) detail nejbližších zápasů. */
export async function collectPrematch(
  api: FortunaApi,
  sports: Sport[],
  detailCache: Map<string, { at: number; markets: FtnMarket[] }> | null,
  detail: DetailOptions | null,
  signal?: AbortSignal,
): Promise<FortunaBundle> {
  const pages: FtnMatchesPage[] = [];
  for (const s of sports) pages.push(...(await api.sportMatches(s, 'prematch', signal)));
  const fixtures = selectFixtures(pages, 'prematch', sports);
  const markets: FtnMarketsByFixture = {};
  for (const [sport, list] of bySport(fixtures)) Object.assign(markets, await api.overview(list, [sport], signal));

  if (detail && detailCache) {
    const now = Date.now();
    const soon = fixtures
      .filter((f) => {
        const dt = f.startDatetime - now;
        const win = detail.prioritySports.includes(sportOfFixture(f)!) ? Math.max(detail.windowMs, detail.priorityWindowMs) : detail.windowMs;
        return dt > 0 && dt < win;
      })
      .sort((a, b) => a.startDatetime - b.startDatetime)
      .slice(0, detail.maxTracked);
    const keep = new Set(soon.map((f) => f.id));
    for (const id of detailCache.keys()) if (!keep.has(id)) detailCache.delete(id);
    const due = soon
      .filter((f) => now - (detailCache.get(f.id)?.at ?? 0) > detail.refreshMs)
      .sort((a, b) => (detailCache.get(a.id)?.at ?? 0) - (detailCache.get(b.id)?.at ?? 0))
      .slice(0, detail.maxPerFetch);
    for (const f of due) {
      try {
        const ms = await api.fixtureMarkets(f.id, signal);
        if (Array.isArray(ms)) detailCache.set(f.id, { at: Date.now(), markets: ms.filter((m) => isMappedMarketType(m.marketTypeId ?? '')) });
      } catch (e) {
        if ((e as StrategyError).kind === 'blocked') throw e;
        detailCache.delete(f.id); // 404 apod. – zápas zmizel
      }
    }
    for (const [id, d] of detailCache) {
      if (Date.now() - d.at > detail.ttlMs) continue;
      markets[id] = [...(markets[id] ?? []), ...d.markets];
    }
  }
  return { scope: 'prematch', pages, markets };
}

/** Sběr live: výpis live zápasů (cache ttl) + 1 overview + 1 miniscoreboards požadavek. */
export async function collectLive(
  api: FortunaApi,
  sports: Sport[],
  listCache: { at: number; pages: FtnMatchesPage[] } | null,
  listTtlMs: number,
  typed: boolean,
  signal?: AbortSignal,
): Promise<{ bundle: FortunaBundle; list: { at: number; pages: FtnMatchesPage[] } }> {
  let list = listCache;
  if (!list || Date.now() - list.at > listTtlMs) {
    const pages: FtnMatchesPage[] = [];
    for (const s of sports) pages.push(...(await api.sportMatches(s, 'live', signal)));
    list = { at: Date.now(), pages };
  }
  const fixtures = selectFixtures(list.pages, 'live', sports);
  const allIds = fixtures.map((f) => f.id);
  const markets: FtnMarketsByFixture = allIds.length ? await api.overview(allIds, typed ? sports : null, signal) : {};
  const scoreboards = allIds.length ? await api.miniscoreboards(allIds, signal) : [];
  return { bundle: { scope: 'live', pages: list.pages, markets, scoreboards }, list };
}

export interface PollOptions {
  detail?: DetailOptions | null;
  /** Jak často obnovovat seznam live zápasů (ms). */
  liveListTtlMs?: number;
  /** Live overview s explicitními typy trhů (víc linií OU/AH, default true). */
  liveTyped?: boolean;
}

/** Polling strategie nad offer API (level 2 přes HTTP, level 5 přes prohlížeč). */
export class FortunaPollStrategy implements Strategy {
  readonly supports = { prematch: true, live: true };
  private detailCache = new Map<string, { at: number; markets: FtnMarket[] }>();
  private liveList: { at: number; pages: FtnMatchesPage[] } | null = null;
  private lastMinis = new Map<string, FtnMiniScoreboard>();

  constructor(
    readonly name: string,
    readonly level: StrategyLevel,
    private ctx: AdapterContext,
    private transport: Transport,
    private opts: PollOptions = {},
  ) {}

  async fetch(req: FetchRequest): Promise<RawOdds> {
    const api = new FortunaApi(this.transport);
    const t0 = Date.now();
    let bundle: FortunaBundle;
    if (req.scope === 'prematch') {
      bundle = await collectPrematch(api, req.sports, this.detailCache, this.opts.detail ?? null, req.signal);
    } else {
      const r = await collectLive(api, req.sports, this.liveList, this.opts.liveListTtlMs ?? 10_000, this.opts.liveTyped ?? true, req.signal);
      this.liveList = r.list;
      bundle = r.bundle;
      // periody z předchozího pollu, když je feed při přestávce vynechá
      bundle.scoreboards = (bundle.scoreboards ?? []).map((s) => mergeMini(this.lastMinis.get(s.fixtureId), s));
      this.lastMinis = new Map(bundle.scoreboards.map((s) => [s.fixtureId, s]));
    }
    const events = buildEvents(bundle, req.sports);
    this.ctx.log.debug(`${this.name} ${req.scope}`, { requests: api.requests, events: events.length, ms: Date.now() - t0 });
    if (req.scope === 'prematch' && !events.length) throw new StrategyError('no prematch events parsed', 'empty');
    return { bookmaker: 'fortuna', strategy: this.name, scope: req.scope, fetchedAt: Date.now(), events };
  }

  async healthCheck(): Promise<HealthResult> {
    const t0 = performance.now();
    try {
      const r = await new FortunaApi(this.transport).liveSports();
      return { ok: Array.isArray(r), latencyMs: Math.round(performance.now() - t0), httpStatus: 200 };
    } catch (e) {
      const err = e as StrategyError;
      return { ok: false, latencyMs: Math.round(performance.now() - t0), httpStatus: err.details?.status as number | undefined, message: err.message };
    }
  }

  async dispose(): Promise<void> {
    if (this.transport.kind === 'browser') await this.ctx.browser.closePage('fortuna');
  }
}
