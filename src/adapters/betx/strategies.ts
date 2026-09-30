// Strategie betx: SportsOfferApi (Evona).
//  L2 betx-api     – listing přes HTTP (prematch; live jen záloha – server live listing cachuje ~11 s)
//  L3 betx-push    – live přes SignalR push, který používá web (hub notificationv3); listing jen pro
//                    statická data zápasů (týmy, soutěž, začátek) a kontrolu mapování trhů
//  L5 betx-browser – stejné URL jako L2 přes fetch() v Chromiu
import WebSocket from 'ws';
import type { FeedScope, HealthResult, RawEvent, RawOdds, Sport } from '../../core/types.js';
import { DEFAULT_UA } from '../http.js';
import type { AdapterContext, FetchRequest, Strategy, StrategyLevel } from '../types.js';
import { StrategyError } from '../types.js';
import {
  BETX_SPORTS,
  checkPushTable,
  flattenLive,
  liveGeneratedAt,
  mergeEvents,
  mergePush,
  parseBetxMatches,
  pushSnapshot,
  SPORT_IDS,
  type BetxFlatResponse,
  type BetxMatch,
  type BetxPushMatch,
  type BetxSportNode,
  type PushConnState,
} from './parse.js';

export const API = 'https://sportapis-cz.betx.bet/SportsOfferApi/api/sport/';
const ORIGIN = 'https://bet-x.cz';
/** Bez Device-Type + TerminalId vrací API prázdné pole "[]". */
export const API_HEADERS: Record<string, string> = { 'Device-Type': 'desktop', TerminalId: '1', LanguageId: 'cs' };
/** Server stránkuje po max. 100 zápasech (větší Limit ignoruje, default 50). */
export const PAGE = 100;
/**
 * Live listing se na serveru přegeneruje nejdřív ~11 s po předchozím vygenerování. Polling po 6 s
 * trefí nové vygenerování každým druhým dotazem (stáří dat 0 / 6 s); po 5 s by to bylo 0 / 5 / 10 s
 * a o dotaz víc. Rychlejší polling nic nepřinese a riskuje 403 (IIS omezuje tempo z jedné IP).
 */
const LIVE_POLL_MS = 6_000;

export interface BetxOptions {
  /**
   * Prematch průchody listingem: každý BetTypeKey přidá k BasicOffer (1X2 / vítěz) hlavní linii
   * daného typu. 1. průchod jde přes celou nabídku, další jen do `horizonHours`.
   */
  prematchBetTypes?: Partial<Record<Sport, string[]>>;
  horizonHours?: number;
  /** Live listing: BetTypeKey průchody nad BasicOffer podle sportu (typ = 1 požadavek, sporty se stejným typem sdílí průchod). */
  liveBetTypes?: Partial<Record<Sport, string[]>>;
}

export const DEFAULT_OPTIONS: Required<BetxOptions> = {
  prematchBetTypes: {
    football: ['60', '4'], // počet gólů, handicap (2-cestný)
    hockey: ['2', '60'], // vítěz vč. prodl. a nájezdů, počet gólů
    tennis: ['911', '910'], // počet gemů, handicap gemy
    basketball: ['1004', '1003'], // počet bodů, handicap (vč. prodl.); BasicOffer = vítěz vč. prodl.
  },
  horizonHours: 72,
  // live BasicOffer: fotbal/hokej/basket 1X2 základní doby (UOF 1), tenis vítěz (186)
  liveBetTypes: {
    football: ['5_-1'], // počet gólů (UOF 18)
    hockey: ['5_-1', '7_106'], // počet gólů v základní době (18), vítěz vč. prodl. a nájezdů (406)
    basketball: ['7_37'], // vítěz vč. prodloužení (219)
  },
};

export const flatUrl = (sportId: number, betType: string, offset: number, from: string, to?: string): string =>
  `${API}offer/v3/matches/flat?Offset=${offset}&Limit=${PAGE}&DateFrom=${from}&SportIds=${sportId}&BetTypeKey=${encodeURIComponent(betType)}` +
  (to ? `&DateTo=${to}` : '');
