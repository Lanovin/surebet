// Sazka / Allwyn strategie: L2 REST (Node fetch), L3 push websocket (live).
// L5 (fetch v prohlížeči) vynechán: headless Chromium dostává od Akamai Bot Manageru 403
// "Access Denied" už na www.allwyn.cz (i s běžným UA) → CORS preflight na API selže.
import WebSocket from 'ws';
import type { FeedScope, HealthResult, RawOdds, Sport } from '../../core/types.js';
import type { AdapterContext, FetchRequest, Strategy, StrategyLevel } from '../types.js';
import { StrategyError } from '../types.js';
import { DEFAULT_UA } from '../http.js';
import type { ObEvent } from './parse.js';
import { mergeListingAndDetail, parseEvents } from './parse.js';
import type { CallStats, Transport } from './api.js';
import { chunk, detailUrl, getEvents, HEALTH_URL, HTTP_HEADERS, listingUrl, ORIGIN, WS_URL } from './api.js';
import type { PushMessage } from './push.js';
import { applyMessage, decodeMessage, encodeConnect, encodePing, encodeSubscribe, encodeUnsubscribe } from './push.js';

export interface SazkaOptions {
  /** Prematch: detail (všechny trhy) pro události začínající do N hodin. 0 = jen listing. */
  detailHorizonHours?: number;
  /** Prematch: max. počet událostí s detailem (≈ detailBatch událostí na požadavek). */
  maxDetailEvents?: number;
  /** Kolik událostí v jednom detail požadavku. */
  detailBatch?: number;
  /** Live: stahovat i detail (všechny trhy) živých zápasů – 1–2 požadavky navíc. */
  liveDetail?: boolean;
  /**
   * Prematch s cache-busterem `_=<ms>`: bez něj vrací cache za Akamai data až ~90 s stará
   * a nemonotónně (další poll může být starší než předchozí → kurzy "skáčou" zpět, falešné arby).
   * Stejný počet požadavků, jen je obslouží origin (fotbalový listing ~2,5 s místo ~1 s).
   */
  prematchCacheBust?: boolean;
}

const DEFAULTS: Required<SazkaOptions> = {
  detailHorizonHours: 24,
  maxDetailEvents: 160,
  detailBatch: 40,
  liveDetail: true,
  prematchCacheBust: true,
};

/** Společné jádro: stáhne listing (+ detail) a naparsuje. Transport volí strategie. */
export class SazkaCore {
  readonly o: Required<SazkaOptions>;
  constructor(
    private readonly ctx: AdapterContext,
    private readonly transport: Transport,
    opts: SazkaOptions = {},
  ) {
    this.o = { ...DEFAULTS, ...opts };
  }

