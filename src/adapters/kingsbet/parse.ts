// Čisté parsování odpovědí Altenar widget API (sb2frontend-altenar2.biahosted.com, integration=kingsbet).
import type { GameState, RawEvent, RawMarket, Sport } from '../../core/types.js';
import { isVirtualName, MarketCollector, uofDef, uofMarketKey, uofSelection, validOdds } from '../common/uof.js';

/** Altenar sportId -> kanonický sport (typeId: fotbal 1, tenis 4, basket 12, hokej 16). */
export const ALTENAR_SPORTS: Record<number, Sport> = { 66: 'football', 68: 'tennis', 67: 'basketball', 70: 'hockey' };
export const SPORT_IDS: Record<Sport, number> = { football: 66, tennis: 68, basketball: 67, hockey: 70 };

export interface AltenarOdd {
  id: number;
  typeId: number;
  price: number;
  oddStatus?: number;
  name?: string;
  sv?: string;
  competitorId?: number;
}

export interface AltenarMarket {
  id: number;
  typeId: number;
  name?: string;
  sv?: string;
  oddIds?: number[];
  desktopOddIds?: number[][];
  isBB?: boolean;
}

export interface AltenarTimer {
  playtime?: number;
  timeUtc?: string;
  isPaused?: boolean;
  matchPhase?: number;
}

export interface AltenarEvent {
  id: number;
  name: string;
  sportId: number;
  catId: number;
  champId: number;
  startDate: string;
  status?: number;
  et?: number;
  competitorIds?: number[];
  marketIds?: number[];
  liveTime?: string;
  ls?: string;
  score?: number[];
  currentSetScore?: number[];
  pointScore?: string[];
  timer?: AltenarTimer;
}

/** Odpověď GetEvents / GetLiveEvents / GetLiveOverview (normalizované pole entit). */
export interface AltenarListResponse {
  events: AltenarEvent[];
  markets: AltenarMarket[];
  odds: AltenarOdd[];
  competitors: { id: number; name: string }[];
  champs: { id: number; name: string }[];
  categories: { id: number; name: string }[];
}

/** Odpověď GetEventDetails (jedna událost, všechny trhy). */
export interface AltenarDetailsResponse {
  id: number;
  name: string;
  startDate: string;
  sport?: { id: number; name?: string };
  champ?: { id: number; name: string };
  category?: { id: number; name: string };
  competitors: { id: number; name: string }[];
  markets: AltenarMarket[];
  childMarkets?: AltenarMarket[];
  odds: AltenarOdd[];
}

export function eventUrl(id: number, sportId: number): string {
  return `https://www.kingsbet.cz/sport?page=event&eventId=${id}&sportId=${sportId}`;
}

/**
 * Trhy jedné události. Altenar: market.typeId = UOF id trhu, market.sv = hodnoty specifikátorů
 * spojené "|" v abecedním pořadí (např. "1|5.5" = periodnr|total, "-0.5|1" = hcp|periodnr).
 * U vícelinkových trhů nese každý kurz vlastní odd.sv = linie (handicap z pohledu domácích).
 */
export function parseAltenarMarkets(
  sport: Sport,
  marketIds: number[],
  marketsById: Map<number, AltenarMarket>,
  oddsById: Map<number, AltenarOdd>,
): RawMarket[] {
  const col = new MarketCollector();
  for (const mid of marketIds) {
    const m = marketsById.get(mid);
    if (!m) continue;
    const def = uofDef(sport, m.typeId);
    if (!def) continue;
    const parts = (m.sv ?? '').split('|');
    const specs: Record<string, string | undefined> = {};
    if (def.specs.length && parts.length === def.specs.length) def.specs.forEach((s, i) => (specs[s] = parts[i]));
    else if (def.specs.length && m.sv !== undefined) continue; // neznámý tvar specifikátorů -> radši vynechat
    const lineSpec = def.specs.find((s) => s === 'hcp' || s === 'total');
    const oddIds = m.oddIds?.length ? m.oddIds : (m.desktopOddIds ?? []).flat();
    for (const oid of oddIds) {
      const o = oddsById.get(oid);
      if (!o) continue;
      const sel = uofSelection(def.type, o.typeId);
      const price = validOdds(o.price);
      if (!sel || price === undefined) continue;
      const s = lineSpec && o.sv !== undefined ? { ...specs, [lineSpec]: o.sv } : specs;
      const key = uofMarketKey(def, s);
      if (!key) continue;
      const open = (o.oddStatus ?? 0) === 0;
      col.add(key, { key: sel, odds: price, ...(open ? {} : { open: false }), rawName: o.name }, {
        marketOpen: true,
        sourceId: String(m.id),
        rawName: m.name,
      });
    }
  }
  return col.build();
}

