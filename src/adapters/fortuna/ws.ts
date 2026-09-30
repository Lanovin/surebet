// Fortuna – level 3: STOMP 1.2 přes SockJS websocket (wss://ws-offer.ifortuna.cz/stomp/{server}/{session}/websocket).
// Stav = REST snapshot (výpis live + výchozí overview + miniscoreboards) + push zprávy; periodický resync.
// Po snapshotu se přehrají WS zprávy z doby jeho stahování (jinak by snapshot přepsal novější stav),
// po výpadku spojení se nic neemituje, dokud nedoběhne nový snapshot, a fetchedAt = čas posledního
// rámce ze serveru (zprávy nebo heartbeatu á 10 s) – tichý (mrtvý) socket se po silenceMs zahodí.
// Plné sady trhů (AH, další linie OU, poločasy/třetiny…) pro až maxDetailSubs live zápasů: odběr
// market.{id} (jako stránka zápasu) + REST detail načtený až po přihlášení topicu (s přehráním zpráv).
import WebSocket from 'ws';
import type { HealthResult, RawOdds, Sport } from '../../core/types.js';
import { SPORTS_MAP } from './parse.js';

/** Sporty, které Fortuna adaptér umí (runner posílá všechny kanonické sporty). */
const SPORTS = Object.keys(SPORTS_MAP) as Sport[];
import type { AdapterContext, FetchRequest, Strategy } from '../types.js';
import { StrategyError } from '../types.js';
import { DEFAULT_UA } from '../http.js';
import { SITE, buildEvents } from './parse.js';
import { FortunaApi, HttpTransport, collectLive } from './strategies.js';
import { CLOCK_SPORTS, FortunaLiveStore, SPORT_IDS, TOPIC, type FtnWsMessage } from './live-store.js';

export const WS_BASE = 'wss://ws-offer.ifortuna.cz/stomp';

/** Hodnoty STOMP hlaviček: \c = ':', \n, \r, \\ */
export function unescapeHeader(v: string): string {
  return v.replace(/\\(.)/g, (_m, c: string) => (c === 'c' ? ':' : c === 'n' ? '\n' : c === 'r' ? '\r' : c));
}

export interface StompFrame {
  command: string;
  headers: Record<string, string>;
  body: string;
}

/** Rozloží SockJS zprávu („o“, „h“, „a[...]“, „c[...]“) na STOMP rámce. */
export function parseSockJs(msg: string): { open?: boolean; close?: boolean; frames: StompFrame[] } {
  if (msg === 'o') return { open: true, frames: [] };
  if (msg === 'h') return { frames: [] };
  if (msg.startsWith('c')) return { close: true, frames: [] };
  if (!msg.startsWith('a')) return { frames: [] };
  const frames: StompFrame[] = [];
  for (const chunk of JSON.parse(msg.slice(1)) as string[]) {
    for (const raw of chunk.split('\0')) {
      const s = raw.replace(/^[\r\n]+/, '');
      if (!s) continue; // STOMP heartbeat
      const sep = s.indexOf('\n\n');
      const head = sep >= 0 ? s.slice(0, sep) : s;
      const lines = head.split('\n');
      const headers: Record<string, string> = {};
      for (const l of lines.slice(1)) {
        const i = l.indexOf(':');
        if (i > 0 && !(l.slice(0, i) in headers)) headers[l.slice(0, i)] = unescapeHeader(l.slice(i + 1));
      }
      frames.push({ command: lines[0], headers, body: sep >= 0 ? s.slice(sep + 2) : '' });
    }
  }
  return { frames };
}

const stompFrame = (command: string, headers: Record<string, string>) =>
  JSON.stringify([`${command}\n${Object.entries(headers).map(([k, v]) => `${k}:${v}`).join('\n')}\n\n\0`]);

