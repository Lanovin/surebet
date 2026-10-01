// Fortuna – strategie nad veřejným offer API (api.ifortuna.cz). Level 2 = plain HTTP,
// level 5 = stejné endpointy přes fetch() uvnitř stránky www.ifortuna.cz (fallback, kdyby API
// začalo blokovat ne-prohlížečové klienty). Parsování sdílí parse.ts.
import type { FeedScope, HealthResult, RawOdds, Sport } from '../../core/types.js';
import type { AdapterContext, FetchRequest, Strategy, StrategyLevel } from '../types.js';
import { StrategyError } from '../types.js';
import {
  API,
  OVERVIEW_TYPES,
  PRIMARY_SPORTS,
  SITE,
  SPORTS_MAP,
  buildEvents,
  isMappedMarketType,
  mergeMini,
  selectFixtures,
  sportOfFixture,
  type FortunaBundle,
  type FtnFixture,
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

/** Zápas pro hromadné overview: ID + sport (určuje typy trhů v typovaném požadavku). */
export interface OverviewItem {
  id: string;
  sport: Sport;
}

/** Tenký klient offer API + počítadlo požadavků (pro logy / dokumentaci). */
export class FortunaApi {
  requests = 0;
  constructor(
    readonly t: Transport,
    /** Kolik fixtureIds na jeden požadavek. */
    readonly chunk = 180,
    /** Max délka URL: nad ~7 600 znaků server vrací 400, nad ~8 kB 414 (ověřeno 30. 9. 2026). */
    readonly maxUrl = 6_800,
  ) {}

  private get<T>(url: string, signal?: AbortSignal): Promise<T> {
    this.requests++;
    return this.t.get<T>(url, signal);
  }

  /** Všechny zápasy sportu (stránkovaně po 500). Live: /live/sport/{id}/matches. */
  async sportMatches(sport: Sport, scope: FeedScope, signal?: AbortSignal): Promise<FtnMatchesPage[]> {
    const id = SPORTS_MAP[sport]?.id;
    if (!id) return [];
    const pages: FtnMatchesPage[] = [];
    for (let page = 0; page < 20; page++) {
      const url =
        scope === 'live'
          ? `${STRUCTURE}/live/sport/${id}/matches?pageSize=500&page=${page}`
          : `${STRUCTURE}/sport/${id}/matches?timeFilter=all&pageSize=500&page=${page}`;
      let p: FtnMatchesPage;
      try {
        p = await this.get<FtnMatchesPage>(url, signal);
      } catch (e) {
        // sport bez jediného (live) zápasu: 404 „Structure with id ufo:sprt:0w not found“ = prázdný výpis
        if (page === 0 && (e as StrategyError).details?.status === 404) {
          pages.push({ fixtures: [] });
          break;
        }
        throw e;
      }
      if (!p || !Array.isArray(p.fixtures)) throw new StrategyError(`unexpected matches response for ${sport}`, 'structure', { url });
      pages.push(p);
      if (!p.pagingInfo?.hasNext) break;
    }
    return pages;
  }

  /**
   * Hlavní trhy pro mnoho zápasů najednou. Typované (`typed`) = s explicitními typy trhů sportů
   * v dávce: víc linií OU/AH a jen dané typy (typy jsou sportově prefixované, sporty jde míchat
   * v jednom požadavku); netypované = výchozí overview sada (to, co web zobrazuje a websocket
   * aktualizuje). Dávky se plní podle počtu ID i délky URL (typy jen sportů obsažených v dávce).
   */
  async overview(items: OverviewItem[], typed: boolean, signal?: AbortSignal): Promise<FtnMarketsByFixture> {
    const out: FtnMarketsByFixture = {};
    for (const url of this.overviewUrls(items, typed)) {
      const r = await this.get<FtnMarketsByFixture>(url, signal);
      if (!r || typeof r !== 'object' || Array.isArray(r)) throw new StrategyError('unexpected overview response', 'structure');
      Object.assign(out, r);
    }
    return out;
  }

  /** URL dávek hromadného overview (zápasy seskupené podle sportu, aby se typy neopakovaly). */
  overviewUrls(items: OverviewItem[], typed: boolean): string[] {
    const order = new Map<Sport, number>();
    for (const it of items) if (!order.has(it.sport)) order.set(it.sport, order.size);
    const sorted = [...items].sort((a, b) => order.get(a.sport)! - order.get(b.sport)!);
    const base = `${MARKETS}/fixtures/markets/overview?`;
    const typesOf = (sports: Set<Sport>) =>
      typed ? [...sports].flatMap((s) => OVERVIEW_TYPES[s] ?? []).map((t) => `&${ids('marketTypeIds', [`ufo:mtyp:${t}`])}`).join('') : '';
    const urls: string[] = [];
    let part: string[] = [];
    let sports = new Set<Sport>();
    const flush = () => {
      if (part.length) urls.push(`${base}${part.join('&')}${typesOf(sports)}`);
      part = [];
      sports = new Set();
    };
    for (const it of sorted) {
      const idParam = ids('fixtureIds', [it.id]);
      const nextSports = sports.has(it.sport) ? sports : new Set([...sports, it.sport]);
      const len = base.length + [...part, idParam].join('&').length + typesOf(nextSports).length;
      if (part.length && (part.length >= this.chunk || len > this.maxUrl)) flush();
      part.push(idParam);
      sports.add(it.sport);
    }
    flush();
    return urls;
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

  /**
   * Sporty, které mají právě live zápasy (/live/sports, `fixturesCount`) – výpis live se pak stahuje
   * jen pro ně (sport bez live zápasů vrací 404). Při chybě / neznámém tvaru odpovědi null = všechny.
   */
  async liveSportsWithFixtures(sports: Sport[], signal?: AbortSignal): Promise<Sport[] | null> {
    let r: unknown[];
    try {
      r = await this.liveSports(signal);
    } catch (e) {
      if ((e as StrategyError).kind === 'blocked') throw e;
      return null;
    }
    if (!Array.isArray(r)) return null;
    const live = new Set<string>();
    for (const x of r as { id?: unknown; fixturesCount?: unknown }[]) {
      if (typeof x?.id !== 'string') return null;
      if (typeof x.fixturesCount !== 'number' || x.fixturesCount > 0) live.add(x.id);
    }
    return sports.filter((s) => live.has(SPORTS_MAP[s]?.id ?? ''));
  }
}

function overviewItems(fixtures: FtnFixture[]): OverviewItem[] {
  const out: OverviewItem[] = [];
  for (const f of fixtures) {
    const sport = sportOfFixture(f);
    if (sport) out.push({ id: f.id, sport });
  }
  return out;
}

export interface DetailOptions {
  /** Detail jen pro zápasy začínající do (ms). */
  windowMs: number;
  /** Sporty, jejichž klíčový trh v overview chybí (hokej: vítěz vč. prodloužení) – delší okno. */
  prioritySports: Sport[];
  priorityWindowMs: number;
  /** Hlavní sporty – sdílejí rozpočet `maxTracked`. */
  sports: Sport[];
  /** Kolik nejbližších zápasů hlavních sportů sledovat. */
  maxTracked: number;
  /**
   * Další sporty s vlastním (menším) rozpočtem, aby nevytlačily hlavní sporty: házená (dvojtip,
   * DNB, poločasy), baseball (1X2, run line), americký fotbal (1X2, handicap), volejbal (handicap
   * setů/bodů), snooker (handicap framů), šipky (sety). Ostatní sporty (MMA, box, stolní tenis)
   * mají všechny mapované trhy v overview.
   */
  extraSports: Sport[];
  extraWindowMs: number;
  extraMaxTracked: number;
  /** Max detailů stažených v jednom fetchi. */
  maxPerFetch: number;
  /** Detail se obnovuje, když je starší než (ms). */
  refreshMs: number;
  /** Starší detail se do výstupu nedává (ms). */
  ttlMs: number;
}

export const DEFAULT_DETAIL: DetailOptions = {
  windowMs: 12 * 3600_000,
  prioritySports: ['hockey'],
  priorityWindowMs: 24 * 3600_000,
  sports: PRIMARY_SPORTS,
  maxTracked: 150,
  extraSports: ['handball', 'baseball', 'american_football', 'volleyball', 'snooker', 'darts'],
  extraWindowMs: 24 * 3600_000,
  extraMaxTracked: 40,
  // ~190 sledovaných / refreshMs 3 min při prematch pollu ~1 min ≈ 60 detailů na fetch (< maxPerFetch)
  maxPerFetch: 80,
  refreshMs: 180_000,
  ttlMs: 8 * 60_000,
};

/** Zápasy, pro které se v prematch stahuje detail: nejbližší zápasy hlavních sportů + menší kvóta dalších. */
export function detailTargets(fixtures: FtnFixture[], detail: DetailOptions, now = Date.now()): FtnFixture[] {
  const pick = (sports: Sport[], windowOf: (s: Sport) => number, max: number) =>
    fixtures
      .filter((f) => {
        const sport = sportOfFixture(f);
        if (!sport || !sports.includes(sport)) return false;
        const dt = f.startDatetime - now;
        return dt > 0 && dt < windowOf(sport);
      })
      .sort((a, b) => a.startDatetime - b.startDatetime)
      .slice(0, max);
  const main = pick(
    detail.sports,
    (s) => (detail.prioritySports.includes(s) ? Math.max(detail.windowMs, detail.priorityWindowMs) : detail.windowMs),
    detail.maxTracked,
  );
  const extra = pick(detail.extraSports, () => detail.extraWindowMs, detail.extraMaxTracked);
  return [...main, ...extra];
}

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
  const dataAt = Date.now();
  // všechny sporty v jednom proudu dávek (malé sporty se vejdou do zbytku dávky velkých)
  const markets: FtnMarketsByFixture = fixtures.length ? await api.overview(overviewItems(fixtures), true, signal) : {};

  if (detail && detailCache) {
    const now = Date.now();
    const soon = detailTargets(fixtures, detail, now);
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
  // pozn.: trhy z detailu můžou být až ttlMs staré (jeden fetchedAt na celý výstup to nevyjádří)
  return { scope: 'prematch', pages, markets, dataAt };
}

/**
 * Sběr live: /live/sports + výpis live zápasů jen sportů, které live zápasy mají (cache ttl)
 * + 1 overview + 1 miniscoreboards požadavek (víc dávek jen při stovkách live zápasů).
 */
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
    const withLive = (await api.liveSportsWithFixtures(sports, signal)) ?? sports;
    for (const s of withLive) pages.push(...(await api.sportMatches(s, 'live', signal)));
    list = { at: Date.now(), pages };
  }
  const fixtures = selectFixtures(list.pages, 'live', sports);
  const allIds = fixtures.map((f) => f.id);
  // kurzy platí k okamžiku požadavku na overview (bez CDN cache), ne ke konci celého sběru
  const dataAt = Date.now();
  const markets: FtnMarketsByFixture = allIds.length ? await api.overview(overviewItems(fixtures), typed, signal) : {};
  const scoreboards = allIds.length ? await api.miniscoreboards(allIds, signal) : [];
  return { bundle: { scope: 'live', pages: list.pages, markets, scoreboards, dataAt }, list };
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
    const sports = req.sports.filter((s) => SPORTS_MAP[s]);
    let bundle: FortunaBundle;
    if (req.scope === 'prematch') {
      bundle = await collectPrematch(api, sports, this.detailCache, this.opts.detail ?? null, req.signal);
    } else {
      const r = await collectLive(api, sports, this.liveList, this.opts.liveListTtlMs ?? 10_000, this.opts.liveTyped ?? true, req.signal);
      this.liveList = r.list;
      bundle = r.bundle;
      // periody z předchozího pollu, když je feed při přestávce vynechá
      bundle.scoreboards = (bundle.scoreboards ?? []).map((s) => mergeMini(this.lastMinis.get(s.fixtureId), s));
      this.lastMinis = new Map(bundle.scoreboards.map((s) => [s.fixtureId, s]));
    }
    const events = buildEvents(bundle, sports);
    this.ctx.log.debug(`${this.name} ${req.scope}`, { requests: api.requests, events: events.length, ms: Date.now() - t0 });
    if (req.scope === 'prematch' && !events.length) throw new StrategyError('no prematch events parsed', 'empty');
    return { bookmaker: 'fortuna', strategy: this.name, scope: req.scope, fetchedAt: bundle.dataAt ?? t0, events };
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