/**
 * Live listing. Server ho cachuje ~11 s a klíčem cache je jen hodnota SportIds (BetTypeKey ani pořadí
 * parametrů se nepočítá – dotaz s BetTypeKey by dostal nacachovaný základní listing). Každý průchod
 * proto dostane vlastní řetězec SportIds – duplicitní id ("388,389,388") server toleruje.
 */
export const liveUrl = (sportIds: number[], betType?: string, pass = 0): string =>
  `${API}offer/v3/matches/live?SportIds=${[...sportIds, ...Array(pass).fill(sportIds[0])].join(',')}` +
  (betType ? `&BetTypeKey=${encodeURIComponent(betType)}` : '');
const HEALTH_URL = `${API}offer/v3/sportsmenu/live`;

/** Live průchody: základní listing + jeden průchod na BetTypeKey (sporty se stejným typem dohromady). */
export function livePasses(sports: Sport[], betTypes: Partial<Record<Sport, string[]>>): { sportIds: number[]; bt?: string }[] {
  const sportIds = sports.map((s) => SPORT_IDS[s]).filter((x) => x !== undefined);
  if (!sportIds.length) return [];
  const byBt = new Map<string, number[]>();
  for (const s of sports) {
    const id = SPORT_IDS[s];
    if (id !== undefined) for (const bt of new Set(betTypes[s] ?? [])) byBt.set(bt, [...(byBt.get(bt) ?? []), id]);
  }
  return [{ sportIds: [...new Set(sportIds)] }, ...[...byBt].map(([bt, ids]) => ({ sportIds: [...new Set(ids)], bt }))];
}

