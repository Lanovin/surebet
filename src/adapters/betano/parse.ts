// Betano (Kaizen „danae“) – čisté funkce: zachycený JSON → RawEvent[].
// Dva tvary (ověřeno na živých odpovědích 2026-10-01, fixtures/betano/):
//  * vnořený – /api/sports/upcoming/calendar/<SPORT>/ (data.blocks[].events[]), ligové stránky:
//    událost nese markets[] (nebo sixPackBlocks[].columns[] u basketu) se selections[] uvnitř
//  * normalizovaný – /danae-webapi/api/live/overview/latest, /api/home/top-events-v2/:
//    events / markets / selections jako mapy id → objekt, propojené přes marketIdList / selectionIdList
// Trhy se mapují podle kódu typu (MRES, DBLC, HTOH …) a sportu, ne podle názvu. Kódy, u kterých Betano
// neuvádí, jestli jsou vč. prodloužení (basket FHOT/FTPO, hokej AHOT, házená FAHC), se vynechávají.
import type { GameState, MarketScope, MarketType, RawEvent, RawMarket, RawSelection, SelectionKey, Sport } from '../../core/types.js';
import { marketKey } from '../../core/markets.js';
import { walkObjects, type ParseContext } from '../common/camoufox-replay.js';
import { labelToKey, str, toEpochMs, toOdds, VIRTUAL_RX } from '../common/main-markets.js';

/** Kódy sportů Kaizen (kb-config: supportedSportIds). */
export const SPORT_CODES: Record<string, Sport> = {
  FOOT: 'football',
  TENN: 'tennis',
  ICEH: 'hockey',
  BASK: 'basketball',
  HAND: 'handball',
  VOLL: 'volleyball',
  BASE: 'baseball',
  AMFO: 'american_football',
  MMAF: 'mma',
  BOXI: 'boxing',
  DART: 'darts',
  SNOO: 'snooker',
  TABL: 'table_tennis',
};

type Kind = 'RESULT' | 'DC' | 'TWO_WAY' | 'OU' | 'AH' | 'BTTS';
interface MarketDef {
  type: MarketType;
  scope: MarketScope;
  kind: Kind;
}

const WINNER_SPORTS: readonly Sport[] = ['tennis', 'table_tennis', 'darts', 'snooker', 'volleyball', 'basketball', 'baseball'];

/**
 * Kód trhu → kanonický trh pro daný sport (null = vynechat).
 *  - MRES „Výsledek zápasu“ / „Výsledek (zákl. hrací doba)“ – 3-cestný, základní doba
 *  - HTOH / H2HT „Vítěz“ – 2-cestný bez remízy = celý zápas; u MMA/boxu a am. fotbalu vynechán
 *    (není jisté, že Betano při remíze vrací vklad – docs/adapters.md)
 */
function marketDef(code: string, sport: Sport): MarketDef | null {
  switch (code) {
    case 'MRES':
      return sport === 'football' || sport === 'hockey' || sport === 'handball' || sport === 'american_football' || sport === 'baseball' || sport === 'mma' || sport === 'boxing'
        ? { type: '1X2', scope: 'REG', kind: 'RESULT' }
        : null;
    case 'DBLC':
      return sport === 'football' || sport === 'hockey' || sport === 'handball' ? { type: 'DC', scope: 'REG', kind: 'DC' } : null;
    case 'DNOB':
      return sport === 'football' ? { type: 'DNB', scope: 'REG', kind: 'TWO_WAY' } : null;
    case 'BTSC':
      return sport === 'football' ? { type: 'BTTS', scope: 'REG', kind: 'BTTS' } : null;
    case 'HCTG': // fotbal „celkový počet gólů“, hokej „(zákl. hrací doba)“, házená „Počet gólů“ (60 min)
      return sport === 'football' || sport === 'hockey' || sport === 'handball' ? { type: 'OU', scope: 'REG', kind: 'OU' } : null;
    case 'OUH1':
      return sport === 'football' ? { type: 'OU', scope: 'H1', kind: 'OU' } : null;
    case 'HTOH':
    case 'H2HT':
      return WINNER_SPORTS.includes(sport) ? { type: 'ML', scope: 'MATCH', kind: 'TWO_WAY' } : null;
    case 'TGHC': // tenis „Handicap - celkem gamů“
      return sport === 'tennis' ? { type: 'AH', scope: 'MATCH', kind: 'AH' } : null;
    case 'FTGO': // tenis „Gamy“
    case 'TGOU':
      return sport === 'tennis' ? { type: 'OU', scope: 'MATCH', kind: 'OU' } : null;
    case 'FOUT': // volejbal „Celkový počet bodů“
      return sport === 'volleyball' ? { type: 'OU', scope: 'MATCH', kind: 'OU' } : null;
    case 'FTPO': // stolní tenis „Celkový počet bodů“ (u basketu není jasné, zda vč. prodloužení)
      return sport === 'table_tennis' ? { type: 'OU', scope: 'MATCH', kind: 'OU' } : null;
    case 'TFOU': // snooker „Celkový počet framů“
      return sport === 'snooker' ? { type: 'OU', scope: 'MATCH', kind: 'OU' } : null;
    case 'SNHC': // snooker handicap na framy
      return sport === 'snooker' ? { type: 'AH', scope: 'MATCH', kind: 'AH' } : null;
    default:
      return null;
  }
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};

