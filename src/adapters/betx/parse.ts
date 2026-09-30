// Čisté parsování SportsOfferApi betx (Evona, sportapis-cz.betx.bet). Trhy se mapují podle
// Odds[].UofKey = "uof:{producer}/sr:sport:{id}/{uofMarket}/{outcome}?{specifikátory}".
// SignalR push (hub notificationv3) UofKey nenese – tam se UofKey skládá z BetTypeKey + OrigName
// podle tabulky PUSH_BET_TYPES (ověřené proti UofKey v listingu, viz checkPushTable()).
import type { GameState, RawEvent, RawMarket, Sport } from '../../core/types.js';
import { isVirtualName, MarketCollector, uofDef, uofMarketKey, uofSelection, validOdds } from '../common/uof.js';

/** Kanonický sport -> betx SportId (offer/v3/sports; 425/449 „BETX (Super)šance“ = speciály – ignorují se). */
export const SPORT_IDS: Partial<Record<Sport, number>> = {
  football: 388,
  tennis: 389,
  basketball: 391,
  hockey: 398,
  handball: 392,
  volleyball: 397,
  american_football: 404,
  baseball: 394,
  boxing: 414,
  mma: 455,
  snooker: 406,
  table_tennis: 417,
  darts: 401,
};
/** betx SportId -> kanonický sport. */
export const BETX_SPORTS: Record<number, Sport> = Object.fromEntries(Object.entries(SPORT_IDS).map(([s, id]) => [id, s as Sport]));
/** betx SportId -> Sportradar sport (jen pro složení UofKey z push dat; ověřeno z UofKey „sr:sport:N“). */
const SR_SPORT: Record<number, number> = { 388: 1, 389: 5, 391: 2, 398: 4, 392: 6, 397: 23, 404: 16, 394: 3, 414: 10, 455: 117, 406: 19, 417: 20, 401: 22 };

export interface BetxOdd {
  Name?: string;
  OrigName?: string;
  Odd: number;
  Active?: boolean;
  UofKey?: string;
}

export interface BetxOffer {
  Id?: number;
  Description?: string;
  BetTypeKey?: string;
  /** Linie ("2.5", "-4.5"); u handicapu z pohledu domácích (= specifikátor hcp v UofKey). */
  Sbv?: string | null;
  Active?: boolean;
  IsEnabled?: boolean;
  Odds?: BetxOdd[];
}

