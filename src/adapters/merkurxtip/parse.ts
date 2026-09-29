// MerkurXtip (www.merkurxtip.cz) – sportsbook Altenar (integrace "merkurxtip"), čisté parsování.
//
// Altenar widget API vrací normalizovaný tvar: events[] (marketIds, competitorIds), markets[]
// (oddIds nebo desktopOddIds po sloupcích), odds[] (typeId výběru, price, oddStatus, sv = linie),
// competitors[], champs[], categories[]. typeId trhů jsou ID trhů Sportradar UOF (1 = 1x2,
// 18 = total, 16 = asijský handicap, 406/410/412 = hokej vč. prodloužení a nájezdů, 219/223/225
// = basket vč. prodloužení, 186–204 tenis …). Názvy trhů navíc kontrolujeme (vč. prodl. vs. bez).
import { marketKey } from '../../core/markets.js';
import type { GameState, MarketScope, MarketType, RawEvent, RawMarket, RawSelection, SelectionKey, Sport } from '../../core/types.js';

export const SITE = 'https://www.merkurxtip.cz/sazeni';

export const SPORT_IDS: Record<Sport, number> = { football: 66, tennis: 68, basketball: 67, hockey: 70 };
const ID_TO_SPORT: Record<number, Sport> = { 66: 'football', 68: 'tennis', 67: 'basketball', 70: 'hockey' };

// ---------- surové typy ----------

export interface AltOdd {
  id: number;
  typeId: number;
  price: number;
  oddStatus?: number;
  name?: string;
  sv?: string;
  competitorId?: number;
}
export interface AltMarket {
  id: number;
  typeId: number;
  name: string;
  sv?: string;
  oddIds?: number[];
  desktopOddIds?: number[][];
  mobileOddIds?: number[][];
}
export interface AltTimer {
  playtime?: number;
  timeUtc?: string;
  isPaused?: boolean;
  isTimerCountDown?: boolean;
  matchPhase?: number;
}
export interface AltEvent {
  id: number;
  name: string;
  sportId: number;
  catId?: number;
  champId?: number;
  competitorIds?: number[];
  marketIds?: number[];
  startDate: string;
  status?: number;
  et?: number;
  liveTime?: string;
  ls?: string;
  score?: number[];
  currentSetScore?: number[];
  pointScore?: string[];
  timer?: AltTimer;
}
export interface AltListResponse {
  events?: AltEvent[];
  markets?: AltMarket[];
  odds?: AltOdd[];
  competitors?: { id: number; name: string }[];
  champs?: { id: number; name: string }[];
  categories?: { id: number; name: string; champIds?: number[] }[];
}
export interface AltDetailResponse {
  id: number;
  name: string;
  et?: number;
  startDate: string;
  sport?: { id: number; name: string };
  champ?: { id: number; name: string };
  category?: { id: number; name: string };
  competitors?: { id: number; name: string }[];
  markets?: AltMarket[];
  childMarkets?: AltMarket[];
  odds?: AltOdd[];
}

// ---------- mapování trhů ----------

type Kind = '1X2' | 'ML' | 'DNB' | 'OU' | 'AH' | 'BTTS' | 'OE';
interface Rule {
  type: MarketType;
  kind: Kind;
  /** Pevný rozsah, nebo 'period' = číslo periody z názvu ("1. třetina", "2. set", ...). */
  scope: MarketScope | 'P' | 'S' | 'Q';
  /** Název trhu musí odpovídat (ochrana proti posunu významu typeId). */
  name?: RegExp;
}

const OT = /prodl|nájezd|rozhodnut/i;