  /** Surové události (listing + detail) pro scope. */
  async loadRaw(scope: FeedScope, sports: Sport[], stats: CallStats): Promise<ObEvent[]> {
    const t = this.transport;
    if (scope === 'live') {
      const listing = await this.loadLiveListing(sports, stats);
      if (!this.o.liveDetail || !listing.length) return listing;
      try {
        const detail = await this.loadDetail(listing.map((e) => e.id), stats, 15_000, true);
        return mergeListingAndDetail(listing, detail);
      } catch (err) {
        this.ctx.log.warn('live detail failed, using listing only', { err: (err as Error).message });
        return listing;
      }
    }
    // prematch: jeden listing na sport (fotbal ~150 kB gzip, 1–3 s)
    const bust = this.o.prematchCacheBust;
    const lists = await Promise.all(sports.map((s) => getEvents(t, listingUrl([s], 'prematch', bust), 45_000, stats)));
    const listing = lists.flat().filter((e) => !e.liveNow && !e.started);
    if (this.o.detailHorizonHours <= 0 || this.o.maxDetailEvents <= 0) return listing;
    const now = Date.now();
    const horizon = now + this.o.detailHorizonHours * 3600_000;
    const pick = listing
      .filter((e) => {
        const st = Date.parse(e.startTime);
        return st > now && st <= horizon && e.sortCode === 'MTCH';
      })
      .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime))
      .slice(0, this.o.maxDetailEvents)
      .map((e) => e.id);
    if (!pick.length) return listing;
    try {
      const detail = await this.loadDetail(pick, stats, 30_000, bust);
      return mergeListingAndDetail(listing, detail);
    } catch (err) {
      this.ctx.log.warn('prematch detail failed, using listing only', { err: (err as Error).message });
      return listing;
    }
  }

  /** Live listing (vždy cache-bust), jen právě hrané zápasy. */
  async loadLiveListing(sports: Sport[], stats: CallStats): Promise<ObEvent[]> {
    return (await getEvents(this.transport, listingUrl(sports, 'live'), 15_000, stats)).filter((e) => e.liveNow);
  }

  async loadDetail(ids: string[], stats: CallStats, timeoutMs: number, bust = false): Promise<ObEvent[]> {
    const out: ObEvent[] = [];
    // sekvenčně – šetrné k API (HttpClient navíc drží minIntervalMs)
    for (const part of chunk(ids, this.o.detailBatch)) out.push(...(await getEvents(this.transport, detailUrl(part, bust), timeoutMs, stats)));
    return out;
  }

  async fetch(strategy: string, req: FetchRequest): Promise<RawOdds> {
    const stats: CallStats = { requests: 0, bytes: 0 };
    const t0 = performance.now();
    const raw = await this.loadRaw(req.scope, req.sports, stats);
    // fetchedAt = stáří dat podle X-Created-At (nejstarší z odpovědí; bez cache-busteru až ~90 s)
    const fetchedAt = Math.min(Date.now(), stats.oldest ?? Date.now());
    const events = parseEvents(raw, { scope: req.scope, now: Date.now(), sports: req.sports });
    this.ctx.log.debug('fetched', { strategy, scope: req.scope, ...stats, ms: Math.round(performance.now() - t0), events: events.length });
    if (!events.length && req.scope === 'prematch') throw new StrategyError('sazka: no prematch events parsed', 'empty', { ...stats });
    return { bookmaker: 'sazka', strategy, scope: req.scope, fetchedAt, events };
  }

  async health(): Promise<HealthResult> {
    const t0 = performance.now();
    try {
      const r = await this.transport(HEALTH_URL, 10_000);
      const ok = r.status === 200 && !!(r.body as { data?: unknown })?.data;
      return { ok, latencyMs: Math.round(performance.now() - t0), httpStatus: r.status };
    } catch (e) {
      const err = e as StrategyError;
      return { ok: false, latencyMs: Math.round(performance.now() - t0), httpStatus: err.details?.status as number | undefined, message: err.message };
    }
  }
}

/** Transport přes ctx.http (Node fetch, gzip). */
export function httpTransport(ctx: AdapterContext): Transport {
  return async (url, timeoutMs) => {
    const r = await ctx.http.text(url, { headers: HTTP_HEADERS, timeoutMs, allowStatus: [400, 403, 404, 429, 500, 502, 503] });
    let body: unknown;
    try {
      body = JSON.parse(r.body);
    } catch {
      throw new StrategyError('sazka: non-JSON response', /akamai|access denied|captcha/i.test(r.body) ? 'blocked' : 'structure', {
        status: r.status,
        sample: r.body.slice(0, 300),
      });
    }
    const ca = Date.parse(r.headers.get('x-created-at') ?? '');
    return { status: r.status, body, bytes: r.body.length, createdAt: Number.isFinite(ca) ? ca : undefined };
  };
}

// ---------------------------------------------------------------- L2

