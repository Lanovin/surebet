// Strategie betx: SportsOfferApi (Evona). L2 přímo přes HTTP, L5 stejné URL přes fetch v prohlížeči.
import type { FeedScope, HealthResult, RawEvent, RawOdds, Sport } from '../../core/types.js';
import type { AdapterContext, FetchRequest, Strategy, StrategyLevel } from '../types.js';
import { StrategyError } from '../types.js';
import {
  flattenLive,
  mergeEvents,
  parseBetxMatches,
  SPORT_IDS,
  type BetxFlatResponse,
  type BetxSportNode,
} from './parse.js';

export const API = 'https://sportapis-cz.betx.bet/SportsOfferApi/api/sport/';
const ORIGIN = 'https://bet-x.cz';
/** Bez Device-Type + TerminalId vrací API prázdné pole "[]". */
export const API_HEADERS: Record<string, string> = { 'Device-Type': 'desktop', TerminalId: '1', LanguageId: 'cs' };
/** Server stránkuje po max. 100 zápasech (větší Limit ignoruje, default 50). */
export const PAGE = 100;

export interface BetxOptions {
  /**
   * Prematch průchody listingem: každý BetTypeKey přidá k BasicOffer (1X2 / vítěz) hlavní linii
   * daného typu. 1. průchod jde přes celou nabídku, další jen do `horizonHours`.
   */
  prematchBetTypes?: Partial<Record<Sport, string[]>>;
  horizonHours?: number;
  /** Live: další BetTypeKey nad BasicOffer (každý = 1 požadavek navíc). */
  liveBetTypes?: string[];
}

export const DEFAULT_OPTIONS: Required<BetxOptions> = {
  prematchBetTypes: {
    football: ['60', '4'], // počet gólů, handicap (2-cestný)
    hockey: ['2', '60'], // vítěz vč. prodl. a nájezdů, počet gólů
    tennis: ['911', '910'], // počet gemů, handicap gemy
    basketball: ['1004', '1003'], // počet bodů, handicap (vč. prodl.); BasicOffer = vítěz vč. prodl.
  },
  horizonHours: 72,
  liveBetTypes: ['5_-1'], // počet gólů (fotbal + hokej)
};

export const flatUrl = (sportId: number, betType: string, offset: number, from: string, to?: string): string =>
  `${API}offer/v3/matches/flat?Offset=${offset}&Limit=${PAGE}&DateFrom=${from}&SportIds=${sportId}&BetTypeKey=${encodeURIComponent(betType)}` +
  (to ? `&DateTo=${to}` : '');
/**
 * Live listing. Server ho cachuje ~10 s podle řetězce SportIds a BetTypeKey při tom ignoruje
 * (dotaz s BetTypeKey by dostal nacachovaný základní listing). Každý průchod proto dostane
 * vlastní řetězec SportIds – duplicitní id ("388,389,388") server toleruje.
 */
export const liveUrl = (sportIds: number[], betType?: string, pass = 0): string =>
  `${API}offer/v3/matches/live?SportIds=${[...sportIds, ...Array(pass).fill(sportIds[0])].join(',')}` +
  (betType ? `&BetTypeKey=${encodeURIComponent(betType)}` : '');
const HEALTH_URL = `${API}offer/v3/sportsmenu/live`;

/** Surové odpovědi jednoho fetch() – pro fixtures a testy. */
export interface BetxRaw {
  flat: { url: string; body: BetxFlatResponse }[];
  live: { url: string; body: BetxSportNode[] }[];
  requests: number;
  bytes: number;
}

type Resp = { url: string; status: number; body: string };
type Download = (urls: string[]) => Promise<Resp[]>;

abstract class BetxBase implements Strategy {
  abstract readonly name: string;
  abstract readonly level: StrategyLevel;
  readonly supports = { prematch: true, live: true };
  protected readonly opts: Required<BetxOptions>;