const RULES: Record<Sport, Record<number, Rule>> = {
  football: {
    1: { type: '1X2', kind: '1X2', scope: 'REG', name: /^Výsledek zápasu$/ },
    11: { type: 'DNB', kind: 'DNB', scope: 'REG' },
    18: { type: 'OU', kind: 'OU', scope: 'REG', name: /^Počet gólů$/ },
    16: { type: 'AH', kind: 'AH', scope: 'REG', name: /asijský handicap/i },
    29: { type: 'BTTS', kind: 'BTTS', scope: 'REG', name: /^Oba týmy dají gól$/ },
    19: { type: 'OU_HOME', kind: 'OU', scope: 'REG' },
    20: { type: 'OU_AWAY', kind: 'OU', scope: 'REG' },
    26: { type: 'OE', kind: 'OE', scope: 'REG', name: /^Počet gólů - lichá\/sudá$/ },
    60: { type: '1X2', kind: '1X2', scope: 'H1', name: /1\. poločas/ },
    64: { type: 'DNB', kind: 'DNB', scope: 'H1', name: /1\. poločas/ },
    66: { type: 'AH', kind: 'AH', scope: 'H1', name: /1\. poločas – handicap$/ },
    68: { type: 'OU', kind: 'OU', scope: 'H1', name: /^1\. poločas – počet gólů$/ },
    69: { type: 'OU_HOME', kind: 'OU', scope: 'H1', name: /^1\. poločas/ },
    70: { type: 'OU_AWAY', kind: 'OU', scope: 'H1', name: /^1\. poločas/ },
    75: { type: 'BTTS', kind: 'BTTS', scope: 'H1', name: /1\. poločas/ },
    83: { type: '1X2', kind: '1X2', scope: 'H2', name: /2\. poločas/ },
    86: { type: 'DNB', kind: 'DNB', scope: 'H2', name: /2\. poločas/ },
    88: { type: 'AH', kind: 'AH', scope: 'H2', name: /2\. poločas – handicap$/ },
    90: { type: 'OU', kind: 'OU', scope: 'H2', name: /^2\. poločas – počet gólů$/ },
    91: { type: 'OU_HOME', kind: 'OU', scope: 'H2', name: /^2\. poločas/ },
    92: { type: 'OU_AWAY', kind: 'OU', scope: 'H2', name: /^2\. poločas/ },
    95: { type: 'BTTS', kind: 'BTTS', scope: 'H2', name: /2\. poločas/ },
  },
  hockey: {
    1: { type: '1X2', kind: '1X2', scope: 'REG', name: /^Výsledek zápasu$/ },
    11: { type: 'DNB', kind: 'DNB', scope: 'REG', name: /^Sázka bez remízy$/ },
    18: { type: 'OU', kind: 'OU', scope: 'REG', name: /^Počet gólů$/ },
    16: { type: 'AH', kind: 'AH', scope: 'REG', name: /asijský handicap/i },
    29: { type: 'BTTS', kind: 'BTTS', scope: 'REG', name: /^Oba týmy vstřelí gól$/ },
    19: { type: 'OU_HOME', kind: 'OU', scope: 'REG' },
    20: { type: 'OU_AWAY', kind: 'OU', scope: 'REG' },
    406: { type: 'ML', kind: 'ML', scope: 'MATCH', name: OT },
    410: { type: 'AH', kind: 'AH', scope: 'MATCH', name: OT },
    412: { type: 'OU', kind: 'OU', scope: 'MATCH', name: OT },
    414: { type: 'OU_HOME', kind: 'OU', scope: 'MATCH', name: OT },
    415: { type: 'OU_AWAY', kind: 'OU', scope: 'MATCH', name: OT },
    443: { type: '1X2', kind: '1X2', scope: 'P', name: /třetin/ },
    446: { type: 'OU', kind: 'OU', scope: 'P', name: /třetina – počet gólů$/ },
    460: { type: 'AH', kind: 'AH', scope: 'P', name: /třetina – handicap$/ },
    459: { type: 'DNB', kind: 'DNB', scope: 'P', name: /třetina – sázka bez remízy$/ },
    452: { type: 'BTTS', kind: 'BTTS', scope: 'P', name: /třetina – oba týmy dají gól$/ },
  },
  basketball: {
    1: { type: '1X2', kind: '1X2', scope: 'REG', name: /^Výsledek zápasu$/ },
    219: { type: 'ML', kind: 'ML', scope: 'MATCH', name: OT },
    223: { type: 'AH', kind: 'AH', scope: 'MATCH', name: OT },
    225: { type: 'OU', kind: 'OU', scope: 'MATCH', name: OT },
    227: { type: 'OU_HOME', kind: 'OU', scope: 'MATCH', name: OT },
    228: { type: 'OU_AWAY', kind: 'OU', scope: 'MATCH', name: OT },
    60: { type: '1X2', kind: '1X2', scope: 'H1', name: /1\. poločas/ },
    66: { type: 'AH', kind: 'AH', scope: 'H1', name: /1\. poločas – handicap$/ },
    68: { type: 'OU', kind: 'OU', scope: 'H1', name: /^1\. poločas – počet bodů$/ },
  },
  tennis: {
    186: { type: 'ML', kind: 'ML', scope: 'MATCH', name: /^Vítěz$/ },
    187: { type: 'AH', kind: 'AH', scope: 'MATCH', name: /gamy v zápasu/ },
    188: { type: 'AH_SETS', kind: 'AH', scope: 'MATCH', name: /sety v zápasu/ },
    189: { type: 'OU', kind: 'OU', scope: 'MATCH', name: /^Počet gamů v zápasu$/ },
    190: { type: 'OU_HOME', kind: 'OU', scope: 'MATCH', name: /počet gamů v zápasu$/ },
    191: { type: 'OU_AWAY', kind: 'OU', scope: 'MATCH', name: /počet gamů v zápasu$/ },
    202: { type: 'ML', kind: 'ML', scope: 'S', name: /set – vítěz$/ },
    203: { type: 'AH', kind: 'AH', scope: 'S', name: /set – handicap – gamy$/ },
    204: { type: 'OU', kind: 'OU', scope: 'S', name: /set – celkem gamů$/ },
  },
};