interface Options {
  resyncMs: number;
  emitThrottleMs: number;
  heartbeatEmitMs: number;
  idleCloseMs: number;
  maxClockSubs: number;
  /** Bez jediného rámce ze serveru (STOMP heartbeat chodí á 10 s) déle než tohle = mrtvé spojení. */
  silenceMs: number;
  /** Základ URL websocketu (testy podstrkují lokální server). */
  wsBase: string;
  /** Kolika live zápasům odebírat plnou sadu trhů (0 = jen overview). */
  maxDetailSubs: number;
  /** Jak často detail zápasu znovu načíst z REST (pojistka k push zprávám). */
  detailRefreshMs: number;
  /** Rozestup REST požadavků na detail. */
  detailGapMs: number;
}
const DEFAULTS: Options = {
  resyncMs: 30_000,
  emitThrottleMs: 300,
  heartbeatEmitMs: 5_000,
  idleCloseMs: 90_000,
  maxClockSubs: 80,
  silenceMs: 20_000,
  wsBase: WS_BASE,
  maxDetailSubs: 40,
  detailRefreshMs: 5 * 60_000,
  detailGapMs: 400,
};
/** O kolik dřív než start snapshotu přehrávat zprávy: výpis zápasů je z CDN (s-maxage=5) až ~5 s starý. */
export const SNAPSHOT_REPLAY_MARGIN_MS = 8_000;

export class FortunaWsStrategy implements Strategy {
  readonly name = 'websocket';
  readonly level = 3 as const;
  readonly supports = { prematch: false, live: true };
  private opts: Options;
  private store = new FortunaLiveStore();
  private ws?: WebSocket;
  private connected?: Promise<void>;
  private subs = new Map<string, string>(); // destination -> sub id
  private subSeq = 0;
  private listeners = new Set<{ sports: Sport[]; onData: (r: RawOdds) => void; onError: (e: Error) => void }>();
  private timers: NodeJS.Timeout[] = [];
  private emitTimer?: NodeJS.Timeout;
  private lastEmitVersion = -1;
  private lastEmitAt = 0;
  private lastUse = Date.now();
  private resyncing?: Promise<void>;
  private reconnectDelay = 1000;
  private stopped = true;
  /** STOMP session je navázaná (CONNECTED) – jen tehdy má smysl emitovat stav. */
  private online = false;
  /** Stav je po (re)connectu srovnaný REST snapshotem – do té doby může chybět cokoli z výpadku. */
  private synced = false;
  /** Čas posledního rámce ze serveru (zpráva i heartbeat) = do kdy je stav prokazatelně aktuální. */
  private lastFrameAt = 0;
  /** Začátek stahování posledního REST snapshotu (kurzy v něm jsou nejméně tak čerstvé). */
  private snapshotDataAt = 0;
  private api: FortunaApi;
  /** Statistika pro dokumentaci/logy. */
  readonly stats = { messages: 0, reconnects: 0, snapshots: 0, restRequests: 0, details: 0, silentDetails: 0 };
  /** Kdy byl detail zápasu naposledy načten z REST. */
  private detailLoadedAt = new Map<string, number>();
  private detailQueue: string[] = [];
  private detailWorker?: Promise<void>;

  constructor(
    private ctx: AdapterContext,
    opts: Partial<Options> = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
    this.api = new FortunaApi(new HttpTransport(ctx));
  }

  // ---------- připojení ----------