function sportOf(o: Obj, fallback?: Sport): Sport | undefined {
  const v = o.sportId;
  if (typeof v === 'string' && SPORT_CODES[v.toUpperCase()]) return SPORT_CODES[v.toUpperCase()];
  return fallback;
}

function participants(o: Obj): { names: [string, string]; teamIds: [string?, string?] } | undefined {
  const p = o.participants;
  if (Array.isArray(p) && p.length === 2) {
    const [a, b] = p.map(obj);
    const names = [str(a.name), str(b.name)];
    if (names[0] && names[1]) {
      // live feed označuje domácí isHome; když je označený druhý, prohodit
      const swap = b.isHome === true && a.isHome !== true;
      const ids: [string?, string?] = [a.teamId != null ? String(a.teamId) : undefined, b.teamId != null ? String(b.teamId) : undefined];
      return swap ? { names: [names[1], names[0]], teamIds: [ids[1], ids[0]] } : { names: [names[0], names[1]], teamIds: ids };
    }
  }
  const name = str(o.name) ?? str(o.shortName);
  const m = name ? /^(.+?)\s+(?:-|–)\s+(.+)$/.exec(name) : null;
  return m ? { names: [m[1].trim(), m[2].trim()], teamIds: [] } : undefined;
}

/** Pořadí výběru u 2-cestných trhů: teamId → columnIndex (jsou-li různé) → pořadí v poli. */
function sideOf(sel: Obj, idx: number, all: Obj[], teamIds: [string?, string?]): 'HOME' | 'AWAY' | undefined {
  const tid = sel.teamId != null ? String(sel.teamId) : undefined;
  if (tid && teamIds[0] && tid === teamIds[0]) return 'HOME';
  if (tid && teamIds[1] && tid === teamIds[1]) return 'AWAY';
  const cols = all.map((s) => num(s.columnIndex));
  if (cols.every((c) => c !== undefined) && new Set(cols).size === all.length) {
    const c = num(sel.columnIndex);
    return c === 0 ? 'HOME' : c === 1 ? 'AWAY' : undefined;
  }
  return idx === 0 ? 'HOME' : idx === 1 ? 'AWAY' : undefined;
}

function selectionKey(def: MarketDef, sel: Obj, idx: number, all: Obj[], teamIds: [string?, string?]): SelectionKey | undefined {
  const name = str(sel.name) ?? '';
  switch (def.kind) {
    case 'RESULT': {
      const k = labelToKey(name);
      if (k === 'HOME' || k === 'DRAW' || k === 'AWAY') return k;
      const c = num(sel.columnIndex) ?? idx;
      return (['HOME', 'DRAW', 'AWAY'] as const)[c];
    }
    case 'DC': {
      const k = labelToKey(name);
      return k === 'HOME_DRAW' || k === 'HOME_AWAY' || k === 'DRAW_AWAY' ? k : undefined;
    }
    case 'TWO_WAY':
    case 'AH':
      return sideOf(sel, idx, all, teamIds);
    case 'OU':
      return /^více|^over/i.test(name) ? 'OVER' : /^méně|^under/i.test(name) ? 'UNDER' : undefined;
    case 'BTTS':
      return /^ano|^yes/i.test(name) ? 'YES' : /^ne$|^no$/i.test(name) ? 'NO' : undefined;
  }
}