export class SazkaApiStrategy implements Strategy {
  readonly name = 'openbet-api';
  readonly level: StrategyLevel = 2;
  readonly supports = { prematch: true, live: true };
  /** Live poll = 1 listing + ⌈zápasy/40⌉ detailů (≈3 požadavky při 80 zápasech) → max. ~1,5 req/s. */
  readonly minIntervalMs = { live: 2_000 };
  private readonly core: SazkaCore;
  constructor(ctx: AdapterContext, opts?: SazkaOptions) {
    this.core = new SazkaCore(ctx, httpTransport(ctx), opts);
  }
  fetch(req: FetchRequest): Promise<RawOdds> {
    return this.core.fetch(this.name, req);
  }
  healthCheck(): Promise<HealthResult> {
    return this.core.health();
  }
}

// ---------------------------------------------------------------- L3

/** Push zprávy přijaté méně než REPLAY_MS před vznikem REST odpovědi se po jejím použití přehrají znovu. */
export const REPLAY_MS = 3_000;
/** Jak dlouho držet přijaté zprávy pro přehrání po REST refreshi. */
const RECENT_KEEP_MS = 15_000;
/** Websocket bez jediné zprávy (ani pong na ping á 15 s) → spojení je mrtvé, znovu připojit. */
const SILENCE_MS = 35_000;

interface RecentMessage {
  t: number;
  ev: string;
  msg: PushMessage;
}

/**
 * Stav push strategie: události (REST snapshot + delty) a buffer nedávných zpráv.
 *
 * Klíčové: REST odpověď (detail/listing) vzniká v čase T (X-Created-At), ale do stavu se dostane
 * až po ~0,3–1 s. Delty přijaté mezitím by se nahrazením události ztratily (30. 9. naměřeno:
 * ~90 trhů s jinou cenou než web a ~90 zastaralých "otevřených" linií na 12 porovnáních) → po
 * každém nahrazení se přehrají zprávy přijaté od T − REPLAY_MS (idempotentní, v pořadí).
 */
export class PushState {
  readonly events = new Map<string, ObEvent>();
  /** Trhy s nemapovaným groupCode – zprávy k nim nevyžadují resync. */
  readonly ignored = new Set<string>();
  readonly dirty = new Set<string>();
  private recent: RecentMessage[] = [];

  /** Aplikuje živou zprávu (a uloží ji pro případné přehrání). Vrací true, když se stav změnil. */
  onMessage(msg: PushMessage, t: number): boolean {
    const ev = String(msg.body.ev_id ?? msg.channelId);
    this.recent.push({ t, ev, msg });
    const r = applyMessage(this.events, msg, { ignored: this.ignored });
    if (r.resync) this.dirty.add(r.resync);
    return r.changed;
  }

  /**
   * Nahradí události čerstvými REST daty (detail je autoritativní – trhy, které v něm chybí, zmizí)
   * a přehraje zprávy, které REST (vzniklý v `restAt`) ještě nemusel obsahovat.
   * `keepMarkets`: jen listing bez detailu → ponechat dosavadní trhy, obnovit stav/commentary.
   */
  install(fresh: ObEvent[], restAt: number, keepMarkets = false): void {
    const ids = new Set<string>();
    for (const d of fresh) {
      const id = String(d.id);
      ids.add(id);
      const cur = this.events.get(id);
      if (!cur) this.events.set(id, d);
      else if (keepMarkets) this.events.set(id, { ...cur, ...d, commentary: d.commentary ?? cur.commentary, markets: cur.markets });
      else this.events.set(id, { ...cur, ...d, commentary: d.commentary ?? cur.commentary, markets: d.markets ?? [] });
      if (!keepMarkets) this.dirty.delete(id);
    }
    this.replay(ids, restAt);
  }

  /** Odebere události mimo `keep` (skončené / zmizelé z live nabídky). Vrací true, když nějaká zmizela. */
  retain(keep: Set<string>): boolean {
    let changed = false;
    for (const id of [...this.events.keys()]) {
      if (keep.has(id)) continue;
      this.events.delete(id);
      this.dirty.delete(id);
      changed = true;
    }
    return changed;
  }

