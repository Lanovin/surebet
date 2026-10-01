// Level-5 strategie nad camoufox-bridge (Python sidecar, viz camoufox-bridge/README.md):
//
//  1) discover – otevře stránky sázkovky v Camoufoxu, zachytí JSON odpovědi, které si web sám stahuje,
//     a zapamatuje si ty požadavky (metoda, URL, tělo, x-* hlavičky), ze kterých parser vytáhl události.
//  2) replay  – každý další poll jen zopakuje zapamatované požadavky přes fetch() uvnitř stránky
//     (jeden až pár požadavků, žádná navigace). Při 403 / prázdné odpovědi se cíle zahodí a příště
//     se znovu objevují; repair() navíc zavře stránku sázkovky (nový context = čisté cookies).
//
// Díky tomu není potřeba znát přesné interní endpointy předem – stačí URL stránek a parser.
import type { BookmakerId, FeedScope, HealthResult, RawEvent, RawOdds, Sport } from '../../core/types.js';
import { camoufox, type BridgeResponse, type CamoufoxBridge } from '../camoufox.js';
import { StrategyError, type AdapterContext, type FetchRequest, type Strategy, type StrategyLevel } from '../types.js';

export interface ParseContext {
  scope: FeedScope;
  /** Sport stránky, ze které odpověď pochází (fallback, když ho JSON neuvádí). */
  sport?: Sport;
  origin: string;
}

export interface DiscoveryPage {
  url: string;
  sport?: Sport;
}

export interface CamoufoxReplayConfig {
  bookmaker: BookmakerId;
  origin: string;
  pages: Record<FeedScope, DiscoveryPage[]>;
  /** Které síťové odpovědi zkoumat (regex nad URL). */
  match: RegExp;
  parse: (json: unknown, ctx: ParseContext) => RawEvent[];
  /** Pozná blokační odpověď (WAF stránka apod.). */
  isBlocked?: (status: number, body: string) => boolean;
  /** Max. počet replay požadavků na jeden poll. */
  maxTargets?: number;
}

interface ReplayTarget {
  method: string;
  url: string;
  body?: string;
  headers: Record<string, string>;
  sport?: Sport;
}

/** Projde libovolný JSON a zavolá `visit` na každý objekt (ne pole). */
export function walkObjects(root: unknown, visit: (o: Record<string, unknown>) => void, maxDepth = 40): void {
  const stack: [unknown, number][] = [[root, 0]];
  while (stack.length) {
    const [v, d] = stack.pop()!;
    if (!v || typeof v !== 'object' || d > maxDepth) continue;
    // děti na zásobník pozpátku → návštěva v pořadí dokumentu
    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) stack.push([v[i], d + 1]);
      continue;
    }
    visit(v as Record<string, unknown>);
    const kids = Object.values(v);
    for (let i = kids.length - 1; i >= 0; i--) if (kids[i] && typeof kids[i] === 'object') stack.push([kids[i], d + 1]);
  }
}

/** Sloučí události se stejným sourceId (různé odpovědi můžou nést různé trhy). */
export function mergeEvents(events: RawEvent[]): RawEvent[] {
  const byId = new Map<string, RawEvent>();
  for (const e of events) {
    const prev = byId.get(e.sourceId);
    if (!prev) {
      byId.set(e.sourceId, { ...e, markets: [...e.markets] });
      continue;
    }
    const keys = new Set(prev.markets.map((m) => m.key));
    for (const m of e.markets) if (!keys.has(m.key)) prev.markets.push(m);
    prev.live ||= e.live;
    prev.state ??= e.state;
  }
  return [...byId.values()].filter((e) => e.markets.length > 0);
}

const LIVE_EMPTY_COOLDOWN_MS = 60_000;

export class CamoufoxReplayStrategy implements Strategy {
  readonly name = 'camoufox';
  readonly level: StrategyLevel = 5;
  readonly supports = { prematch: true, live: true };
  readonly minIntervalMs = { prematch: 60_000, live: 3_000 };

  private targets = new Map<FeedScope, ReplayTarget[]>();
  private emptyLiveUntil = 0;

  constructor(
    private readonly cfg: CamoufoxReplayConfig,
    private readonly ctx: AdapterContext,
    private readonly bridge: CamoufoxBridge = camoufox,
  ) {}

  async fetch(req: FetchRequest): Promise<RawOdds> {
    const scope = req.scope;
    let events: RawEvent[];
    const known = this.targets.get(scope);
    if (known?.length) {
      events = await this.replay(scope, known);
    } else if (scope === 'live' && Date.now() < this.emptyLiveUntil) {
      events = [];
    } else {
      events = await this.discover(scope);
    }
    return {
      bookmaker: this.cfg.bookmaker,
      strategy: this.name,
      scope,
      fetchedAt: Date.now(),
      events: events.filter((e) => req.sports.includes(e.sport)),
    };
  }

  private parse(json: unknown, scope: FeedScope, sport?: Sport): RawEvent[] {
    return this.cfg.parse(json, { scope, sport, origin: this.cfg.origin });
  }