/** typeId výběru → kanonický klíč. */
const SEL: Record<Kind, Record<number, SelectionKey>> = {
  '1X2': { 1: 'HOME', 2: 'DRAW', 3: 'AWAY' },
  ML: { 1: 'HOME', 3: 'AWAY' },
  DNB: { 1: 'HOME', 3: 'AWAY' },
  OU: { 12: 'OVER', 13: 'UNDER' },
  AH: { 1714: 'HOME', 1715: 'AWAY' },
  BTTS: { 74: 'YES', 76: 'NO' },
  OE: { 70: 'ODD', 72: 'EVEN' },
};
const REQUIRED: Record<Kind, number> = { '1X2': 3, ML: 2, DNB: 2, OU: 2, AH: 2, BTTS: 2, OE: 2 };

function periodScope(name: string, prefix: 'P' | 'S' | 'Q'): MarketScope | null {
  const n = /(\d)\.\s*(třetin|set|čtvrtin)/i.exec(name)?.[1];
  if (!n) return null;
  const max = prefix === 'P' ? 3 : prefix === 'Q' ? 4 : 5;
  return Number(n) >= 1 && Number(n) <= max ? (`${prefix}${n}` as MarketScope) : null;
}

/** Linie z odd.sv (poslední složka "1|1.5" → 1.5); jen x.0 / x.5. */
function lineOf(o: { sv?: string }): number | undefined {
  if (o.sv == null || o.sv === '') return undefined;
  const last = String(o.sv).split('|').pop()!;
  const v = Number(last.replace(',', '.'));
  if (!Number.isFinite(v)) return undefined;
  return Math.abs(v * 2 - Math.round(v * 2)) < 1e-9 ? v : undefined;
}

function selection(key: SelectionKey, o: AltOdd): RawSelection | null {
  if (typeof o.price !== 'number' || !Number.isFinite(o.price) || o.price <= 1) return null;
  // Altenar posílá "přesné" kurzy (2.2223), web je ukazuje zaokrouhlené na 2 místa. Nevíme jistě,
  // se kterou hodnotou sázka počítá → konzervativně ořízneme na 2 desetinná místa (nikdy nenadsadíme).
  const odds = Math.floor(o.price * 100 + 1e-6) / 100;
  if (odds < 1.01) return null;
  return { key, odds, open: (o.oddStatus ?? 0) === 0, rawName: o.name };
}

/** Všechny odd ID trhu (listing: oddIds, detail: desktopOddIds po sloupcích). */
function oddIdsOf(m: AltMarket): number[] {
  if (m.oddIds?.length) return m.oddIds;
  return (m.desktopOddIds ?? m.mobileOddIds ?? []).flat();
}