  private replay(ids: Set<string>, restAt: number): void {
    const from = restAt - REPLAY_MS;
    for (const r of this.recent) {
      if (r.t < from || !ids.has(r.ev)) continue;
      const res = applyMessage(this.events, r.msg, { ignored: this.ignored });
      // nový trh ohlášený až po vzniku REST odpovědi → další resync (ceny/skryté výběry ne)
      if (res.resync && r.msg.subjectType === 'sEVMKT') this.dirty.add(res.resync);
    }
  }

  prune(now: number): void {
    const cut = now - RECENT_KEEP_MS;
    let i = 0;
    while (i < this.recent.length && this.recent[i].t < cut) i++;
    if (i) this.recent.splice(0, i);
  }
}

/**
 * Live přes OpenBet push: websocket delty (ceny, stavy trhů/výběrů, hodiny) nad REST stavem.
 * REST údržba (jedna smyčka, nikdy souběžně): plný snapshot (listing → subscribe → detail) á
 * `resyncMs` a po každém (znovu)připojení, listing á `listIntervalMs` (nové/skončené zápasy,
 * skóre), detail "dirty" zápasů (nový trh/výběr/perioda) á ≥ 2 s. Po každém REST nahrazení se
 * přehrají nedávné delty (PushState). Bez spojení / do snapshotu po výpadku se neemituje
 * (data by vypadala čerstvá, ale chyběly by delty) – runner pak po 15 s přepne na polling.
 */
export class SazkaPushStrategy implements Strategy {
  readonly name = 'openbet-push';
  readonly level: StrategyLevel = 3;
  readonly supports = { prematch: false, live: true };
  private readonly core: SazkaCore;
  constructor(
    private readonly ctx: AdapterContext,
    private readonly opts: { listIntervalMs?: number; resyncMs?: number; emitThrottleMs?: number } = {},
  ) {
    this.core = new SazkaCore(ctx, httpTransport(ctx), { liveDetail: true });
  }

  fetch(req: FetchRequest): Promise<RawOdds> {
    if (req.scope !== 'live') throw new StrategyError('openbet-push supports live only', 'other');
    return this.core.fetch(this.name, req);
  }

  healthCheck(): Promise<HealthResult> {
    return this.core.health();
  }

  async subscribe(req: FetchRequest, onData: (raw: RawOdds) => void, onError: (err: Error) => void): Promise<() => Promise<void>> {
    if (req.scope !== 'live') throw new StrategyError('openbet-push supports live only', 'other');
    const log = this.ctx.log.child('push');
    const state = new PushState();
    const { events, dirty } = state;
    const subscribed = new Set<string>();
    let ws: WebSocket | undefined;
    let closed = false;
    let pingId = 0;
    let emitTimer: NodeJS.Timeout | undefined;
    let lastEmit = 0;
    const throttle = this.opts.emitThrottleMs ?? 250;
    const listEvery = this.opts.listIntervalMs ?? 10_000;
    const snapEvery = this.opts.resyncMs ?? 60_000;
    const timers: NodeJS.Timeout[] = [];
    let busy = false;
    /** Poslední zpráva z websocketu (vč. pongů). */
    let lastMsgAt = 0;
    /** Kdy se websocket naposledy otevřel. */
    let openedAt = 0;
    /** Mezera v deltách (výpadek spojení) – trvá, dokud neproběhne snapshot započatý po připojení. */
    let gap = true;
    let needSnapshot = false;
    /** Do kdy je stav prokazatelně úplný (fetchedAt emitovaných dat). */
    let freshAt = 0;
    let lastSnapAt = 0;
    let lastSnapTryAt = 0;
    let lastListAt = 0;
    let lastDirtyAt = 0;

    const wsLive = () => !!ws && ws.readyState === WebSocket.OPEN && Date.now() - lastMsgAt < SILENCE_MS;

    const emit = () => {
      emitTimer = undefined;
      lastEmit = Date.now();
      const now = Date.now();
      // bez živého spojení (nebo před snapshotem po výpadku) chybí delty → neemitovat; runner po
      // 15 s ticha přepne na polling a detektor mezitím nohy sazky zestárne (stale)
      if (gap || !wsLive()) return;
      freshAt = now;
      try {
        onData({
          bookmaker: 'sazka',
          strategy: this.name,
          scope: 'live',
          fetchedAt: freshAt,
          events: parseEvents([...events.values()], { scope: 'live', now, sports: req.sports }),
        });
      } catch (e) {
        onError(e as Error);
      }
    };
    const scheduleEmit = () => {
      if (emitTimer || closed) return;
      emitTimer = setTimeout(emit, Math.max(0, throttle - (Date.now() - lastEmit)));
    };

    const sync = (ids: string[]) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const want = new Set(ids);
      const add = ids.filter((id) => !subscribed.has(id));
      const del = [...subscribed].filter((id) => !want.has(id));
      for (const part of chunk(add, 50)) ws.send(encodeSubscribe(part));
      for (const part of chunk(del, 50)) ws.send(encodeUnsubscribe(part));
      add.forEach((id) => subscribed.add(id));
      del.forEach((id) => subscribed.delete(id));
    };