function mapMarket(m: Obj, sels: Obj[], sport: Sport, teamIds: [string?, string?]): RawMarket | null {
  const code = str(m.type);
  if (!code) return null;
  const def = marketDef(code, sport);
  if (!def) return null;
  const out: RawSelection[] = [];
  let line: number | undefined;
  for (const [i, s] of sels.entries()) {
    const key = selectionKey(def, s, i, sels, teamIds);
    const odds = toOdds(s.price);
    if (!key || odds === undefined || out.some((x) => x.key === key)) return null;
    out.push({ key, odds, open: !(s.suspended === true || s.isSuspended === true), rawName: str(s.name) });
    if (def.kind === 'OU') line ??= num(s.handicap) ?? num(m.handicap);
    if (def.kind === 'AH' && key === 'HOME') line = num(s.handicap);
  }
  const need = def.kind === 'RESULT' || def.kind === 'DC' ? 3 : 2;
  if (out.length !== need) return null;
  if ((def.kind === 'OU' || def.kind === 'AH') && line === undefined) return null;
  if (def.kind === 'OU' && line !== undefined && line <= 0) return null;
  return {
    key: marketKey(def.type, def.scope, def.kind === 'OU' || def.kind === 'AH' ? line : undefined),
    open: !(m.suspended === true || m.isSuspended === true) && out.some((s) => s.open !== false),
    selections: out,
    sourceId: m.id != null ? String(m.id) : undefined,
    rawName: str(m.name),
  };
}

function addMarkets(target: RawMarket[], list: Iterable<{ m: Obj; sels: Obj[] }>, sport: Sport, teamIds: [string?, string?]): void {
  for (const { m, sels } of list) {
    const mk = mapMarket(m, sels, sport, teamIds);
    // stejný klíč dvakrát (např. dvě linie OU se stejnou hodnotou) – první vyhrává
    if (mk && !target.some((x) => x.key === mk.key)) target.push(mk);
  }
}

/** Stav live zápasu z liveData (skóre, uplynulý čas, perioda). */
function liveState(o: Obj): GameState | undefined {
  const ld = obj(o.liveData);
  if (!Object.keys(ld).length) return undefined;
  const st: GameState = {};
  const sc = obj(ld.score);
  const h = num(sc.home);
  const a = num(sc.away);
  const results = obj(ld.results);
  if (o.sportId === 'TENN') {
    const sets = obj(results.completedSetsGamesScore);
    const sh = num(sets.home);
    const sa = num(sets.away);
    if (sh !== undefined && sa !== undefined) st.score = [sh, sa];
    const g = obj(results.currentSetGamesScore);
    const gh = num(g.home);
    const ga = num(g.away);
    if (gh !== undefined && ga !== undefined) st.games = [gh, ga];
    if (str(sc.home) && str(sc.away)) st.points = `${str(sc.home)}:${str(sc.away)}`;
  } else if (h !== undefined && a !== undefined) {
    st.score = [h, a];
  }
  const clock = obj(ld.clock);
  const secs = num(clock.secondsSinceStart);
  if (secs !== undefined) st.clockSec = secs;
  if (typeof clock.clockStopped === 'boolean') st.clockRunning = !clock.clockStopped;
  const text = str(ld.periodDescription);
  if (text) st.statusText = text;
  return Object.keys(st).length ? st : undefined;
}

interface EventMeta {
  competition?: string;
  country?: string;
}