  private blocked(status: number, body: string): boolean {
    return status === 403 || status === 429 || (this.cfg.isBlocked?.(status, body) ?? false);
  }

  private async discover(scope: FeedScope): Promise<RawEvent[]> {
    const bk = this.cfg.bookmaker;
    const found: ReplayTarget[] = [];
    const events: RawEvent[] = [];
    const seen: { url: string; status: number }[] = [];
    let sample: BridgeResponse | undefined;

    for (const page of this.cfg.pages[scope]) {
      const res = await this.bridge.capture(bk, {
        url: page.url,
        match: this.cfg.match,
        reload: true,
        minResponses: 3,
        timeoutMs: 30_000,
        settleMs: 4_000,
      });
      if (res.blocked) {
        throw new StrategyError(`${bk}: blokační stránka při načtení ${page.url} („${res.title}“)`, 'blocked', {
          navStatus: res.navStatus,
          title: res.title,
        });
      }
      for (const r of res.responses) {
        seen.push({ url: r.url, status: r.status });
        if (r.status !== 200 || r.json === undefined) continue;
        sample ??= r;
        const ev = this.parse(r.json, scope, page.sport);
        if (!ev.length) continue;
        events.push(...ev);
        const t: ReplayTarget = {
          method: r.method ?? 'GET',
          url: r.url,
          body: r.postData ?? undefined,
          headers: r.requestHeaders ?? {},
          sport: page.sport,
        };
        if (!found.some((x) => x.method === t.method && x.url === t.url && x.body === t.body)) found.push(t);
      }
    }

    const merged = mergeEvents(events);
    if (!merged.length) {
      if (scope === 'live' && seen.some((s) => s.status === 200)) {
        // web odpovídá, jen teď nic neběží (nebo parser nic nepoznal) – nezkoušet navigaci každý poll
        this.emptyLiveUntil = Date.now() + LIVE_EMPTY_COOLDOWN_MS;
        return [];
      }
      const blockedN = seen.filter((s) => s.status === 403).length;
      throw new StrategyError(
        `${bk}: z ${seen.length} zachycených odpovědí parser nevytáhl žádnou událost (403: ${blockedN})`,
        blockedN ? 'blocked' : 'structure',
        { seen: seen.slice(0, 40), sample: sample ? { url: sample.url, body: sample.body.slice(0, 20_000) } : undefined },
      );
    }
    this.targets.set(scope, found.slice(0, this.cfg.maxTargets ?? 8));
    this.ctx.log.info(`${bk}/${scope}: discovered ${found.length} endpoint(s), ${merged.length} events`, {
      endpoints: found.map((t) => `${t.method} ${t.url}`).slice(0, 8),
    });
    return merged;
  }

  private async replay(scope: FeedScope, targets: ReplayTarget[]): Promise<RawEvent[]> {
    const bk = this.cfg.bookmaker;
    const events: RawEvent[] = [];
    for (const t of targets) {
      const r = await this.bridge.fetchInPage(bk, this.cfg.origin, t.url, {
        method: t.method,
        headers: t.headers,
        body: t.method === 'GET' ? undefined : t.body,
      });
      if (this.blocked(r.status, r.body)) {
        this.targets.delete(scope);
        throw new StrategyError(`${bk}: replay ${t.method} ${t.url} → ${r.status}`, 'blocked', { status: r.status });
      }
      if (r.status !== 200) {
        this.targets.delete(scope);
        throw new StrategyError(`${bk}: replay ${t.method} ${t.url} → HTTP ${r.status}`, 'http', { status: r.status });
      }
      let json: unknown;
      try {
        json = JSON.parse(r.body);
      } catch {
        this.targets.delete(scope);
        throw new StrategyError(`${bk}: replay ${t.url} nevrátil JSON`, 'structure', { sample: r.body.slice(0, 2_000) });
      }
      events.push(...this.parse(json, scope, t.sport));
    }
    const merged = mergeEvents(events);
    if (!merged.length) {
      // endpoint se mohl změnit (nebo v live nic neběží) – příště znovu discover
      this.targets.delete(scope);
      if (scope === 'prematch') throw new StrategyError(`${bk}: replay nevrátil žádné prematch události`, 'empty');
    }
    return merged;
  }

  async healthCheck(): Promise<HealthResult> {
    const t0 = performance.now();
    try {
      const h = await this.bridge.health();
      return { ok: true, latencyMs: Math.round(performance.now() - t0), message: `bridge ok, browser ${h.running ? 'running' : 'idle'}` };
    } catch (e) {
      return { ok: false, latencyMs: Math.round(performance.now() - t0), message: (e as Error).message };
    }
  }

  async repair(): Promise<boolean> {
    this.targets.clear();
    this.emptyLiveUntil = 0;
    // jen stránka této sázkovky (= vlastní context, čisté cookies); prohlížeč sdílí i druhá sázkovka
    await this.bridge.close(this.cfg.bookmaker).catch(() => {});
    return true;
  }

  async dispose(): Promise<void> {
    await this.bridge.close(this.cfg.bookmaker).catch(() => {});
  }
}