    /**
     * Listing (nové/skončené zápasy, skóre) → subscribe nových → detail (`full`: všech, jinak jen
     * nových) → nahrazení + přehrání delt. Pořadí subscribe → detail zaručí, že delty po vzniku
     * detailu buď přišly živě (a jsou v bufferu), nebo jsou v úvodní dávce kanálu.
     */
    const refresh = async (full: boolean) => {
      const t0 = Date.now();
      lastListAt = t0;
      if (full) lastSnapTryAt = t0;
      const wsOpenBefore = ws?.readyState === WebSocket.OPEN ? openedAt : 0;
      const ls: CallStats = { requests: 0, bytes: 0 };
      const listing = await this.core.loadLiveListing(req.sports, ls);
      const listAt = Math.min(t0, ls.oldest ?? t0);
      let changed = state.retain(new Set(listing.map((e) => String(e.id))));
      sync(listing.map((e) => String(e.id)));
      const known = listing.filter((e) => events.has(String(e.id)));
      const fresh = listing.filter((e) => !events.has(String(e.id)));
      const want = full ? listing : fresh;
      let detail: ObEvent[] = [];
      let detailAt = 0;
      let detailOk = true;
      if (want.length) {
        const t1 = Date.now();
        const ds: CallStats = { requests: 0, bytes: 0 };
        try {
          detail = await this.core.loadDetail(want.map((e) => e.id), ds, 15_000, true);
          detailAt = Math.min(t1, ds.oldest ?? t1);
        } catch (e) {
          detailOk = false;
          log.warn('push: detail failed', { err: (e as Error).message });
        }
      }
      const byId = new Map(detail.map((d) => [String(d.id), d]));
      // známé zápasy bez detailu: z listingu jen stav události a commentary (skóre, periody)
      const knownNoDetail = known.filter((e) => !byId.has(String(e.id)));
      if (knownNoDetail.length) state.install(knownNoDetail, listAt, true);
      // nové zápasy bez detailu: hlavní trhy z listingu, detail dotáhne resync
      const freshNoDetail = fresh.filter((e) => !byId.has(String(e.id)));
      if (freshNoDetail.length) {
        state.install(freshNoDetail, listAt);
        freshNoDetail.forEach((e) => dirty.add(String(e.id)));
      }
      if (detail.length) state.install(mergeListingAndDetail(want.filter((e) => byId.has(String(e.id))), detail), detailAt);
      changed ||= listing.length > 0;
      if (full && detailOk) {
        lastSnapAt = Date.now();
        state.ignored.clear(); // REST zná všechny trhy událostí → seznam nemapovaných lze zahodit
        // snapshot započatý při otevřeném websocketu uzavírá případnou mezeru v deltách
        if (wsOpenBefore && wsOpenBefore === openedAt && ws?.readyState === WebSocket.OPEN) {
          gap = false;
          needSnapshot = false;
        }
      }
      if (changed) scheduleEmit();
    };

