// Čisté parsování SportsOfferApi betx (Evona, sportapis-cz.betx.bet). Trhy se mapují podle
// Odds[].UofKey = "uof:{producer}/sr:sport:{id}/{uofMarket}/{outcome}?{specifikátory}".
import type { GameState, RawEvent, RawMarket, Sport } from '../../core/types.js';
import { isVirtualName, MarketCollector, uofDef, uofMarketKey, uofSelection, validOdds } from '../common/uof.js';

/** betx SportId -> kanonický sport. */
export const BETX_SPORTS: Record<number, Sport> = { 388: 'football', 389: 'tennis', 391: 'basketball', 398: 'hockey' };
export const SPORT_IDS: Record<Sport, number> = { football: 388, tennis: 389, basketball: 391, hockey: 398 };

export interface BetxOdd {
  Name?: string;
  Odd: number;
  Active?: boolean;
  UofKey?: string;
}

export interface BetxOffer {
  Id?: number;
  Description?: string;
  BetTypeKey?: string;
  Active?: boolean;
  IsEnabled?: boolean;
  Odds?: BetxOdd[];
}

export interface BetxMatch {
  Id: number;
  Description?: string;
  TeamHome?: string;
  TeamAway?: string;
  MatchStartTime: string;
  SportId: number;
  CategoryName?: string;
  LeagueName?: string;
  EventType?: number;
  IsBlocked?: boolean;
  BasicOffer?: BetxOffer | null;
  Offers?: BetxOffer[] | null;
  IsLive?: boolean;
  LiveMatchTime?: string | null;
  LiveMatchTimeState?: string | null;
  LiveMatchTimeOrigName?: string | null;
  LiveMatchScore?: string | null;
  LiveSetScore?: string | null;
  LiveGameScore?: string | null;
  LiveStatusString?: string | null;
  LiveIsBlocked?: boolean;
  LiveIsDisabled?: boolean;
  LiveBettingEnabled?: boolean;
}

/** matches/flat: { Count, Response: BetxMatch[] } */
export interface BetxFlatResponse {
  Count: number;
  Response: BetxMatch[];
}

/** matches/live: strom sport -> kategorie -> liga -> zápasy. */
export interface BetxSportNode {
  Id: number;
  Name?: string;
  Categories: { Id: number; Name?: string; Leagues: { Id: number; Name?: string; Matches: BetxMatch[] }[] }[];
}

export function flattenLive(tree: BetxSportNode[]): BetxMatch[] {
  const out: BetxMatch[] = [];
  for (const s of tree) for (const c of s.Categories ?? []) for (const l of c.Leagues ?? []) out.push(...(l.Matches ?? []));
  return out;
}

export interface UofKey {
  producer: number;
  srSport: number;
  market: number;
  outcome: number;
  specs: Record<string, string>;
}

/** "uof:3/sr:sport:4/18/13?total=5.5" -> části; varianty ("sr:correct_score:…") vrací undefined. */
export function parseUofKey(k: string | undefined): UofKey | undefined {
  const m = /^uof:(\d+)\/sr:sport:(\d+)\/(\d+)\/(\d+)(?:\?(.*))?$/.exec(k ?? '');
  if (!m) return undefined;
  const specs: Record<string, string> = {};
  for (const part of (m[5] ?? '').split('&')) {
    const i = part.indexOf('=');
    if (i > 0) specs[part.slice(0, i)] = decodeURIComponent(part.slice(i + 1));
  }
  return { producer: Number(m[1]), srSport: Number(m[2]), market: Number(m[3]), outcome: Number(m[4]), specs };
}

export function parseOffers(sport: Sport, offers: BetxOffer[], blocked: boolean): RawMarket[] {
  const col = new MarketCollector();
  for (const of of offers) {
    const marketOpen = !blocked && of.Active !== false && of.IsEnabled !== false;
    for (const o of of.Odds ?? []) {
      const u = parseUofKey(o.UofKey);
      if (!u) continue;
      const def = uofDef(sport, u.market);
      if (!def) continue;
      const sel = uofSelection(def.type, u.outcome);
      const price = validOdds(o.Odd);
      if (!sel || price === undefined) continue;
      const key = uofMarketKey(def, u.specs);
      if (!key) continue;
      col.add(key, { key: sel, odds: price, ...(o.Active === false ? { open: false } : {}), rawName: o.Name?.trim() }, {
        marketOpen,
        sourceId: of.Id ? String(of.Id) : undefined,
        rawName: of.Description?.trim(),
      });
    }
  }
  return col.build();
}