/** Surové odpovědi jednoho fetch() – pro fixtures a testy. */
export interface BetxRaw {
  flat: { url: string; body: BetxFlatResponse }[];
  /** requestedAt/receivedAt: kdy šel dotaz a kdy přišla odpověď (pro odhad stáří cache). */
  live: { url: string; body: BetxSportNode[]; requestedAt?: number; receivedAt?: number }[];
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
      const urls = livePasses(req.sports, this.opts.liveBetTypes).map((p, i) => liveUrl(p.sportIds, p.bt, i));
      const requestedAt = Date.now();
      const res = await get(urls);
      const receivedAt = Date.now();
      res.forEach((r, i) => {
        // BetTypeKey průchody jsou jen doplněk – když selžou, stačí základní listing
        if (i > 0 && r.status !== 200) return;
        raw.live.push({ url: r.url, body: parseJson<BetxSportNode[]>(r, true), requestedAt, receivedAt });
      });
      return raw;
    }
    const now = new Date();
    const from = now.toISOString();
    const to = new Date(now.getTime() + this.opts.horizonHours * 3600_000).toISOString();
    const passes: { sportId: number; bt: string; to?: string }[] = [];
    for (const s of req.sports) {
      const sportId = SPORT_IDS[s];
      if (sportId === undefined) continue;
      const keys = this.opts.prematchBetTypes[s] ?? [];
      keys.forEach((bt, i) => passes.push({ sportId, bt, to: i === 0 ? undefined : to }));
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
    const received = Date.now();
    // live: kdy server listing vygeneroval (cache ~11 s), ne kdy přišla odpověď
    const fetchedAt = req.scope === 'live' ? rawGeneratedAt(raw, received) : received;
    const events = parseRaw(raw, req.scope, received);
    if (req.scope === 'prematch' && !events.length && raw.flat.every((f) => !f.body.Count)) {
      throw new StrategyError('betx prematch listing is empty', 'empty', { requests: raw.requests });
    }
    this.ctx.log.debug('fetched', {
      strategy: this.name,
      scope: req.scope,
      events: events.length,
      requests: raw.requests,
      kb: Math.round(raw.bytes / 1024),
      ms: received - t0,
      ageMs: received - fetchedAt,
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

/**
 * Stáří live odpovědí: nejstarší okamžik vygenerování přes všechny průchody (trhy z různých průchodů
 * se slučují, takže platí nejstarší). Fixtures bez časů dotazu -> `fallback`.
 */
export function rawGeneratedAt(raw: BetxRaw, fallback: number): number {
  let at = Infinity;
  for (const l of raw.live) {
    const req = l.requestedAt ?? fallback;
    const rec = l.receivedAt ?? fallback;
    at = Math.min(at, liveGeneratedAt(flattenLive(l.body), req, rec));
  }
  return Number.isFinite(at) ? Math.round(at) : fallback;
}

/** Převod surových odpovědí na události (čistá funkce – sdílí ji test i obě strategie). */
export function parseRaw(raw: BetxRaw, scope: FeedScope, now: number): RawEvent[] {
  if (scope === 'live') return mergeEvents(raw.live.map((l) => parseBetxMatches(flattenLive(l.body), { live: true })));
  const events = mergeEvents(raw.flat.map((f) => parseBetxMatches(f.body.Response, { live: false })));
  return events.filter((e) => e.startTime > now); // už začalo – kurzy by byly neaktuální
}

/** HTTP download přes ctx.http (sdílený rate limit adaptéru). */
function httpDownload(ctx: AdapterContext): Download {
  return (urls) =>
    Promise.all(
      urls.map(async (url) => {
        const r = await ctx.http.text(url, {
          headers: { ...API_HEADERS, origin: ORIGIN, referer: `${ORIGIN}/` },
          allowStatus: [400, 404],
          timeoutMs: 20_000,
        });
        return { url, status: r.status, body: r.body };
      }),
    );
}

/** Level 2: přímé volání interního JSON API webu (bez cookies/tokenu, jen hlavičky Device-Type + TerminalId). */
export class BetxHttpStrategy extends BetxBase {
  readonly name = 'betx-api';
  readonly level = 2 as const;
  readonly minIntervalMs = { live: LIVE_POLL_MS };
  protected download: Download = httpDownload(this.ctx);
}

/**
 * Level 5: stejné API přes fetch() uvnitř Chromia (CORS povoluje jen origin https://bet-x.cz,
 * proto stránka stojí na malém JSON dokumentu bet-x.cz/assets/config.json – SPA se nenačítá).
 */
export class BetxBrowserStrategy extends BetxBase {
  readonly name = 'betx-browser';
  readonly level = 5 as const;
  readonly minIntervalMs = { live: LIVE_POLL_MS };

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

// ---------------------------------------------------------------- L3 SignalR push

const HUB = 'notificationv3';
const SIGNALR_QS = `clientProtocol=1.5&TerminalId=1&LanguageId=cs&connectionData=${encodeURIComponent(JSON.stringify([{ name: HUB }]))}`;
const SIGNALR_WS = `${API.replace(/^https:/, 'wss:')}signalr/connect`;

export interface BetxPushOptions {
  /**
   * BetTypeKey registrované k BasicOffer podle sportu. Server drží na jednom spojení jen jeden sport
   * a jeden registrovaný typ (další RegisterMatches / RegisterSportBetType ho nahradí) -> každý typ
   * = jedno SignalR spojení (jako jedna záložka webu). Sport bez typů = jedno spojení jen s BasicOffer.
   */
  pushBetTypes?: Partial<Record<Sport, string[]>>;
  /** Obnova listingu (statická data zápasů, nové zápasy); každý 4. i s průchody (kontrola mapování). */
  relistMs?: number;
  emitThrottleMs?: number;
  /** Kompletní stav se posílá i bez změn – push hlásí každou změnu, takže ticho na živém spojení = beze změny. */
  heartbeatMs?: number;
  /** Spojení bez jediné zprávy (server posílá keep-alive ~10 s) déle než tohle je mrtvé -> reconnect. */
  silentMs?: number;
}

export const PUSH_DEFAULTS: Required<BetxPushOptions> = {
  pushBetTypes: {
    football: ['5_-1'], // + BasicOffer 1X2
    hockey: ['5_-1', '7_106'], // počet gólů (zákl. doba), vítěz vč. prodl. a nájezdů
    basketball: ['7_37'], // vítěz vč. prodloužení
    tennis: ['7_922'], // handicap gemy (+ BasicOffer vítěz)
  },
  relistMs: 30_000,
  emitThrottleMs: 250,
  heartbeatMs: 1_000,
  silentMs: 25_000,
};

interface HubConn extends PushConnState {
  sport: Sport;
  ws?: WebSocket;
  open: boolean;
  lastMsgAt: number;
  attempt: number;
  timer?: NodeJS.Timeout;
}

/**
 * Level 3: live přes SignalR hub, který používá web (RegisterMatches([sportId]) +
 * RegisterSportBetType(sportId, bt, true)). Každá změna zápasu (kurzy, suspendace, skóre, čas) přijde
 * do ~0,5 s jako celý stav zápasu (BasicOffer + registrovaný typ); listing je proti tomu až ~11 s
 * starý (serverová cache) a suspendované zápasy z něj mizí se zpožděním. Push nenese týmy ani
 * UofKey: týmy/soutěž/začátek z listingu, trhy přes tabulku PUSH_BET_TYPES (kontrolovanou proti
 * UofKey listingu – nesouhlasící typ se vyřadí).
 */
export class BetxPushStrategy extends BetxBase {
  readonly name = 'betx-push';
  readonly level = 3 as const;
  override readonly supports = { prematch: false, live: true };
  readonly minIntervalMs = { live: LIVE_POLL_MS };
  private readonly push: Required<BetxPushOptions>;
  protected download: Download = httpDownload(this.ctx);

  constructor(ctx: AdapterContext, opts: BetxOptions = {}, push: BetxPushOptions = {}) {
    const p = { ...PUSH_DEFAULTS, ...push };
    // fetch() (polling, když runner push nepoužívá) i kontrola mapování jedou přes stejné typy jako push
    super(ctx, { ...opts, liveBetTypes: p.pushBetTypes });
    this.push = p;
  }

  override async fetch(req: FetchRequest): Promise<RawOdds> {
    if (req.scope !== 'live') throw new StrategyError('betx-push supports live only', 'other');
    return super.fetch(req);
  }

  async subscribe(req: FetchRequest, onData: (raw: RawOdds) => void, onError: (err: Error) => void): Promise<() => Promise<void>> {
    if (req.scope !== 'live') throw new StrategyError('betx-push supports live only', 'other');
    const log = this.ctx.log.child('push');
    const o = this.push;
    const sports = req.sports.filter((s) => SPORT_IDS[s] !== undefined);
    const conns: HubConn[] = sports.flatMap((sport) =>
      (o.pushBetTypes[sport]?.length ? o.pushBetTypes[sport]! : [undefined]).map((bt) => ({
        sport,
        sid: SPORT_IDS[sport]!,
        bt,
        open: false,
        live: true,
        lastMsgAt: 0,
        attempt: 0,
        items: new Map(),
      })),
    );
    /** Statická data zápasů z listingu (+ kdy byl zápas v listingu naposled). */
    const info = new Map<number, { m: BetxMatch; seenAt: number }>();
    const badBt = new Set<string>();
    let closed = false;
    let relistAt = 0;
    let relistCount = 0;
    let relistBusy = false;
    let relistFails = 0;
    let emitTimer: NodeJS.Timeout | undefined;
    let lastEmit = 0;
    const timers: NodeJS.Timeout[] = [];

    const healthy = (c: HubConn, now: number) => c.open && now - c.lastMsgAt < o.silentMs;

    const emit = () => {
      emitTimer = undefined;
      if (closed) return;
      const now = Date.now();
      lastEmit = now;
      if (!conns.some((c) => healthy(c, now))) return; // bez živého spojení nic (runner push watchdog přepne na polling)
      const statics = new Map([...info].map(([id, e]) => [id, e.m]));
      const matches = pushSnapshot(statics, conns, badBt, (c) => healthy(c as HubConn, now));
      try {
        onData({ bookmaker: 'betx', strategy: this.name, scope: 'live', fetchedAt: now, events: parseBetxMatches(matches, { live: true }) });
      } catch (e) {
        onError(e as Error);
      }
    };
    const scheduleEmit = () => {
      if (emitTimer || closed) return;
      emitTimer = setTimeout(emit, Math.max(0, o.emitThrottleMs - (Date.now() - lastEmit)));
    };

    /** Listing: statická data zápasů; každý 4. běh i BetTypeKey průchody pro kontrolu mapování. */
    const relist = async (full: boolean, initial = false) => {
      if (relistBusy || closed) return;
      relistBusy = true;
      relistAt = Date.now();
      try {
        const passes = livePasses(sports, full ? o.pushBetTypes : {});
        const res = await this.download(passes.map((p, i) => liveUrl(p.sportIds, p.bt, i)));
        const now = Date.now();
        const all: BetxMatch[] = [];
        res.forEach((r, i) => {
          if (i > 0 && r.status !== 200) return;
          all.push(...flattenLive(parseJson<BetxSportNode[]>(r, true)));
        });
        for (const m of all) if (BETX_SPORTS[m.SportId]) info.set(m.Id, { m, seenAt: now });
        for (const k of checkPushTable(all)) {
          if (!badBt.has(k)) log.error('push mapping disagrees with listing UofKey – bet type disabled', { betType: k });
          badBt.add(k);
        }
        // zápasy, které z listingu zmizely (konec, dlouhá suspendace) a push o nich 10 min mlčí
        for (const [id, e] of info) {
          const lastPush = Math.max(0, ...conns.map((c) => c.items.get(id)?.t ?? 0));
          if (now - e.seenAt > 600_000 && now - lastPush > 600_000) {
            info.delete(id);
            for (const c of conns) c.items.delete(id);
          }
        }
        relistFails = 0;
        scheduleEmit();
      } catch (e) {
        if (initial) throw e;
        relistFails++;
        log.warn('relist failed', { err: (e as Error).message, fails: relistFails });
        if (relistFails >= 3) onError(e as Error);
      } finally {
        relistBusy = false;
      }
    };

    const send = (c: HubConn, M: string, A: unknown[], I: number) => c.ws?.send(JSON.stringify({ H: HUB, M, A, I }));

    const onMessage = (c: HubConn, data: string) => {
      c.lastMsgAt = Date.now();
      c.attempt = 0;
      let j: { M?: { H?: string; M?: string; A?: unknown[] }[]; I?: string; E?: string };
      try {
        j = JSON.parse(data);
      } catch {
        return;
      }
      if (j.E) log.warn('hub error', { sport: c.sport, bt: c.bt, err: j.E });
      let changed = false;
      let unknown = false;
      for (const m of j.M ?? []) {
        if (m.M === 'liveStatus') {
          const live = m.A?.[0] === 1 || m.A?.[0] === true;
          if (live !== c.live) (c.live = live), (changed = true);
        } else if (m.M === 'liveUpdated' && Array.isArray(m.A?.[0])) {
          const now = Date.now();
          for (const x of m.A[0] as BetxPushMatch[]) {
            if (typeof x?.Id !== 'number' || x.sid !== c.sid) continue;
            c.items.set(x.Id, { t: now, x });
            if (!info.has(x.Id)) unknown = true;
            changed = true;
          }
        }
      }
      // nový živý zápas, který listing ještě nezná (listing je cachovaný ~11 s -> max. jednou za 12 s)
      if (unknown && Date.now() - relistAt > 12_000) void relist(false);
      if (changed) scheduleEmit();
    };

    const connect = async (c: HubConn) => {
      if (closed) return;
      clearTimeout(c.timer);
      try {
        const neg = await this.ctx.http.json<{ ConnectionToken?: string }>(`${API}signalr/negotiate?${SIGNALR_QS}&_=${Date.now()}`, {
          headers: { origin: ORIGIN, referer: `${ORIGIN}/` },
          timeoutMs: 15_000,
        });
        const token = neg.body.ConnectionToken;
        if (!token) throw new StrategyError('betx signalr negotiate: no ConnectionToken', 'structure');
        const tq = `${SIGNALR_QS}&connectionToken=${encodeURIComponent(token)}`;
        const ws = new WebSocket(`${SIGNALR_WS}?transport=webSockets&${tq}&tid=${Math.floor(Math.random() * 11)}`, {
          headers: { Origin: ORIGIN, 'User-Agent': DEFAULT_UA },
        });
        c.ws = ws;
        ws.on('open', () => {
          void (async () => {
            try {
              const st = await this.ctx.http.text(`${API}signalr/start?transport=webSockets&${tq}&_=${Date.now()}`, {
                headers: { origin: ORIGIN, referer: `${ORIGIN}/` },
                timeoutMs: 15_000,
              });
              if (!/started/.test(st.body)) throw new Error(`start: ${st.body.slice(0, 100)}`);
              c.open = true;
              c.lastMsgAt = Date.now();
              send(c, 'RegisterMatches', [[c.sid]], 0);
              if (c.bt) send(c, 'RegisterSportBetType', [c.sid, c.bt, true], 1);
              log.info('hub connected', { sport: c.sport, bt: c.bt });
            } catch (e) {
              log.warn('hub start failed', { sport: c.sport, err: (e as Error).message });
              ws.terminate();
            }
          })();
        });
        ws.on('message', (d) => onMessage(c, d.toString()));
        ws.on('close', (code) => {
          if (c.ws !== ws) return;
          c.open = false;
          c.items.clear(); // bez spojení nevíme, co se mezitím změnilo
          scheduleEmit();
          if (closed) return;
          const delay = Math.min(60_000, 2_000 * 2 ** Math.min(c.attempt++, 5));
          log.warn('hub closed, reconnecting', { sport: c.sport, bt: c.bt, code, delay });
          c.timer = setTimeout(() => void connect(c), delay);
          c.timer.unref();
        });
        ws.on('error', (err) => log.warn('hub websocket error', { sport: c.sport, err: err.message }));
      } catch (e) {
        const delay = Math.min(60_000, 2_000 * 2 ** Math.min(c.attempt++, 5));
        log.warn('hub connect failed', { sport: c.sport, bt: c.bt, err: (e as Error).message, delay });
        if (!closed) {
          c.timer = setTimeout(() => void connect(c), delay);
          c.timer.unref();
        }
      }
    };

    await relist(true, true);
    for (const c of conns) {
      await connect(c);
      await new Promise((r) => setTimeout(r, 500)); // nerozjíždět všechna spojení najednou (403 z IIS)
    }
    timers.push(
      setInterval(() => {
        relistCount++;
        void relist(relistCount % 4 === 0);
      }, o.relistMs),
    );
    timers.push(
      setInterval(() => {
        // mrtvé spojení (žádná zpráva ani keep-alive) -> terminate -> close handler se připojí znovu
        const now = Date.now();
        for (const c of conns) if (c.open && now - c.lastMsgAt > o.silentMs) c.ws?.terminate();
        if (now - lastEmit >= o.heartbeatMs) scheduleEmit();
      }, Math.min(o.heartbeatMs, 1_000)),
    );
    timers.forEach((t) => t.unref());

    return async () => {
      closed = true;
      timers.forEach((t) => clearInterval(t));
      if (emitTimer) clearTimeout(emitTimer);
      for (const c of conns) {
        clearTimeout(c.timer);
        c.ws?.close();
      }
    };
  }
}