/** Seznam událostí (GetEvents pro prematch, GetLiveEvents pro live). */
export function parseAltenarList(raw: AltenarListResponse, o: { live: boolean; now: number }): RawEvent[] {
  const markets = new Map(raw.markets.map((m) => [m.id, m]));
  const odds = new Map(raw.odds.map((x) => [x.id, x]));
  const comps = new Map(raw.competitors.map((c) => [c.id, c.name.trim()]));
  const champs = new Map(raw.champs.map((c) => [c.id, c.name]));
  const cats = new Map(raw.categories.map((c) => [c.id, c.name]));
  const out: RawEvent[] = [];
  for (const e of raw.events) {
    const sport = ALTENAR_SPORTS[e.sportId];
    if (!sport) continue;
    if ((e.et ?? 0) !== 0) continue; // et != 0: outright / speciál
    const [home, away] = names(e, comps);
    if (!home || !away) continue;
    const competition = champs.get(e.champId) ?? '';
    if (isVirtualName(competition, home, away)) continue;
    const startTime = Date.parse(e.startDate);
    if (!Number.isFinite(startTime)) continue;
    const ev: RawEvent = {
      sourceId: String(e.id),
      sport,
      competition,
      country: cats.get(e.catId),
      home,
      away,
      startTime,
      live: o.live,
      markets: parseAltenarMarkets(sport, e.marketIds ?? [], markets, odds),
      url: eventUrl(e.id, e.sportId),
    };
    if (ev.country === undefined) delete ev.country;
    if (o.live) ev.state = altenarState(e, sport, o.now);
    out.push(ev);
  }
  return out;
}

/** Trhy z GetEventDetails (hlavní trhy + child trhy), BetBuilder duplicity se přeskočí. */
export function parseAltenarDetails(raw: AltenarDetailsResponse, sport: Sport): RawMarket[] {
  const all = [...raw.markets, ...(raw.childMarkets ?? [])].filter((m) => !m.isBB);
  const byId = new Map(all.map((m) => [m.id, m]));
  const odds = new Map(raw.odds.map((x) => [x.id, x]));
  return parseAltenarMarkets(sport, [...byId.keys()], byId, odds);
}

/** Sloučí trhy (existující klíče mají přednost – listing a detail mají stejné kurzy). */
export function mergeMarkets(base: RawMarket[], extra: RawMarket[]): RawMarket[] {
  const seen = new Set(base.map((m) => m.key));
  return [...base, ...extra.filter((m) => !seen.has(m.key))];
}

function names(e: AltenarEvent, comps: Map<number, string>): [string | undefined, string | undefined] {
  const ids = e.competitorIds ?? [];
  if (ids.length === 2) return [comps.get(ids[0]), comps.get(ids[1])];
  const parts = e.name.split(' vs. ');
  return parts.length === 2 ? [parts[0].trim(), parts[1].trim()] : [undefined, undefined];
}

const ORDINALS: Record<string, number> = { první: 1, druhá: 2, třetí: 3, čtvrtá: 4 };

/**
 * Herní stav z live události. Altenar dává `ls` (text stavu, např. "1. poločas", "Poločas",
 * "První přestávka", "2. set", "Pozastaveno"), `score`, u tenisu `currentSetScore` (gemy)
 * a `pointScore`, u fotbalu `timer` (playtime ms k timeUtc, isPaused, matchPhase 2/3/4 = 1.P/HT/2.P).
 */
export function altenarState(e: AltenarEvent, sport: Sport, now: number): GameState {
  const st: GameState = {};
  const text = (e.ls || e.liveTime || '').trim();
  if (text) st.statusText = text;
  const pair = (v: unknown): [number, number] | undefined =>
    Array.isArray(v) && v.length === 2 && v.every((x) => Number.isInteger(x) && x >= 0) ? [v[0], v[1]] : undefined;
  const score = pair(e.score);
  if (score) st.score = score;
  const num = /(\d+)\.\s*(poločas|třetina|čtvrtina|set|perioda)/i.exec(text);
  const ord = /^(první|druhá|třetí|čtvrtá)\s+přestávka/i.exec(text);
  if (num) st.period = Number(num[1]);
  else if (ord) st.period = ORDINALS[ord[1].toLowerCase()];
  else if (sport === 'football' && e.timer?.matchPhase === 3) st.period = 1;
  const isBreak =
    /přestávk|pauza|^poločas$|break|half\s*time|intermission/i.test(text) ||
    (sport === 'football' && e.timer?.matchPhase === 3);
  if (isBreak) st.breakFlag = true;
  if (/konec|ukončen|skončen|ended|finished/i.test(text)) st.finished = true;
  if (sport === 'tennis') {
    const games = pair(e.currentSetScore);
    if (games) st.games = games;
    if (Array.isArray(e.pointScore) && e.pointScore.length === 2) st.points = e.pointScore.join(':');
  }
  const t = e.timer;
  if (t && typeof t.playtime === 'number') {
    let ms = t.playtime;
    const at = t.timeUtc ? Date.parse(t.timeUtc) : NaN;
    if (!t.isPaused && Number.isFinite(at) && now > at) ms += now - at;
    const sec = Math.round(ms / 1000);
    if (sec >= 0 && sec <= 4 * 3600) st.clockSec = sec;
    st.clockRunning = !t.isPaused;
  } else {
    const min = /^(\d+)'/.exec(e.liveTime ?? '');
    if (min && sport !== 'tennis') st.clockSec = Number(min[1]) * 60;
  }
  return st;
}