/** Zápasy (flat prematch listing nebo zploštěný live strom) -> události. */
export function parseBetxMatches(matches: BetxMatch[], o: { live: boolean }): RawEvent[] {
  const out: RawEvent[] = [];
  for (const m of matches) {
    const sport = BETX_SPORTS[m.SportId];
    if (!sport) continue;
    const home = m.TeamHome?.trim();
    const away = m.TeamAway?.trim();
    if (!home || !away) continue;
    if (m.EventType !== undefined && m.EventType !== 1) continue; // 1 = zápas (jinak dlouhodobé/speciály)
    const competition = m.LeagueName?.trim() ?? '';
    if (isVirtualName(competition, home, away)) continue;
    const startTime = Date.parse(m.MatchStartTime);
    if (!Number.isFinite(startTime)) continue;
    const blocked = !!m.IsBlocked || (o.live && (!!m.LiveIsBlocked || !!m.LiveIsDisabled || m.LiveBettingEnabled === false));
    const offers = [...(m.BasicOffer ? [m.BasicOffer] : []), ...(m.Offers ?? [])];
    const ev: RawEvent = {
      sourceId: String(m.Id),
      sport,
      competition,
      home,
      away,
      startTime,
      live: o.live,
      markets: parseOffers(sport, offers, blocked),
    };
    if (m.CategoryName) ev.country = m.CategoryName;
    if (o.live) ev.state = betxState(m, sport);
    out.push(ev);
  }
  return out;
}

/** Sloučí události z více průchodů (různé BetTypeKey) – trhy se sjednotí podle klíče. */
export function mergeEvents(lists: RawEvent[][]): RawEvent[] {
  const byId = new Map<string, RawEvent>();
  for (const list of lists)
    for (const ev of list) {
      const prev = byId.get(ev.sourceId);
      if (!prev) {
        byId.set(ev.sourceId, { ...ev, markets: [...ev.markets] });
        continue;
      }
      const seen = new Set(prev.markets.map((m) => m.key));
      for (const m of ev.markets) if (!seen.has(m.key)) prev.markets.push(m);
    }
  return [...byId.values()];
}

function pair(s: string | null | undefined): [number, number] | undefined {
  const m = /^\s*(\d+)\s*:\s*(\d+)\s*$/.exec(s ?? '');
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}

/**
 * Herní stav z live listingu. Přestávky: LiveStatusString "paused" + LiveMatchTimeOrigName
 * "*_PAUSED" + text "Přestávka" (fotbal HT i hokejová přestávka). Perioda z OrigName
 * (LB_SOCCER_2P, LB_ICE_HOCKEY_2P, LB_TENNIS_3SET…), jinak počet dosavadních dílčích skóre.
 */
export function betxState(m: BetxMatch, sport: Sport): GameState {
  const st: GameState = {};
  const text = (m.LiveMatchTimeState ?? '').trim();
  const orig = (m.LiveMatchTimeOrigName ?? '').toUpperCase();
  const status = (m.LiveStatusString ?? '').toLowerCase();
  if (text || status) st.statusText = text || status;
  const score = pair(m.LiveMatchScore);
  if (score) st.score = score;
  const parts = (m.LiveSetScore ?? '').split(' - ').map(pair);
  const periodScores = parts.every((p): p is [number, number] => !!p) ? parts : [];
  if (periodScores.length) st.periodScores = periodScores;
  const finished = status === 'ended' || /_ENDED$/.test(orig) || /konec/i.test(text);
  if (finished) st.finished = true;
  const isBreak = status === 'paused' || /PAUSE|HALFTIME|HALF_TIME|BREAK|INTERMISSION/.test(orig) || /přestávk|poločasová/i.test(text);
  if (isBreak && !finished) st.breakFlag = true;
  const pm = /_(\d+)(?:P|Q|SET|H)$/.exec(orig) ?? /(\d+)\.\s*(?:poločas|třetina|čtvrtina|set)/i.exec(text);
  if (pm) st.period = Number(pm[1]);
  else if (!finished && periodScores.length) st.period = periodScores.length;
  if (sport === 'tennis') {
    const cur = periodScores[periodScores.length - 1];
    if (cur) st.games = cur;
    const pts = /^\s*(\w+)\s*:\s*(\w+)\s*$/.exec(m.LiveGameScore ?? '');
    if (pts) st.points = `${pts[1]}:${pts[2]}`;
  } else if (sport === 'football' || sport === 'hockey') {
    // LiveMatchTime = odehrané minuty zápasu (fotbal 45 v HT, hokej 20 v 1. přestávce);
    // u basketu není jasné, zda jde o čas zápasu nebo čtvrtiny -> vynecháno
    const min = Number(m.LiveMatchTime);
    if (m.LiveMatchTime && Number.isFinite(min) && min >= 0 && min <= 240) st.clockSec = min * 60;
  }
  return st;
}