function buildEvent(o: Obj, markets: RawMarket[], sport: Sport, names: [string, string], ctx: ParseContext, meta: EventMeta): RawEvent | null {
  const id = o.id ?? o.eventId;
  if (id == null || !markets.length) return null;
  const competition = str(o.leagueName) ?? str(o.leagueDescription) ?? meta.competition ?? '';
  const virtualText = `${competition} ${names.join(' ')} ${str(o.regionName) ?? ''} ${meta.country ?? ''}`;
  if (VIRTUAL_RX.test(virtualText) || o.isVirtual === true || o.isOutrightEvent === true) return null;
  const startTime = toEpochMs(o.startTime);
  if (!startTime) return null;
  const url = str(o.url);
  const live = ctx.scope === 'live' || o.isLive === true || o.liveNow === true;
  const ev: RawEvent = {
    sourceId: String(id),
    sport,
    competition,
    country: str(o.regionName) ?? meta.country,
    home: names[0],
    away: names[1],
    startTime,
    live,
    markets,
    url: url ? (url.startsWith('http') ? url : ctx.origin + url) : undefined,
  };
  const state = live ? liveState(o) : undefined;
  if (state) ev.state = state;
  return ev;
}

/** Vnořený tvar: událost s markets[] / sixPackBlocks[].columns[] a selections[] uvnitř. */
function parseNested(json: unknown, ctx: ParseContext, out: RawEvent[]): void {
  walkObjects(json, (o) => {
    const direct = Array.isArray(o.markets) ? o.markets.map(obj) : [];
    const six = Array.isArray(o.sixPackBlocks)
      ? o.sixPackBlocks.flatMap((b) => {
          const cols = obj(b).columns;
          return Array.isArray(cols) ? cols.map(obj) : [];
        })
      : [];
    if (!direct.length && !six.length) return;
    if (!Array.isArray(o.participants) && !str(o.name)) return;
    const sport = sportOf(o, ctx.sport);
    if (!sport) return;
    const p = participants(o);
    if (!p) return;
    const markets: RawMarket[] = [];
    const list = [...direct, ...six].map((m) => ({ m, sels: Array.isArray(m.selections) ? m.selections.map(obj) : [] }));
    addMarkets(markets, list, sport, p.teamIds);
    const ev = buildEvent(o, markets, sport, p.names, ctx, {});
    if (ev) out.push(ev);
  });
}

/** Normalizovaný tvar: { events, markets, selections, leagues?, zones? } jako mapy id → objekt. */
function parseNormalized(root: Obj, ctx: ParseContext, out: RawEvent[]): void {
  const events = obj(root.events);
  const markets = obj(root.markets);
  const selections = obj(root.selections);
  const leagues = obj(root.leagues);
  const zones = obj(root.zones);
  for (const raw of Object.values(events)) {
    const o = obj(raw);
    const sport = sportOf(o, ctx.sport);
    if (!sport) continue;
    const p = participants(o);
    if (!p) continue;
    const mids = Array.isArray(o.marketIdList) ? o.marketIdList : [];
    const list = mids.map((mid) => {
      const m = obj(markets[String(mid)]);
      const sids = Array.isArray(m.selectionIdList) ? m.selectionIdList : [];
      return { m, sels: sids.map((sid) => obj(selections[String(sid)])) };
    });
    const mk: RawMarket[] = [];
    addMarkets(mk, list, sport, p.teamIds);
    const league = obj(leagues[String(o.leagueId)]);
    const zone = obj(zones[String(o.zoneId)]);
    const ev = buildEvent(o, mk, sport, p.names, ctx, { competition: str(league.name), country: str(zone.name) });
    if (ev) out.push(ev);
  }
}

/** Najde normalizovaný kořen (live overview je přímo kořen, top-events je v data.topEventsV2). */
function normalizedRoots(json: unknown): Obj[] {
  const roots: Obj[] = [];
  walkObjects(
    json,
    (o) => {
      const ev = o.events;
      if (ev && typeof ev === 'object' && !Array.isArray(ev) && o.markets && typeof o.markets === 'object' && !Array.isArray(o.markets) && o.selections) {
        roots.push(o);
      }
    },
    4,
  );
  return roots;
}

export function parseBetano(json: unknown, ctx: ParseContext): RawEvent[] {
  const out: RawEvent[] = [];
  const roots = normalizedRoots(json);
  if (roots.length) for (const r of roots) parseNormalized(r, ctx, out);
  else parseNested(json, ctx, out);
  return out;
}
