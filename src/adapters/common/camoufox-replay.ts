// Level-5 strategie nad camoufox-bridge (Python sidecar, viz camoufox-bridge/README.md):
//
//  1) discover – otevře stránky sázkovky v Camoufoxu, zachytí JSON odpovědi, které si web sám stahuje,
//     a zapamatuje si ty požadavky (metoda, URL, tělo, x-* hlavičky), ze kterých parser vytáhl události.
//  2) replay  – každý další poll jen zopakuje zapamatované požadavky přes fetch() uvnitř stránky
//     (jeden až pár požadavků, žádná navigace). Při 403 / prázdné odpovědi se cíle zahodí a příště
//     se znovu objevují; repair() navíc zavře stránku sázkovky (nový context = čisté cookies).
//
// Díky tomu není potřeba znát přesné interní endpointy předem – stačí URL stránek a parser.
// Když endpointy známe (Betano kalendář po sportech, Tipsport /rest/offer po superSportech), adaptér
// dodá `targets` a discovery přes navigaci se přeskočí: replay jde rovnou (stačí otevřený origin).
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

export interface TargetRequest {
  url: string;
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

/** Známý endpoint pro replay. S `parts` se stáhnou všechny části a parser dostane { [name]: json }. */
export interface KnownTarget extends TargetRequest {
  sport?: Sport;
  parts?: (TargetRequest & { name: string })[];
}

export interface CamoufoxReplayConfig {
  bookmaker: BookmakerId;
  origin: string;
  /** Stránky pro discovery (když adaptér nedodá `targets`). */
  pages?: Partial<Record<FeedScope, DiscoveryPage[]>>;
  /**
   * Známé endpointy místo discovery. `getJson` = GET uvnitř stránky (např. seznam sportů, ze kterého
   * se cíle sestaví). Výsledek se drží do první chyby, pak se sestaví znovu.
   */
  targets?: (scope: FeedScope, getJson: (url: string) => Promise<unknown>) => Promise<KnownTarget[]> | KnownTarget[];
  /** Které síťové odpovědi zkoumat (regex nad URL). */
  match: RegExp;
  parse: (json: unknown, ctx: ParseContext) => RawEvent[];
  /** Pozná blokační odpověď (WAF stránka apod.). */
  isBlocked?: (status: number, body: string) => boolean;
  /** Max. počet replay požadavků na jeden poll (jen discovery; `targets` se neořezávají). */
  maxTargets?: number;
  /** Lehký dokument originu, na který stránka přejde po prvním načtení (šetří RAM, viz BridgeFetchInit). */
  idlePath?: string;
}

interface ReplayTarget {
  method: string;
  url: string;
  body?: string;
  headers: Record<string, string>;
  sport?: Sport;
  parts?: { name: string; method: string; url: string; body?: string; headers: Record<string, string> }[];
}

interface TargetFailure {
  error: string;
  kind: 'http' | 'structure';
  sample?: string;
}

function toReplayTarget(t: KnownTarget): ReplayTarget {
  const req = (r: TargetRequest) => ({ method: r.method ?? 'GET', url: r.url, body: r.body, headers: r.headers ?? {} });
  return { ...req(t), sport: t.sport, parts: t.parts?.map((p) => ({ name: p.name, ...req(p) })) };
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
    const known = this.targets.get(scope) ?? (this.cfg.targets ? await this.resolveTargets(scope) : undefined);
    if (known?.length) {
      events = await this.replay(scope, known);
    } else if (this.cfg.targets) {
      events = [];
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

    for (const page of this.cfg.pages?.[scope] ?? []) {
      const res = await this.bridge.capture(bk, {
        url: page.url,
        match: this.cfg.match,
        reload: true,
        minResponses: 3,
        timeoutMs: 30_000,
        // XHR s událostmi (např. Betano .../trending/leagues/<id>/events) přijde i 5–10 s po domcontentloaded
        settleMs: 10_000,
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

  private async resolveTargets(scope: FeedScope): Promise<ReplayTarget[]> {
    const getJson = async (url: string): Promise<unknown> => {
      const r = await this.request({ method: 'GET', url, headers: { accept: 'application/json' } });
      if (r.status !== 200) throw new StrategyError(`${this.cfg.bookmaker}: ${url} → HTTP ${r.status}`, 'http', { status: r.status });
      return r.json;
    };
    const targets = (await this.cfg.targets!(scope, getJson)).map(toReplayTarget);
    if (targets.length) this.targets.set(scope, targets);
    return targets;
  }

  /** Jeden požadavek uvnitř stránky; blokace → výjimka 'blocked', jinak status + JSON (undefined = není JSON). */
  private async request(t: { method: string; url: string; body?: string; headers: Record<string, string> }): Promise<{ status: number; json?: unknown; body: string }> {
    const r = await this.bridge.fetchInPage(this.cfg.bookmaker, this.cfg.origin, t.url, {
      method: t.method,
      headers: t.headers,
      body: t.method === 'GET' ? undefined : t.body,
      idlePath: this.cfg.idlePath,
    });
    if (this.blocked(r.status, r.body)) {
      throw new StrategyError(`${this.cfg.bookmaker}: replay ${t.method} ${t.url} → ${r.status}`, 'blocked', { status: r.status });
    }
    let json: unknown;
    if (r.status === 200) {
      try {
        json = JSON.parse(r.body);
      } catch {
        json = undefined;
      }
    }
    return { status: r.status, json, body: r.body };
  }

  /** Stáhne cíl (a jeho části); vrátí JSON pro parser, nebo popis chyby. */
  private async fetchTarget(t: ReplayTarget): Promise<{ json: unknown } | TargetFailure> {
    const reqs = t.parts ?? [{ name: '', ...t }];
    const out: Record<string, unknown> = {};
    for (const p of reqs) {
      const r = await this.request(p);
      if (r.status !== 200) return { error: `${p.method} ${p.url} → HTTP ${r.status}`, kind: 'http' };
      if (r.json === undefined) return { error: `${p.url} nevrátil JSON`, kind: 'structure', sample: r.body.slice(0, 2_000) };
      if (!t.parts) return { json: r.json };
      out[p.name] = r.json;
    }
    return { json: out };
  }

  private async replay(scope: FeedScope, targets: ReplayTarget[]): Promise<RawEvent[]> {
    const bk = this.cfg.bookmaker;
    const events: RawEvent[] = [];
    const failures: TargetFailure[] = [];
    for (const t of targets) {
      let res: { json: unknown } | TargetFailure;
      try {
        res = await this.fetchTarget(t);
      } catch (e) {
        this.targets.delete(scope);
        throw e;
      }
      if ('error' in res) failures.push(res);
      else events.push(...this.parse(res.json, scope, t.sport));
    }
    if (failures.length) {
      // jeden rozbitý cíl nemá shodit ostatní sporty; příště se cíle sestaví / objeví znovu
      this.targets.delete(scope);
      this.ctx.log.warn(`${bk}/${scope}: ${failures.length}/${targets.length} replay target(s) failed`, { errors: failures.map((f) => f.error).slice(0, 5) });
      if (failures.length === targets.length) {
        const f = failures[0];
        throw new StrategyError(`${bk}: replay ${f.error}`, f.kind, f.sample ? { sample: f.sample } : undefined);
      }
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