export interface BetxMatch {
  Id: number;
  Description?: string;
  TeamHome?: string;
  TeamAway?: string;
  /** Plánovaný začátek (i v live – LiveMatchStartTime je vždy stejný, skutečný výkop feed nedává). */
  MatchStartTime: string;
  SportId: number;
  CategoryName?: string;
  LeagueName?: string;
  EventType?: number;
  IsBlocked?: boolean;
  BasicOffer?: BetxOffer | null;
  Offers?: BetxOffer[] | null;
  IsLive?: boolean;
  /** false = web zápas v live nezobrazuje (typicky už skončil). */
  IsLiveMatchAvailable?: boolean;
  /** 1 = hraje se, 2 = konec. */
  LiveMatchState?: number | null;
  LiveMatchTime?: string | null;
  LiveMatchTimeState?: string | null;
  LiveMatchTimeOrigName?: string | null;
  LiveMatchScore?: string | null;
  LiveSetScore?: string | null;
  LiveGameScore?: string | null;
  LiveStatusString?: string | null;
  /** Poslední živá aktualizace zápasu na serveru (ISO). Max přes listing ≈ okamžik vygenerování. */
  LiveUpdateTimestamp?: string | null;
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

/**
 * Live listing je na serveru cachovaný: odpověď se generuje při prvním dotazu po vypršení a pak se
 * ~10–11 s vrací beze změny (ověřeno pollováním po 1 s). Data tedy nejsou starší než tohle.
 */
export const LIVE_CACHE_MS = 11_500;

/**
 * Kdy server live listing vygeneroval (epoch ms) – to je správné `fetchedAt`, ne okamžik odpovědi.
 * Horní odhad stáří: max(LiveUpdateTimestamp) ≤ vygenerování (u desítek živých zápasů prakticky
 * rovno), a zároveň vygenerování ≥ start dotazu − TTL cache. Nikdy nevrací čerstvější čas, než je
 * skutečnost, a nikdy čas po odpovědi.
 */
export function liveGeneratedAt(matches: BetxMatch[], requestedAt: number, receivedAt: number): number {
  let max = 0;
  for (const m of matches) {
    const t = Date.parse(m.LiveUpdateTimestamp ?? '');
    if (Number.isFinite(t) && t > max) max = t;
  }
  return Math.min(receivedAt, Math.max(max, requestedAt - LIVE_CACHE_MS));
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
    // „Začne brzy“ (LB_*_NOTSTARTED, LiveStatusString NotStarted): zápas ještě nezačal, byť je v live listingu
    if (o.live && (/^notstarted$/i.test(m.LiveStatusString ?? '') || /_NOTSTARTED$/i.test(m.LiveMatchTimeOrigName ?? ''))) continue;
    // IsLiveMatchAvailable=false: web zápas v live skryje (vsadit nejde)
    const blocked =
      !!m.IsBlocked ||
      (o.live && (!!m.LiveIsBlocked || !!m.LiveIsDisabled || m.LiveBettingEnabled === false || m.IsLiveMatchAvailable === false));
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

// ---------------------------------------------------------------- SignalR push

/** Kurz v push zprávě: n = název, on = původní název ("1", "x", "o", "under"…), o = kurz, a = aktivní. */
export interface BetxPushOdd {
  Id?: number;
  n?: string;
  on?: string;
  o: number;
  a?: boolean;
}

/** Nabídka v push zprávě (zkrácená pole: bt = BetTypeKey, sbv = linie, a = Active, e = IsEnabled). */
export interface BetxPushOffer {
  Id?: number;
  d?: string;
  sbv?: string | null;
  bt?: string;
  a?: boolean;
  e?: boolean;
  odds?: BetxPushOdd[] | null;
}

/**
 * Položka zprávy liveUpdated (RegisterMatches([sportId]) + RegisterSportBetType(sportId, bt, true)).
 * Nese vždy celý stav zápasu: stav hry, BasicOffer (bo) a nabídku registrovaného typu (cofs) –
 * ale ne týmy, soutěž ani začátek (ty jsou jen v listingu).
 */
export interface BetxPushMatch {
  Id: number;
  sid: number;
  lms?: number | null;
  lmt?: string | null;
  lmts?: string | null;
  lmto?: string | null;
  lmsc?: string | null;
  lssc?: string | null;
  lgsc?: string | null;
  lma?: boolean;
  b?: boolean;
  bo?: BetxPushOffer | null;
  ofs?: BetxPushOffer[] | null;
  cofs?: BetxPushOffer[] | null;
}

interface PushBetType {
  market: number;
  spec?: 'total' | 'hcp';
  /** OrigName (malými písmeny) -> UOF id výsledku. */
  outcomes: Record<string, number>;
}

const X12 = { '1': 1, x: 2, '2': 3 };
const WIN = { '1': 4, '2': 5 };
const HCP = { '1': 1714, '2': 1715 };
const OU_SHORT = { o: 12, u: 13 };
const OU_LONG = { over: 12, under: 13 };

/**
 * "sportId|BetTypeKey" -> UOF trh. Jen typy ověřené proti UofKey v live listingu 30. 9. 2026
 * (test "push tabulka odpovídá UofKey" + checkPushTable() za běhu). Pozor na podobně vypadající
 * trhy, které se mapovat NESMÍ: 6_4 "Vyhraje zbytek zápasu", 6_13 "Další gól", 4_-1 evropský
 * handicap (vše 1/x/2), basket 7_34 handicap bez prodloužení vs 7_38 vč. prodloužení.
 */
export const PUSH_BET_TYPES: Record<string, PushBetType> = {
  '388|2_-1': { market: 1, outcomes: X12 }, // fotbal 1X2
  '388|5_-1': { market: 18, spec: 'total', outcomes: OU_SHORT }, // fotbal počet gólů
  '398|2_-1': { market: 1, outcomes: X12 }, // hokej 1X2 (základní doba)
  '398|5_-1': { market: 18, spec: 'total', outcomes: OU_SHORT }, // hokej počet gólů (základní doba)
  '398|7_106': { market: 406, outcomes: WIN }, // hokej vítěz vč. prodloužení a nájezdů
  '398|8_1140': { market: 412, spec: 'total', outcomes: OU_LONG }, // hokej počet gólů vč. prodl. a nájezdů
  '398|7_1142': { market: 410, spec: 'hcp', outcomes: HCP }, // hokej handicap vč. prodl. a nájezdů
  '391|2_-1': { market: 1, outcomes: X12 }, // basket 1X2 (základní doba)
  '391|7_37': { market: 219, outcomes: WIN }, // basket vítěz vč. prodloužení
  '391|7_38': { market: 223, spec: 'hcp', outcomes: HCP }, // basket handicap vč. prodloužení
  '391|8_39': { market: 225, spec: 'total', outcomes: OU_LONG }, // basket počet bodů vč. prodloužení
  '389|7_10': { market: 186, outcomes: WIN }, // tenis vítěz zápasu
  '389|7_922': { market: 187, spec: 'hcp', outcomes: HCP }, // tenis handicap gemy
  '389|8_83': { market: 189, spec: 'total', outcomes: OU_LONG }, // tenis počet gemů
  '417|7_102': { market: 186, outcomes: WIN }, // stolní tenis vítěz zápasu (live BasicOffer)
  '397|7_102': { market: 186, outcomes: WIN }, // volejbal vítěz zápasu (live BasicOffer, UofKey 23/186)
  '394|7_37': { market: 251, outcomes: WIN }, // baseball vítěz vč. extra směn (live BasicOffer)
};

const normName = (s: string | undefined): string => (s ?? '').trim().toLowerCase();

/** UofKey poskládaný z push dat; undefined = neznámý typ/výsledek (kurz se přeskočí). */
export function pushUofKey(sportId: number, bt: string | undefined, origName: string | undefined, sbv: string | null | undefined): string | undefined {
  const def = PUSH_BET_TYPES[`${sportId}|${bt}`];
  const sr = SR_SPORT[sportId];
  if (!def || sr === undefined) return undefined;
  const outcome = def.outcomes[normName(origName)];
  if (outcome === undefined) return undefined;
  if (!def.spec) return `uof:1/sr:sport:${sr}/${def.market}/${outcome}`;
  const line = (sbv ?? '').trim();
  if (!/^[+-]?\d+(\.\d+)?$/.test(line)) return undefined;
  return `uof:1/sr:sport:${sr}/${def.market}/${outcome}?${def.spec}=${line}`;
}

/** Push nabídka -> BetxOffer se složenými UofKey (dál stejné parsování jako listing). */
export function pushOffer(sportId: number, of: BetxPushOffer): BetxOffer {
  return {
    Id: of.Id,
    Description: of.d,
    BetTypeKey: of.bt,
    Sbv: of.sbv ?? null,
    Active: of.a,
    IsEnabled: of.e,
    Odds: (of.odds ?? []).map((o) => ({ Name: o.n, OrigName: o.on, Odd: o.o, Active: o.a, UofKey: pushUofKey(sportId, of.bt, o.on, of.sbv) })),
  };
}

/**
 * Statická data zápasu z listingu + aktuální push stav -> BetxMatch pro parseBetxMatches().
 * Trhy jen z push (bo + nabídky registrovaných typů); stav hry z push. LiveStatusString z listingu
 * se záměrně nepřebírá (byl by až ~40 s starý a "paused" by držel přestávku i po jejím konci).
 * `blocked` = spojení hlásí liveStatus 0 (web pak zamkne všechny live kurzy).
 */
export function mergePush(info: BetxMatch, p: BetxPushMatch, extra: BetxPushOffer[], blocked = false): BetxMatch {
  const offers = [...(p.bo ? [p.bo] : []), ...extra].map((of) => pushOffer(info.SportId, of));
  return {
    Id: info.Id,
    Description: info.Description,
    TeamHome: info.TeamHome,
    TeamAway: info.TeamAway,
    MatchStartTime: info.MatchStartTime,
    SportId: info.SportId,
    CategoryName: info.CategoryName,
    LeagueName: info.LeagueName,
    EventType: info.EventType,
    LiveIsBlocked: info.LiveIsBlocked,
    LiveIsDisabled: info.LiveIsDisabled,
    LiveBettingEnabled: info.LiveBettingEnabled,
    IsBlocked: blocked || !!p.b,
    IsLiveMatchAvailable: p.lma ?? info.IsLiveMatchAvailable,
    LiveMatchState: p.lms,
    LiveMatchTime: p.lmt,
    LiveMatchTimeState: p.lmts,
    LiveMatchTimeOrigName: p.lmto,
    LiveMatchScore: p.lmsc,
    LiveSetScore: p.lssc,
    LiveGameScore: p.lgsc,
    BasicOffer: null,
    Offers: offers,
  };
}

/** Stav jednoho SignalR spojení (1 sport + nanejvýš 1 registrovaný BetTypeKey). */
export interface PushConnState {
  sid: number;
  bt?: string;
  /** liveStatus z hubu; false = web zamkne všechny live kurzy. */
  live: boolean;
  /** Poslední push stav zápasů z tohoto spojení (t = kdy přišel). */
  items: Map<number, { t: number; x: BetxPushMatch }>;
}

/**
 * Aktuální stav všech živých zápasů z push spojení: stav hry + BasicOffer z nejčerstvější zprávy
 * (kterékoli zdravé spojení sportu), nabídky registrovaných typů jen ze spojení, které je registruje.
 * Zápas bez statických dat (listing ho ještě nezná) nebo bez zdravého spojení se vynechá – nikdy se
 * nevydávají kurzy, za které živé spojení neručí. `bad` = typy vyřazené checkPushTable().
 */
export function pushSnapshot(
  statics: Map<number, BetxMatch>,
  conns: PushConnState[],
  bad: Set<string>,
  healthy: (c: PushConnState) => boolean,
): BetxMatch[] {
  const out: BetxMatch[] = [];
  for (const [id, m] of statics) {
    const cs = conns.filter((c) => c.sid === m.SportId && healthy(c));
    if (!cs.length) continue;
    let base: { t: number; x: BetxPushMatch } | undefined;
    for (const c of cs) {
      const it = c.items.get(id);
      if (it && (!base || it.t > base.t)) base = it;
    }
    if (!base) continue; // push o zápasu (zatím) neví
    const extra: BetxPushOffer[] = [];
    for (const c of cs) {
      if (!c.bt || bad.has(`${c.sid}|${c.bt}`)) continue;
      for (const of of c.items.get(id)?.x.cofs ?? []) if (of.bt === c.bt) extra.push(of);
    }
    const bo = base.x.bo && !bad.has(`${m.SportId}|${base.x.bo.bt}`) ? base.x.bo : null;
    out.push(mergePush(m, { ...base.x, bo }, extra, cs.some((c) => !c.live)));
  }
  return out;
}

/**
 * Kontrola PUSH_BET_TYPES proti UofKey v listingu (ten je nese): vrací klíče "sportId|bt", u kterých
 * by push mapování dalo jiný UOF trh / výsledek / linii (nebo UofKey nese další specifikátory).
 * Takové typy se v push nesmí použít.
 */
export function checkPushTable(matches: BetxMatch[]): string[] {
  const bad = new Set<string>();
  for (const m of matches)
    for (const of of [m.BasicOffer, ...(m.Offers ?? [])]) {
      if (!of?.BetTypeKey) continue;
      const k = `${m.SportId}|${of.BetTypeKey}`;
      if (!PUSH_BET_TYPES[k]) continue;
      for (const o of of.Odds ?? []) {
        if (!o.UofKey) continue;
        const want = parseUofKey(o.UofKey);
        const got = parseUofKey(pushUofKey(m.SportId, of.BetTypeKey, o.OrigName, of.Sbv));
        const same =
          !!want &&
          !!got &&
          want.market === got.market &&
          want.outcome === got.outcome &&
          Object.keys(want.specs).length === Object.keys(got.specs).length &&
          Object.entries(want.specs).every(([s, v]) => got.specs[s] !== undefined && Number(got.specs[s]) === Number(v));
        if (!same) bad.add(k);
      }
    }
  return [...bad];
}

// ---------------------------------------------------------------- herní stav

function pair(s: string | null | undefined): [number, number] | undefined {
  const m = /^\s*(\d+)\s*:\s*(\d+)\s*$/.exec(s ?? '');
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}

/**
 * Herní stav z live listingu / push. Přestávky: LiveStatusString "paused" (jen listing) +
 * LiveMatchTimeOrigName "*_PAUSED", "LB_BASKETBALL_PAUSE1..3", "*_AWAITING_OT" + text "Přestávka".
 * Perioda z OrigName (LB_SOCCER_2P, LB_ICE_HOCKEY_2P, LB_BASKETBALL_3Q, LB_TENNIS_3SET…), jinak počet
 * dosavadních dílčích skóre. Konec: "*_ENDED", "*_AFTER_OT", skreč/bez boje, LiveMatchState 2.
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
  const finished =
    status === 'ended' ||
    m.LiveMatchState === 2 ||
    /_(ENDED|AFTER_OT|AFTER_PEN|RETIRED|WALKOVER|ABANDONED)$/.test(orig) ||
    /konec|skreč|bez boje/i.test(text);
  if (finished) st.finished = true;
  const isBreak =
    status === 'paused' || /PAUSE|HALFTIME|HALF_TIME|BREAK|INTERMISSION|AWAITING/.test(orig) || /přestávk|poločasová/i.test(text);
  if (isBreak && !finished) st.breakFlag = true;
  // LB_BASEBALL_3IT / _3IB = horní / dolní polovina 3. směny
  const pm = /_(\d+)(?:P|Q|SET|H|IT|IB)$/.exec(orig) ?? /(\d+)\.\s*(?:poločas|třetina|čtvrtina|set|směna)/i.exec(text);
  if (pm) st.period = Number(pm[1]);
  else if (!finished && periodScores.length) st.period = periodScores.length;
  if (sport === 'tennis') {
    const cur = periodScores[periodScores.length - 1];
    if (cur) st.games = cur;
    const pts = /^\s*(\w+)\s*:\s*(\w+)\s*$/.exec(m.LiveGameScore ?? '');
    if (pts) st.points = `${pts[1]}:${pts[2]}`;
  } else if (!finished) {
    // LiveMatchTime = odehrané minuty zápasu (fotbal 45 v HT, hokej 20 v 1. přestávce, basket
    // 23 = 3. minuta 3. čtvrtiny FIBA, 20 o poločasové přestávce) – herní čas, ne odpočet periody
    const min = Number(m.LiveMatchTime);
    if (m.LiveMatchTime && Number.isFinite(min) && min >= 0 && min <= 240) st.clockSec = min * 60;
  }
  return st;
}
