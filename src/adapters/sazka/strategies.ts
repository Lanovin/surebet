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
}

const DEFAULTS: Required<SazkaOptions> = {
  detailHorizonHours: 24,
  maxDetailEvents: 160,
  detailBatch: 40,
  liveDetail: true,
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
      const listing = (await getEvents(t, listingUrl(sports, 'live'), 15_000, stats)).filter((e) => e.liveNow);
      if (!this.o.liveDetail || !listing.length) return listing;
      try {
        const detail = await this.loadDetail(listing.map((e) => e.id), stats, 15_000, true);
        return mergeListingAndDetail(listing, detail);
      } catch (err) {
        this.ctx.log.warn('live detail failed, using listing only', { err: (err as Error).message });
        return listing;
      }
    }
    // prematch: jeden listing na sport (fotbal ~150 kB gzip, 2–6 s)
    const lists = await Promise.all(sports.map((s) => getEvents(t, listingUrl([s], 'prematch'), 45_000, stats)));
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
      const detail = await this.loadDetail(pick, stats, 30_000);
      return mergeListingAndDetail(listing, detail);
    } catch (err) {
      this.ctx.log.warn('prematch detail failed, using listing only', { err: (err as Error).message });
      return listing;
    }
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
    // fetchedAt = stáří dat podle X-Created-At (prematch listing bývá z cache Akamai až ~60 s)
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

/**
 * Live přes OpenBet push: REST snapshot (listing + detail) → websocket delty (ceny, stavy trhů,
 * hodiny). Neznámé objekty (nový trh, nová perioda, skóre) → REST detail jen dotčených událostí.
 * Nové/skončené zápasy: listing každých `listIntervalMs`, plný resync každých `resyncMs`.
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
    const events = new Map<string, ObEvent>();
    const subscribed = new Set<string>();
    const dirty = new Set<string>();
    let ws: WebSocket | undefined;
    let closed = false;
    let pingId = 0;
    let emitTimer: NodeJS.Timeout | undefined;
    let lastEmit = 0;
    const throttle = this.opts.emitThrottleMs ?? 250;
    const timers: NodeJS.Timeout[] = [];
    let busy = false;

    const emit = () => {
      emitTimer = undefined;
      lastEmit = Date.now();
      const fetchedAt = Date.now();
      try {
        onData({
          bookmaker: 'sazka',
          strategy: this.name,
          scope: 'live',
          fetchedAt,
          events: parseEvents([...events.values()], { scope: 'live', now: fetchedAt, sports: req.sports }),
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
      const add = ids.filter((id) => !subscribed.has(id));
      const del = [...subscribed].filter((id) => !ids.includes(id));
      for (const part of chunk(add, 50)) ws.send(encodeSubscribe(part));
      for (const part of chunk(del, 50)) ws.send(encodeUnsubscribe(part));
      add.forEach((id) => subscribed.add(id));
      del.forEach((id) => subscribed.delete(id));
    };

    /** Plný snapshot přes REST (listing + detail). */
    const snapshot = async () => {
      const stats: CallStats = { requests: 0, bytes: 0 };
      const raw = await this.core.loadRaw('live', req.sports, stats);
      events.clear();
      for (const e of raw) events.set(String(e.id), e);
      dirty.clear();
      sync([...events.keys()]);
      scheduleEmit();
    };

    /** Listing: nové / skončené zápasy; nové dotáhne detailem. */
    const relist = async () => {
      const stats: CallStats = { requests: 0, bytes: 0 };
      const listing = (await getEvents(httpTransport(this.ctx), listingUrl(req.sports, 'live'), 15_000, stats)).filter((e) => e.liveNow);
      const ids = new Set(listing.map((e) => String(e.id)));
      let changed = false;
      for (const id of [...events.keys()]) {
        if (ids.has(id)) continue;
        events.delete(id);
        changed = true;
      }
      const fresh = listing.filter((e) => !events.has(String(e.id)));
      if (fresh.length) {
        const det = await this.core.loadDetail(fresh.map((e) => e.id), stats, 15_000, true).catch(() => []);
        for (const e of mergeListingAndDetail(fresh, det)) events.set(String(e.id), e);
        changed = true;
      }
      // listing nese aktuální commentary (skóre/periody) i pro známé zápasy
      for (const e of listing) {
        const cur = events.get(String(e.id));
        if (cur && e.commentary) cur.commentary = e.commentary;
      }
      sync([...events.keys()]);
      if (changed || listing.length) scheduleEmit();
    };

    const resyncDirty = async () => {
      if (!dirty.size) return;
      const ids = [...dirty].filter((id) => events.has(id)).slice(0, 40);
      ids.forEach((id) => dirty.delete(id));
      if (!ids.length) return;
      const det = await this.core.loadDetail(ids, { requests: 0, bytes: 0 }, 15_000, true);
      for (const d of det) {
        const cur = events.get(String(d.id));
        if (cur) events.set(String(d.id), mergeListingAndDetail([cur], [d])[0]);
      }
      scheduleEmit();
    };

    const guarded = (fn: () => Promise<void>) => async () => {
      if (busy || closed) return;
      busy = true;
      try {
        await fn();
      } catch (e) {
        log.warn('push maintenance failed', { err: (e as Error).message });
      } finally {
        busy = false;
      }
    };

    const connect = () => {
      if (closed) return;
      ws = new WebSocket(WS_URL, 'v1.push.openbet.com', { headers: { Origin: ORIGIN, 'User-Agent': DEFAULT_UA } });
      ws.on('open', () => {
        log.info('websocket open');
        subscribed.clear();
        ws!.send(encodeConnect(''));
        sync([...events.keys()]);
      });
      ws.on('message', (data) => {
        const s = data.toString();
        const msg = decodeMessage(s);
        if (!msg) return;
        const r = applyMessage(events, msg);
        if (r.resync) dirty.add(r.resync);
        if (r.changed) scheduleEmit();
      });
      ws.on('close', (code) => {
        if (closed) return;
        log.warn('websocket closed, reconnecting', { code });
        setTimeout(connect, 2000).unref();
      });
      ws.on('error', (err) => {
        log.warn('websocket error', { err: err.message });
        onError(new StrategyError(`sazka push websocket: ${err.message}`, 'http'));
      });
    };

    await snapshot();
    connect();
    timers.push(setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send(encodePing(++pingId)), 15_000));
    timers.push(setInterval(guarded(relist), this.opts.listIntervalMs ?? 10_000));
    timers.push(setInterval(guarded(resyncDirty), 2_000));
    timers.push(setInterval(guarded(snapshot), this.opts.resyncMs ?? 60_000));
    timers.forEach((t) => t.unref());

    return async () => {
      closed = true;
      timers.forEach((t) => clearInterval(t));
      if (emitTimer) clearTimeout(emitTimer);
      ws?.close();
    };
  }
}