  private connect(): Promise<void> {
    if (this.connected) return this.connected;
    const server = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
    const session = Math.random().toString(36).slice(2, 10).padEnd(8, 'x');
    const url = `${this.opts.wsBase}/${server}/${session}/websocket`;
    this.synced = false;
    this.connected = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { origin: SITE, 'user-agent': DEFAULT_UA }, handshakeTimeout: 15_000 });
      this.ws = ws;
      let ok = false;
      const fail = (err: Error) => {
        if (!ok) reject(err);
        this.onDisconnect(err);
      };
      const timeout = setTimeout(() => fail(new StrategyError('websocket connect timeout', 'timeout')), 20_000);
      ws.on('message', (data) => {
        if (this.ws === ws) this.lastFrameAt = Date.now();
        let parsed: ReturnType<typeof parseSockJs>;
        try {
          parsed = parseSockJs(data.toString());
        } catch {
          return;
        }
        if (parsed.open) ws.send(stompFrame('CONNECT', { 'accept-version': '1.2', 'heart-beat': '10000,10000' }));
        if (parsed.close) fail(new StrategyError('sockjs closed by server', 'http'));
        for (const f of parsed.frames) {
          if (f.command === 'CONNECTED') {
            ok = true;
            this.online = true;
            clearTimeout(timeout);
            this.reconnectDelay = 1000;
            this.subs.clear();
            resolve();
          } else if (f.command === 'MESSAGE') this.onMessage(f);
          else if (f.command === 'ERROR') this.ctx.log.warn('fortuna ws STOMP error', { message: f.headers.message, body: f.body.slice(0, 200) });
        }
      });
      ws.on('error', (e) => fail(new StrategyError(`websocket error: ${e.message}`, 'http')));
      ws.on('unexpected-response', (_req, res) =>
        fail(new StrategyError(`websocket HTTP ${res.statusCode}`, res.statusCode === 403 ? 'blocked' : 'http', { status: res.statusCode })),
      );
      ws.on('close', () => fail(new StrategyError('websocket closed', 'http')));
    });
    this.connected.catch(() => {});
    return this.connected;
  }

  private onDisconnect(err: Error): void {
    this.online = false;
    this.synced = false;
    // zprávy market.{id} z výpadku chybí -> do nového načtení detailů platí jen overview
    this.store.dropDetail();
    this.detailLoadedAt.clear();
    this.detailQueue = [];
    if (!this.ws) return;
    const ws = this.ws;
    this.ws = undefined;
    this.connected = undefined;
    this.subs.clear();
    ws.removeAllListeners();
    ws.on('error', () => {});
    try {
      ws.terminate();
    } catch {
      /* už zavřeno */
    }
    if (this.stopped) return;
    this.stats.reconnects++;
    this.ctx.log.warn('fortuna ws disconnected', { error: err.message });
    for (const l of this.listeners) l.onError(err);
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(30_000, this.reconnectDelay * 2);
    const t = setTimeout(() => void this.bootstrap().catch(() => {}), delay);
    t.unref();
  }

  private send(frame: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(frame);
  }

  private subscribe_(dest: string): void {
    if (this.subs.has(dest)) return;
    const id = `sub-${++this.subSeq}`;
    this.subs.set(dest, id);
    this.send(stompFrame('SUBSCRIBE', { id, destination: dest }));
  }

  private unsubscribe_(dest: string): void {
    const id = this.subs.get(dest);
    if (!id) return;
    this.subs.delete(dest);
    this.send(stompFrame('UNSUBSCRIBE', { id }));
  }

  private onMessage(f: StompFrame): void {
    this.stats.messages++;
    let body: FtnWsMessage;
    try {
      body = JSON.parse(f.body) as FtnWsMessage;
    } catch {
      return;
    }
    const dest = f.headers.destination ?? '';
    const beforeFixtures = dest === TOPIC.fixtures ? this.store.liveFixtureIds([...SPORTS]).length : 0;
    if (this.store.apply(dest, body)) {
      if (dest === TOPIC.fixtures && this.store.liveFixtureIds([...SPORTS]).length !== beforeFixtures) {
        this.syncClockSubs();
        this.syncDetailSubs();
      }
      this.scheduleEmit();
    }
  }

  /** Odběr plných sad trhů (market.{id}) pro live zápasy; nové/zastaralé detaily do fronty REST. */
  private syncDetailSubs(): void {
    const prefix = TOPIC.detail('');
    const wanted = new Set(this.opts.maxDetailSubs > 0 ? this.store.detailCandidates([...SPORTS]).slice(0, this.opts.maxDetailSubs) : []);
    for (const d of [...this.subs.keys()]) {
      if (!d.startsWith(prefix) || wanted.has(d.slice(prefix.length))) continue;
      this.unsubscribe_(d);
      this.store.dropDetail(d.slice(prefix.length));
      this.detailLoadedAt.delete(d.slice(prefix.length));
    }
    const now = Date.now();
    for (const id of wanted) {
      // topic přihlásit před stažením detailu – zprávy z doby stahování se pak přehrají
      this.subscribe_(TOPIC.detail(id));
      if (!this.store.hasDetail(id) || now - (this.detailLoadedAt.get(id) ?? 0) > this.opts.detailRefreshMs) this.enqueueDetail(id);
    }
  }

  private enqueueDetail(id: string): void {
    if (!this.detailQueue.includes(id)) this.detailQueue.push(id);
    if (!this.detailWorker) this.detailWorker = this.runDetailQueue().finally(() => (this.detailWorker = undefined));
  }

  private async runDetailQueue(): Promise<void> {
    while (this.detailQueue.length && !this.stopped && this.ws) {
      const id = this.detailQueue.shift()!;
      const dest = TOPIC.detail(id);
      if (!this.subs.has(dest)) continue;
      const ws = this.ws;
      const startedAt = Date.now();
      try {
        const markets = await this.api.fixtureMarkets(id);
        this.stats.restRequests++;
        // spojení mezitím spadlo / odběr zrušen -> zprávy mohou chybět, detail nepoužít
        if (ws === this.ws && this.online && this.subs.has(dest) && Array.isArray(markets)) {
          this.store.loadDetail(id, markets, Date.now(), startedAt - 1_000);
          this.detailLoadedAt.set(id, Date.now());
          this.stats.details++;
          this.scheduleEmit();
        }
      } catch (e) {
        this.ctx.log.debug('fortuna ws detail failed', { id, error: (e as Error).message });
      }
      await new Promise((r) => setTimeout(r, this.opts.detailGapMs));
    }
  }

  /** Plné scoreboardy (hodiny) pro live fotbal/hokej/basket. */
  private syncClockSubs(): void {
    const wanted = new Set(
      this.store
        .liveFixtureIds(CLOCK_SPORTS)
        .slice(0, this.opts.maxClockSubs)
        .map((id) => TOPIC.scoreboard(id)),
    );
    for (const d of [...this.subs.keys()]) if (d.startsWith('/topic/offer/v2/cs/scoreboard.') && !wanted.has(d)) this.unsubscribe_(d);
    for (const d of wanted) this.subscribe_(d);
  }

  /** Připojí WS, přihlásí topicy a stáhne REST snapshot. */
  private async bootstrap(): Promise<void> {
    if (this.stopped) return;
    await this.connect();
    this.subscribe_(TOPIC.fixtures);
    this.subscribe_(TOPIC.tournaments);
    this.subscribe_(TOPIC.miniscoreboard);
    for (const s of SPORTS) this.subscribe_(TOPIC.markets(SPORT_IDS[s]));
    await this.resync();
  }

  private async resync(): Promise<void> {
    if (this.resyncing) return this.resyncing;
    this.resyncing = (async () => {
      const before = this.api.requests;
      const startedAt = Date.now();
      const ws = this.ws;
      // výchozí (netypované) overview = přesně ta sada trhů, kterou web zobrazuje a WS aktualizuje
      const { bundle } = await collectLive(this.api, [...SPORTS], null, 0, false);
      this.stats.restRequests += this.api.requests - before;
      this.stats.snapshots++;
      // zprávy z doby stahování (a z doby, kterou pokrývá CDN cache výpisu) se po snapshotu přehrají
      this.store.loadSnapshot(bundle, Date.now(), startedAt - SNAPSHOT_REPLAY_MARGIN_MS);
      this.snapshotDataAt = bundle.dataAt ?? startedAt;
      // srovnáno jen tehdy, když spojení během stahování nespadlo (jinak chybí zprávy z výpadku)
      if (ws && ws === this.ws && this.online) this.synced = true;
      this.syncClockSubs();
      this.syncDetailSubs();
      this.scheduleEmit();
    })().finally(() => {
      this.resyncing = undefined;
    });
    return this.resyncing;
  }

  private async ensureRunning(): Promise<void> {
    this.lastUse = Date.now();
    if (this.stopped) {
      this.stopped = false;
      const every = (ms: number, fn: () => void) => {
        const t = setInterval(fn, ms);
        t.unref();
        this.timers.push(t);
      };
      every(this.opts.resyncMs, () => {
        if (this.ws) void this.resync().catch((e) => this.ctx.log.warn('fortuna ws resync failed', { error: String(e?.message ?? e) }));
      });
      every(10_000, () => {
        this.send(JSON.stringify(['\n'])); // STOMP heartbeat klienta
        if (!this.listeners.size && Date.now() - this.lastUse > this.opts.idleCloseMs) void this.stop();
      });
      every(Math.min(5_000, this.opts.silenceMs / 2), () => {
        // polootevřené TCP spojení nepošle close – bez rámců (ani heartbeatu) je stav neověřitelný
        if (this.ws && this.online && Date.now() - this.lastFrameAt > this.opts.silenceMs)
          this.onDisconnect(new StrategyError(`websocket silent for ${Date.now() - this.lastFrameAt} ms`, 'timeout'));
      });
      every(1000, () => {
        // detail, jehož market.{id} nedoručil změnu, kterou overview už má -> zpět na overview + nové načtení
        const silent = this.store.dropSilentDetails();
        if (silent.length) {
          this.stats.silentDetails += silent.length;
          for (const id of silent) {
            this.detailLoadedAt.delete(id);
            this.enqueueDetail(id);
          }
          this.scheduleEmit();
        }
        if (this.listeners.size && this.online && this.synced && Date.now() - this.lastEmitAt >= this.opts.heartbeatEmitMs) this.emit(true);
      });
    }
    if (!this.store.warm || !this.ws) await this.bootstrap();
    else if (this.connected) await this.connected;
  }

  private snapshot(sports: Sport[]): RawOdds {
    const now = Date.now();
    const events = buildEvents(this.store.bundle(now), sports);
    // push: stav platí k poslednímu rámci ze serveru (ne k okamžiku emitu – mezi rámci nic neověřujeme)
    const fetchedAt = Math.min(now, Math.max(this.lastFrameAt, this.snapshotDataAt)) || now;
    return { bookmaker: 'fortuna', strategy: this.name, scope: 'live', fetchedAt, events };
  }

  private scheduleEmit(): void {
    if (!this.listeners.size || this.emitTimer) return;
    const wait = Math.max(0, this.opts.emitThrottleMs - (Date.now() - this.lastEmitAt));
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined;
      this.emit(false);
    }, wait);
    this.emitTimer.unref();
  }

  private emit(force: boolean): void {
    if (!this.online || !this.synced || !this.store.warm) return;
    if (!force && this.store.version === this.lastEmitVersion) return;
    this.lastEmitVersion = this.store.version;
    this.lastEmitAt = Date.now();
    for (const l of this.listeners) {
      try {
        l.onData(this.snapshot(l.sports));
      } catch (e) {
        l.onError(e as Error);
      }
    }
  }

  // ---------- Strategy ----------

  async fetch(req: FetchRequest): Promise<RawOdds> {
    if (req.scope !== 'live') throw new StrategyError('websocket strategy is live-only', 'other');
    await this.ensureRunning();
    if (!this.synced) await this.resync();
    if (!this.synced) throw new StrategyError('websocket state not synced after reconnect', 'other');
    return this.snapshot(req.sports);
  }

  async subscribe(req: FetchRequest, onData: (raw: RawOdds) => void, onError: (err: Error) => void): Promise<() => Promise<void>> {
    if (req.scope !== 'live') throw new StrategyError('websocket strategy is live-only', 'other');
    const l = { sports: req.sports.filter((s) => SPORTS.includes(s)), onData, onError };
    this.listeners.add(l);
    try {
      await this.ensureRunning();
    } catch (e) {
      this.listeners.delete(l);
      throw e;
    }
    this.emit(true);
    return async () => {
      this.listeners.delete(l);
      this.lastUse = Date.now();
    };
  }

  async healthCheck(): Promise<HealthResult> {
    const t0 = performance.now();
    try {
      await this.connect();
      return { ok: true, latencyMs: Math.round(performance.now() - t0), message: `messages=${this.stats.messages}` };
    } catch (e) {
      return { ok: false, latencyMs: Math.round(performance.now() - t0), message: (e as Error).message };
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.online = false;
    this.synced = false;
    this.detailQueue = [];
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    clearTimeout(this.emitTimer);
    this.emitTimer = undefined;
    const ws = this.ws;
    this.ws = undefined;
    this.connected = undefined;
    this.subs.clear();
    if (ws) {
      ws.removeAllListeners();
      ws.on('error', () => {});
      ws.close();
    }
  }

  async dispose(): Promise<void> {
    this.listeners.clear();
    await this.stop();
  }
}