/** Jeden Altenar trh → 0..n kanonických trhů (víc linií v jednom trhu u OU/AH). */
export function mapMarket(sport: Sport, m: AltMarket, odds: Map<number, AltOdd>): RawMarket[] {
  const rule = RULES[sport][m.typeId];
  if (!rule) return [];
  if (rule.name && !rule.name.test(m.name)) return [];
  // pojistka rozsahu: REG/periody nesmí mluvit o prodloužení, MATCH (hokej/basket) musí
  if (rule.scope !== 'MATCH' && OT.test(m.name)) return [];
  let scope: MarketScope | null;
  if (rule.scope === 'P' || rule.scope === 'S' || rule.scope === 'Q') scope = periodScope(m.name, rule.scope);
  else scope = rule.scope;
  if (!scope) return [];
  const sels = SEL[rule.kind];
  const groups = new Map<string, { line?: number; sels: RawSelection[]; ids: Set<number> }>();
  for (const id of oddIdsOf(m)) {
    const o = odds.get(id);
    if (!o) continue;
    const key = sels[o.typeId];
    if (!key) return []; // neznámý typ výběru → trh přeskočit celý
    let line: number | undefined;
    if (rule.kind === 'OU' || rule.kind === 'AH') {
      // detail: linie na každém výběru; listing: jen market.sv (u AH = linie domácích)
      line = o.sv != null && o.sv !== '' ? lineOf(o) : lineOf(m);
      if (line === undefined) continue; // čtvrtinová linie apod.
    }
    const g = groups.get(String(line)) ?? { line, sels: [], ids: new Set<number>() };
    if (g.ids.has(o.id)) continue;
    g.ids.add(o.id);
    const s = selection(key, o);
    if (s) g.sels.push(s);
    groups.set(String(line), g);
  }
  const out: RawMarket[] = [];
  for (const g of groups.values()) {
    const keys = new Set(g.sels.map((s) => s.key));
    if (keys.size !== g.sels.length || g.sels.length !== REQUIRED[rule.kind]) continue;
    if (rule.kind === 'OU' && (g.line ?? -1) < 0) continue;
    out.push({
      key: marketKey(rule.type, scope, g.line),
      open: g.sels.some((s) => s.open !== false),
      selections: g.sels,
      sourceId: g.line === undefined ? String(m.id) : `${m.id}:${g.line}`,
      rawName: m.name,
    });
  }
  return out;
}

// ---------- herní stav ----------

const BREAK_RE = /^poločas$|přestávk|pauza|^konec \d|po \d\. (třetin|čtvrtin|set)|break|half ?time/i;

/**
 * Stav z live listingu: `ls` (surový text: "1. poločas", "Poločas", "2. třetina", "Přestávka",
 * "1. set", "Pozastaveno"), `score`, u tenisu `currentSetScore` (gemy) a `pointScore`, hodiny v
 * `timer` (playtime ms k okamžiku timeUtc, isPaused) nebo aspoň `liveTime` ("24'").
 */
export function parseState(e: AltEvent, sport: Sport, now: number): GameState {
  const st: GameState = {};
  const ls = (e.ls ?? e.liveTime ?? '').trim();
  if (ls) st.statusText = ls;
  if (e.score?.length === 2 && e.score.every((x) => Number.isInteger(x) && x >= 0)) st.score = [e.score[0], e.score[1]];
  const per = /(\d)\.\s*(poločas|třetin|čtvrtin|set|prodl)/i.exec(ls);
  if (per) st.period = Number(per[1]);
  // "První/Druhá přestávka" (hokej) = přestávka po n-té třetině
  const ord = /^(první|druhá|třetí)\s+přestávka/i.exec(ls)?.[1]?.toLowerCase();
  if (ord) st.period = ord === 'první' ? 1 : ord === 'druhá' ? 2 : 3;
  if (sport === 'tennis') {
    const g = e.currentSetScore;
    if (g?.length === 2 && g.every((x) => Number.isInteger(x) && x >= 0)) st.games = [g[0], g[1]];
    if (e.pointScore?.length === 2) st.points = `${e.pointScore[0]}:${e.pointScore[1]}`;
  }
  if (BREAK_RE.test(ls)) st.breakFlag = true;
  if (/konec zápasu|ukončen|^konec$|finished|ended/i.test(ls)) st.finished = true;
  const t = e.timer;
  if (t && typeof t.playtime === 'number') {
    const at = Date.parse(t.timeUtc ?? '');
    const running = t.isPaused === false;
    const drift = running && Number.isFinite(at) && now > at ? now - at : 0;
    if (t.isTimerCountDown) st.periodRemainingSec = Math.max(0, Math.min(3600, Math.round((t.playtime - drift) / 1000)));
    else st.clockSec = Math.max(0, Math.min(4 * 3600, Math.round((t.playtime + drift) / 1000)));
    st.clockRunning = running;
  } else if (sport !== 'tennis') {
    const min = /^(\d+)'/.exec(e.liveTime ?? '')?.[1];
    if (min) st.clockSec = Math.max(0, (Number(min) - 1) * 60);
  }
  if (st.breakFlag) st.clockRunning = false;
  return st;
}