    /** Detail "dirty" zápasů (neznámý trh/výběr/perioda v deltách). */
    const resyncDirty = async () => {
      const ids = [...dirty].filter((id) => events.has(id)).slice(0, 40);
      ids.forEach((id) => dirty.delete(id));
      if (!ids.length) return;
      const t0 = Date.now();
      const ds: CallStats = { requests: 0, bytes: 0 };
      let det: ObEvent[];
      try {
        det = await this.core.loadDetail(ids, ds, 15_000, true);
      } catch (e) {
        ids.forEach((id) => dirty.add(id));
        throw e;
      }
      state.install(
        det.filter((d) => events.has(String(d.id))),
        Math.min(t0, ds.oldest ?? t0),
      );
      scheduleEmit();
    };

    /** Jediná smyčka REST údržby (nikdy dva REST refreshe souběžně). */
    const maintain = async () => {
      if (busy || closed) return;
      busy = true;
      try {
        const now = Date.now();
        state.prune(now);
        // snapshot: po (znovu)připojení co nejdřív, jinak á snapEvery; neúspěšné pokusy nejvýš á 3 s
        const snapDue = needSnapshot || now - lastSnapAt >= snapEvery;
        if (snapDue && now - lastSnapTryAt >= 3_000) await refresh(true);
        else if (now - lastListAt >= listEvery) await refresh(false);
        else if (dirty.size && now - lastDirtyAt >= 2_000) {
          lastDirtyAt = now;
          await resyncDirty();
        }
      } catch (e) {
        log.warn('push maintenance failed', { err: (e as Error).message });
      } finally {
        busy = false;
      }
    };

    const connect = () => {
      if (closed) return;
      const sock = new WebSocket(WS_URL, 'v1.push.openbet.com', { headers: { Origin: ORIGIN, 'User-Agent': DEFAULT_UA } });
      ws = sock;
      sock.on('open', () => {
        log.info('websocket open');
        openedAt = Date.now();
        lastMsgAt = Date.now();
        subscribed.clear();
        sock.send(encodeConnect(''));
        sync([...events.keys()]);
        // delty z doby výpadku nemáme → plný snapshot (dokud neproběhne, neemitujeme)
        needSnapshot = true;
      });
      sock.on('message', (data) => {
        if (ws !== sock) return;
        const t = Date.now();
        lastMsgAt = t;
        const msg = decodeMessage(data.toString());
        if (!msg) return;
        if (state.onMessage(msg, t)) scheduleEmit();
      });
      sock.on('close', (code) => {
        if (ws !== sock) return;
        gap = true;
        if (closed) return;
        log.warn('websocket closed, reconnecting', { code });
        setTimeout(connect, 2000).unref();
      });
      sock.on('error', (err) => {
        if (closed || ws !== sock) return;
        log.warn('websocket error', { err: err.message });
        onError(new StrategyError(`sazka push websocket: ${err.message}`, 'http'));
      });
    };

    connect();
    // počkat na websocket (max 10 s), pak první snapshot; bez spojení aspoň REST (reconnect doběhne sám)
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 10_000);
      ws?.once('open', () => {
        clearTimeout(t);
        resolve();
      });
    });
    try {
      await refresh(true);
    } catch (e) {
      closed = true;
      ws?.close();
      throw e;
    }
    timers.push(
      setInterval(() => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (Date.now() - lastMsgAt > SILENCE_MS) {
          log.warn('websocket silent, reconnecting');
          gap = true;
          ws.terminate();
          return;
        }
        ws.send(encodePing(++pingId));
      }, 15_000),
    );
    timers.push(setInterval(() => void maintain(), 500));
    timers.forEach((t) => t.unref());

    return async () => {
      closed = true;
      timers.forEach((t) => clearInterval(t));
      if (emitTimer) clearTimeout(emitTimer);
      ws?.close();
    };
  }
}