  constructor(
    protected readonly ctx: AdapterContext,
    opts: BetxOptions = {},
  ) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
  }

  protected abstract download: Download;

  async fetchRaw(req: FetchRequest): Promise<BetxRaw> {
    const raw: BetxRaw = { flat: [], live: [], requests: 0, bytes: 0 };
    const sportIds = req.sports.map((s) => SPORT_IDS[s]).filter((x) => x !== undefined);
    if (!sportIds.length) return raw;
    const get = async (urls: string[]): Promise<Resp[]> => {
      const res = await this.download(urls);
      raw.requests += res.length;
      for (const r of res) raw.bytes += r.body.length;
      return res;
    };
    if (req.scope === 'live') {
      const urls = [liveUrl(sportIds), ...this.opts.liveBetTypes.map((k, i) => liveUrl(sportIds, k, i + 1))];
      const res = await get(urls);
      res.forEach((r, i) => {
        // BetTypeKey průchody jsou jen doplněk – když selžou, stačí základní listing
        if (i > 0 && r.status !== 200) return;
        raw.live.push({ url: r.url, body: parseJson<BetxSportNode[]>(r, true) });
      });
      return raw;
    }
    const now = new Date();
    const from = now.toISOString();
    const to = new Date(now.getTime() + this.opts.horizonHours * 3600_000).toISOString();
    const passes: { sportId: number; bt: string; to?: string }[] = [];
    for (const s of req.sports) {
      const keys = this.opts.prematchBetTypes[s] ?? [];
      keys.forEach((bt, i) => passes.push({ sportId: SPORT_IDS[s], bt, to: i === 0 ? undefined : to }));
    }
    // 1. stránka každého průchodu -> Count -> zbylé stránky
    const first = await get(passes.map((p) => flatUrl(p.sportId, p.bt, 0, from, p.to)));
    const rest: string[] = [];
    first.forEach((r, i) => {
      const body = parseJson<BetxFlatResponse>(r, false);
      raw.flat.push({ url: r.url, body });
      const p = passes[i];
      for (let off = PAGE; off < body.Count; off += PAGE) rest.push(flatUrl(p.sportId, p.bt, off, from, p.to));
    });
    for (const r of await get(rest)) raw.flat.push({ url: r.url, body: parseJson<BetxFlatResponse>(r, false) });
    return raw;
  }

  async fetch(req: FetchRequest): Promise<RawOdds> {
    const t0 = Date.now();
    const raw = await this.fetchRaw(req);
    const fetchedAt = Date.now();
    const events = parseRaw(raw, req.scope, fetchedAt);
    if (req.scope === 'prematch' && !events.length && raw.flat.every((f) => !f.body.Count)) {
      throw new StrategyError('betx prematch listing is empty', 'empty', { requests: raw.requests });
    }
    this.ctx.log.debug('fetched', {
      strategy: this.name,
      scope: req.scope,
      events: events.length,
      requests: raw.requests,
      kb: Math.round(raw.bytes / 1024),
      ms: fetchedAt - t0,
    });
    return { bookmaker: 'betx', strategy: this.name, scope: req.scope, fetchedAt, events };
  }

  async healthCheck(): Promise<HealthResult> {
    const t0 = performance.now();
    try {
      const [r] = await this.download([HEALTH_URL]);
      const ok = r.status === 200 && r.body.trim().startsWith('[');
      return { ok, latencyMs: Math.round(performance.now() - t0), httpStatus: r.status, message: ok ? undefined : r.body.slice(0, 200) };
    } catch (e) {
      return { ok: false, latencyMs: Math.round(performance.now() - t0), message: String((e as Error).message ?? e) };
    }
  }
}

function parseJson<T>(r: Resp, expectArray: boolean): T {
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
  // bez povinných hlaviček vrací API "[]" i pro flat listing
  const ok = expectArray ? Array.isArray(j) : !!j && typeof j === 'object' && Array.isArray((j as BetxFlatResponse).Response);
  if (!ok) throw new StrategyError(`unexpected structure from ${r.url}`, 'structure', { sample: r.body.slice(0, 300) });
  return j as T;
}

/** Převod surových odpovědí na události (čistá funkce – sdílí ji test i obě strategie). */
export function parseRaw(raw: BetxRaw, scope: FeedScope, now: number): RawEvent[] {
  if (scope === 'live') return mergeEvents(raw.live.map((l) => parseBetxMatches(flattenLive(l.body), { live: true })));
  const events = mergeEvents(raw.flat.map((f) => parseBetxMatches(f.body.Response, { live: false })));
  return events.filter((e) => e.startTime > now); // už začalo – kurzy by byly neaktuální
}

/** Level 2: přímé volání interního JSON API webu (bez cookies/tokenu, jen hlavičky Device-Type + TerminalId). */
export class BetxHttpStrategy extends BetxBase {
  readonly name = 'betx-api';
  readonly level = 2 as const;
  // server cachuje live ~10 s a při ~2 req/s vrací 403 -> nemá smysl pollovat rychleji
  readonly minIntervalMs = { live: 5_000 };

  protected download: Download = (urls) =>
    Promise.all(
      urls.map(async (url) => {
        const r = await this.ctx.http.text(url, {
          headers: { ...API_HEADERS, origin: ORIGIN, referer: `${ORIGIN}/` },
          allowStatus: [400, 404],
          timeoutMs: 20_000,
        });
        return { url, status: r.status, body: r.body };
      }),
    );
}

/**
 * Level 5: stejné API přes fetch() uvnitř Chromia (CORS povoluje jen origin https://bet-x.cz,
 * proto stránka stojí na malém JSON dokumentu bet-x.cz/assets/config.json – SPA se nenačítá).
 */
export class BetxBrowserStrategy extends BetxBase {
  readonly name = 'betx-browser';
  readonly level = 5 as const;
  readonly minIntervalMs = { live: 5_000 };

  protected download: Download = (urls) =>
    this.ctx.browser.withPage(this.ctx.bookmaker, async (page) => {
      if (!page.url().startsWith(ORIGIN)) await page.goto(`${ORIGIN}/assets/config.json`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      const out: Resp[] = [];
      for (let i = 0; i < urls.length; i += 4) {
        const part = await page.evaluate(
          async ({ list, headers }) =>
            Promise.all(
              list.map(async (url) => {
                const r = await fetch(url, { headers, credentials: 'omit' });
                return { url, status: r.status, body: await r.text() };
              }),
            ),
          { list: urls.slice(i, i + 4), headers: API_HEADERS },
        );
        out.push(...part);
      }
      return out;
    });

  async dispose(): Promise<void> {
    await this.ctx.browser.closePage(this.ctx.bookmaker);
  }
}