// ---------- události ----------

export interface ParseOptions {
  scope: 'prematch' | 'live';
  now: number;
  sports?: Sport[];
}

/** Detail zápasu na webu (hash router Altenar SDK). */
export function eventUrl(e: Pick<AltEvent, 'id' | 'sportId' | 'catId' | 'champId'>): string {
  return `${SITE}#/sport/${e.sportId}/category/${e.catId ?? 0}/championship/${e.champId ?? 0}/event/${e.id}`;
}

/** Listing (GetEvents / GetLiveEvents / GetEventsById) → RawEvent[]. */
export function parseList(r: AltListResponse, o: ParseOptions): RawEvent[] {
  const odds = new Map((r.odds ?? []).map((x) => [x.id, x]));
  const markets = new Map((r.markets ?? []).map((x) => [x.id, x]));
  const comp = new Map((r.competitors ?? []).map((x) => [x.id, x.name]));
  const champ = new Map((r.champs ?? []).map((x) => [x.id, x.name]));
  const cat = new Map((r.categories ?? []).map((x) => [x.id, x.name]));
  const out: RawEvent[] = [];
  const seen = new Set<string>();
  for (const e of r.events ?? []) {
    const sport = ID_TO_SPORT[e.sportId];
    if (!sport || (o.sports && !o.sports.includes(sport))) continue;
    if ((e.et ?? 0) !== 0 || e.competitorIds?.length !== 2) continue;
    const home = comp.get(e.competitorIds[0])?.trim();
    const away = comp.get(e.competitorIds[1])?.trim();
    const startTime = Date.parse(e.startDate);
    if (!home || !away || !Number.isFinite(startTime) || seen.has(String(e.id))) continue;
    seen.add(String(e.id));
    const ms: RawMarket[] = [];
    const keys = new Set<string>();
    for (const id of e.marketIds ?? []) {
      const m = markets.get(id);
      if (!m) continue;
      for (const rm of mapMarket(sport, m, odds)) {
        if (keys.has(rm.key)) continue;
        keys.add(rm.key);
        ms.push(rm);
      }
    }
    const live = o.scope === 'live';
    const ev: RawEvent = {
      sourceId: String(e.id),
      sport,
      competition: (e.champId !== undefined ? champ.get(e.champId) : undefined) ?? '',
      home,
      away,
      startTime,
      live,
      markets: ms,
      url: eventUrl(e),
    };
    const country = e.catId !== undefined ? cat.get(e.catId) : undefined;
    if (country) ev.country = country;
    if (live) ev.state = parseState(e, sport, o.now);
    out.push(ev);
  }
  return out;
}

/** Detail události (GetEventDetails) → všechny kanonické trhy. */
export function parseDetailMarkets(d: AltDetailResponse, sport: Sport): RawMarket[] {
  const odds = new Map((d.odds ?? []).map((x) => [x.id, x]));
  // stejný trh bývá v odpovědi víckrát (varianta pro BetBuilder s podmnožinou linií) → sloučit
  const merged = new Map<number, AltMarket>();
  for (const m of [...(d.markets ?? []), ...(d.childMarkets ?? [])]) {
    const cur = merged.get(m.id);
    const ids = oddIdsOf(m);
    if (!cur) merged.set(m.id, { ...m, oddIds: [...ids] });
    else cur.oddIds = [...new Set([...(cur.oddIds ?? []), ...ids])];
  }
  const out: RawMarket[] = [];
  const keys = new Set<string>();
  for (const m of merged.values()) {
    for (const rm of mapMarket(sport, m, odds)) {
      if (keys.has(rm.key)) continue;
      keys.add(rm.key);
      out.push(rm);
    }
  }
  return out;
}

/** Doplní události z listingu o trhy z detailu (detail má přednost u stejného klíče). */
export function mergeDetails(events: RawEvent[], details: Map<string, AltDetailResponse>): RawEvent[] {
  return events.map((e) => {
    const d = details.get(e.sourceId);
    if (!d) return e;
    const dm = parseDetailMarkets(d, e.sport);
    if (!dm.length) return e;
    const keys = new Set(dm.map((m) => m.key));
    return { ...e, markets: [...dm, ...e.markets.filter((m) => !keys.has(m.key))] };
  });
}
