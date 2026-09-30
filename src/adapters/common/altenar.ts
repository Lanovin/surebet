// Altenar widget API (sb2frontend-altenar2.biahosted.com) – sdílené čisté parsování pro sázkovky
// na platformě Altenar (Kingsbet, MerkurXtip). Obě integrace dostávají stejný Sportradar feed:
// market.typeId = UOF id trhu, odd.typeId = UOF id výsledku (mapování v ./uof.ts). Liší se nabídkou,
// maržemi a tím, jak web kurz zobrazí a s jakým počítá tiket (AltenarSite.rounding).
//
// Pasti ověřené na živých datech (30. 9. 2026):
//  * live listing posílá místo zavřeného hlavního trhu náhradní trh „N. gól“ se STEJNÝM typeId
//    (1 = 1X2) a příznakem isAlt → nikdy nemapovat (dřív z něj vznikaly falešné live arby 1X2);
//  * event.status 5 = pozastaveno (i celé hodiny po konci zápasu s „otevřenými“ kurzy) → trhy zavřené;
//  * market.sv NENÍ vždy v abecedním pořadí specifikátorů (basket 236: "40.5|1" = total|čtvrtina) →
//    číslo periody se bere z názvu trhu, linie z odd.sv (detail) nebo z market.sv (listing);
//  * detail obsahuje čtvrtinové linie (±0.25, 2.75 …) = dělené sázky → vynechat;
//  * odpovědi cachuje CDN (max-age=3, hlavička Age) → fetchedAt = čas požadavku − Age.
import { marketKey, normLine } from '../../core/markets.js';
import type { BookmakerId, GameState, MarketScope, RawEvent, RawMarket, RawSelection, Sport } from '../../core/types.js';
import { isVirtualName, uofDef, uofSelection } from './uof.js';

export const ALTENAR_API = 'https://sb2frontend-altenar2.biahosted.com/api/widget/';

/** Kanonický sport -> Altenar sportId (GetSportMenu; e-sporty 145–148 se ignorují). */
export const ALTENAR_SPORT_IDS: Partial<Record<Sport, number>> = {
  football: 66,
  tennis: 68,
  basketball: 67,
  hockey: 70,
  handball: 73,
  volleyball: 69,
  american_football: 75,
  baseball: 76,
  boxing: 71,
  mma: 84,
  snooker: 81,
  table_tennis: 77,
  darts: 78,
};
const ID_TO_SPORT: Record<number, Sport> = Object.fromEntries(Object.entries(ALTENAR_SPORT_IDS).map(([s, id]) => [id, s as Sport]));

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
  name?: string;
  sv?: string;
  oddIds?: number[];
  desktopOddIds?: number[][];
  mobileOddIds?: number[][];
  /** náhradní trh, který web ukazuje ve sloupci zavřeného hlavního trhu (např. „5. gól“ místo 1X2) */
  isAlt?: boolean;
  /** kopie trhu pro BetBuilder (podmnožina linií) */
  isBB?: boolean;
}

export interface AltTimer {
  playtime?: number;
  timeUtc?: string;
  isPaused?: boolean;
  isTimerCountDown?: boolean;
  matchPhase?: number;
  duration?: number;
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
  /** 0 = nezačal, 1 = hraje se, 5 = pozastaveno */
  status?: number;
  /** 0 = zápas, jinak outright/speciál */
  et?: number;
  liveTime?: string;
  ls?: string;
  score?: number[];
  currentSetScore?: number[];
  pointScore?: string[];
  timer?: AltTimer;
}

/** Odpověď GetEvents / GetLiveEvents / GetEventsById (normalizované pole entit). */
export interface AltListResponse {
  events?: AltEvent[];
  markets?: AltMarket[];
  odds?: AltOdd[];
  competitors?: { id: number; name: string }[];
  champs?: { id: number; name: string }[];
  categories?: { id: number; name: string }[];
}

/** Odpověď GetEventDetails (jedna událost, všechny trhy). */
export interface AltDetailResponse {
  id: number;
  name: string;
  et?: number;
  startDate: string;
  sport?: { id: number; name?: string };
  champ?: { id: number; name: string };
  category?: { id: number; name: string };
  competitors?: { id: number; name: string }[];
  markets?: AltMarket[];
  childMarkets?: AltMarket[];
  odds?: AltOdd[];
}

/** Konfigurace jedné sázkovky na platformě Altenar. */
export interface AltenarSite {
  bookmaker: BookmakerId;
  integration: string;
  origin: string;
  /**
   * Jaký kurz vidí uživatel na webu (ověřeno Playwrightem, 30. 9. 2026):
   *  'round' – web i tiket počítají s cenou zaokrouhlenou na 2 místa (Kingsbet: 2.8572 → 2.86, výhra 286.00 ze 100);
   *  'floor' – web cenu ořízne (MerkurXtip: 2.1667 → 2.16), tiket pak počítá s přesnou 2.1667 →
   *            oříznutá hodnota odpovídá webu a výplatu nikdy nenadhodnotí.
   */
  rounding: 'round' | 'floor';
  eventUrl(e: Pick<AltEvent, 'id' | 'sportId' | 'catId' | 'champId'>): string;
}

// ---------- kurzy ----------

/** Kurz tak, jak ho ukazuje web sázkovky (2 desetinná místa); undefined = neplatný/žádný kurz. */
export function sitePrice(price: unknown, rounding: AltenarSite['rounding']): number | undefined {
  const p = typeof price === 'number' ? price : Number(price);
  if (!Number.isFinite(p) || p <= 1) return undefined;
  // epsilon kvůli binární reprezentaci (1.575 * 100 = 157.49999…)
  const cents = rounding === 'round' ? Math.round(p * 100 + 1e-7) : Math.floor(p * 100 + 1e-6);
  const odds = cents / 100;
  return odds >= 1.01 && odds <= 1000 ? odds : undefined;
}

// ---------- trhy ----------

/** prodloužení / nájezdy / extra směny (baseball) – trh zahrnuje víc než základní dobu */
const OT = /prodl|nájezd|rozhodnut|extra směn/i;
/**
 * trhy, které nikdy nejsou „celý zápas / perioda“: další gól, zbytek zápasu, intervaly, závody,
 * jednotlivé směny / framy / legy / kola, „směny 1 až 5“, zlatý set …
 */
const FOREIGN =
  /\d+\.\s*gól|další gól|zbytek|zbývající|minut|interval|závod|kdo (dá|vstřelí)|první gól|poslední gól|\d+\.\s*(směn|fram|leg\b|legu|kol[oa]?\b)|směny \d|až \d|zlatý set|golden set/i;
// „1. třetina“, „Výsledek 2. třetiny“, ale i „1 třetina - dvojitá šance“ (hokejový dvojtip bez tečky)
const PERIOD_IN_NAME = /(\d+)(?:\.\s*|\s+)(poloč|třetin|čtvrtin|set)/i;
const PERIOD_KIND: Record<'PERIOD' | 'QUARTER' | 'SET', RegExp> = { PERIOD: /třetin/i, QUARTER: /čtvrtin/i, SET: /set/i };
const SCOPE_PREFIX = { PERIOD: ['P', 3], QUARTER: ['Q', 4], SET: ['S', 5] } as const;
/** Sporty, kde celozápasový (MATCH) trh musí výslovně zahrnovat prodloužení / extra směny. */
const MATCH_NEEDS_OT = new Set<Sport>(['hockey', 'basketball', 'american_football', 'baseball', 'handball']);

/** Linie x.0 / x.5 (čtvrtinové linie jsou dělené sázky – kanonický model je nemá). */
function halfLine(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const s = raw.trim().replace(',', '.');
  if (!/^[+-]?\d+(\.\d+)?$/.test(s)) return undefined;
  const v = Number(s);
  return Math.abs(v * 2 - Math.round(v * 2)) < 1e-9 ? normLine(v) : undefined;
}

/** Linie z hodnot specifikátorů ("40.5|1", "+1.5|1", "-4.5"): část, která není číslem periody. */
function lineFromSv(sv: string | undefined, periodNr: number | undefined): number | undefined {
  if (sv === undefined || sv === '') return undefined;
  const parts = sv.split('|');
  if (parts.length === 1) return halfLine(parts[0]);
  if (periodNr === undefined) return undefined;
  const i = parts.findIndex((p) => p.trim() === String(periodNr));
  if (i < 0) return undefined;
  const rest = parts.filter((_, j) => j !== i);
  return rest.length === 1 ? halfLine(rest[0]) : undefined;
}

/** Scope trhu z UOF definice + kontrola názvu (poločas/perioda/set musí sedět, prodloužení jen u MATCH). */
function scopeOf(sport: Sport, def: NonNullable<ReturnType<typeof uofDef>>, name: string): { scope: MarketScope; periodNr?: number } | undefined {
  const per = PERIOD_IN_NAME.exec(name);
  if (def.scope === 'PERIOD' || def.scope === 'QUARTER' || def.scope === 'SET') {
    if (!per || !PERIOD_KIND[def.scope].test(per[2])) return undefined;
    const n = Number(per[1]);
    const [prefix, max] = SCOPE_PREFIX[def.scope];
    if (n < 1 || n > max || OT.test(name)) return undefined;
    return { scope: `${prefix}${n}` as MarketScope, periodNr: n };
  }
  if (def.scope === 'H1' || def.scope === 'H2') {
    const want = def.scope === 'H1' ? 1 : 2;
    if (!per || !/poloč/i.test(per[2]) || Number(per[1]) !== want || OT.test(name)) return undefined;
    return { scope: def.scope };
  }
  // celý zápas: název nesmí mluvit o periodě
  if (per) return undefined;
  if (def.scope === 'REG') return OT.test(name) ? undefined : { scope: 'REG' };
  // MATCH: týmové sporty jen trhy výslovně „vč. prodloužení (a nájezdů) / extra směny“,
  // tenis, stolní tenis, volejbal, šipky, snooker celý zápas
  if (MATCH_NEEDS_OT.has(sport) && !OT.test(name)) return undefined;
  return { scope: 'MATCH' };
}

/** Všechny odd ID trhu (listing: oddIds, detail: desktopOddIds po sloupcích). */
function oddIdsOf(m: AltMarket): number[] {
  if (m.oddIds?.length) return m.oddIds;
  return (m.desktopOddIds ?? m.mobileOddIds ?? []).flat();
}

/**
 * Jeden Altenar trh → 0..n kanonických trhů (detail má víc linií v jednom trhu, každý kurz nese
 * vlastní odd.sv = linie; u handicapu je to vždy linie domácích, i u kurzu hostů).
 * `closed` = událost je pozastavená → všechny výběry zavřené.
 */
export function mapAltenarMarket(sport: Sport, m: AltMarket, odds: Map<number, AltOdd>, site: Pick<AltenarSite, 'rounding'>, closed = false): RawMarket[] {
  if (m.isAlt) return [];
  const def = uofDef(sport, m.typeId);
  if (!def) return [];
  const name = (m.name ?? '').trim();
  if (FOREIGN.test(name)) return [];
  if (def.name && !def.name.test(name)) return []; // jiná jednotka, než UOF id v tomhle sportu znamená
  const sc = scopeOf(sport, def, name);
  if (!sc) return [];
  const hasLine = def.specs.includes('hcp') || def.specs.includes('total');
  const groups = new Map<string, { line?: number; sels: RawSelection[] }>();
  for (const id of new Set(oddIdsOf(m))) {
    const o = odds.get(id);
    if (!o) continue;
    const key = uofSelection(def.type, o.typeId);
    if (!key) return []; // neznámý výsledek (např. „Nikdo“) → trh má jiný význam, celý pryč
    let line: number | undefined;
    if (hasLine) {
      line = o.sv !== undefined && o.sv !== '' ? lineFromSv(o.sv, sc.periodNr) : lineFromSv(m.sv, sc.periodNr);
      if (line === undefined) continue; // čtvrtinová / nečitelná linie
      if (def.type.startsWith('OU') && line < 0) continue;
    }
    const price = sitePrice(o.price, site.rounding);
    if (price === undefined) continue; // zavřený výběr bez kurzu (price 0/1)
    const g = groups.get(String(line)) ?? { line, sels: [] };
    groups.set(String(line), g);
    if (g.sels.some((s) => s.key === key)) continue; // první výskyt vyhrává
    const open = !closed && (o.oddStatus ?? 0) === 0;
    g.sels.push({ key, odds: price, ...(open ? {} : { open: false }), ...(o.name ? { rawName: o.name } : {}) });
  }
  const out: RawMarket[] = [];
  for (const g of groups.values()) {
    if (!g.sels.length) continue;
    const rm: RawMarket = {
      key: marketKey(def.type, sc.scope, g.line),
      open: g.sels.some((s) => s.open !== false),
      selections: g.sels,
      sourceId: g.line === undefined ? String(m.id) : `${m.id}:${g.line}`,
    };
    if (name) rm.rawName = name;
    out.push(rm);
  }
  return out;
}

function collect(sport: Sport, marketIds: Iterable<number>, markets: Map<number, AltMarket>, odds: Map<number, AltOdd>, site: Pick<AltenarSite, 'rounding'>, closed: boolean): RawMarket[] {
  const out: RawMarket[] = [];
  const keys = new Set<string>();
  for (const id of marketIds) {
    const m = markets.get(id);
    if (!m) continue;
    for (const rm of mapAltenarMarket(sport, m, odds, site, closed)) {
      if (keys.has(rm.key)) continue;
      keys.add(rm.key);
      out.push(rm);
    }
  }
  return out;
}

// ---------- herní stav ----------

const BREAK_RE = /^poločas$|přestávk|pauza|^konec \d|po \d\. (třetin|čtvrtin|set)|break|half ?time|intermission/i;
const ORDINALS: Record<string, number> = { první: 1, druhá: 2, třetí: 3 };
/**
 * Sporty bez herního času (liveTime je jen „2. set“ / „3. směna“; u amerického fotbalu, MMA a boxu
 * nemáme živý vzorek, takže minutu z liveTime radši nečteme – mohla by být v periodě, ne od začátku).
 */
const UNTIMED = new Set<Sport>(['tennis', 'table_tennis', 'volleyball', 'darts', 'snooker', 'baseball', 'american_football', 'mma', 'boxing']);

/**
 * Stav z live události: `ls` (text: „1. poločas“, „Poločas“, „2. třetina“, „První přestávka“,
 * „Přestávka“, „3. čtvrtina“, „1. set“, „2. směna“), `score` (tenis, stolní tenis, volejbal,
 * šipky: sety), `currentSetScore` (gemy), `pointScore` (body), `timer` (fotbal: playtime ms
 * k okamžiku timeUtc; basket: odpočet čtvrtiny isTimerCountDown), jinak aspoň `liveTime` („24'“).
 */
export function altenarState(e: AltEvent, sport: Sport, now: number): GameState {
  const st: GameState = {};
  const text = (e.ls || e.liveTime || '').trim();
  if (text) st.statusText = text;
  const pair = (v: unknown): [number, number] | undefined =>
    Array.isArray(v) && v.length === 2 && v.every((x) => Number.isInteger(x) && x >= 0) ? [v[0], v[1]] : undefined;
  const score = pair(e.score);
  if (score) st.score = score;
  // „2. poločas“, „3. čtvrtina“, „4. set“ (i stolní tenis, volejbal, šipky), „10. směna“ (baseball)
  const per = /(\d+)\.\s*(poločas|třetin|čtvrtin|set|perioda|prodl|směn)/i.exec(text);
  const ord = /^(první|druhá|třetí)\s+přestávka/i.exec(text);
  if (per) st.period = Number(per[1]);
  else if (ord) st.period = ORDINALS[ord[1].toLowerCase()];
  else if (sport === 'football' && e.timer?.matchPhase === 3) st.period = 1;
  if (sport === 'tennis') {
    const games = pair(e.currentSetScore);
    if (games) st.games = games;
    if (Array.isArray(e.pointScore) && e.pointScore.length === 2) st.points = `${e.pointScore[0]}:${e.pointScore[1]}`;
  } else if (sport === 'table_tennis' || sport === 'volleyball') {
    // score = sety, pointScore = body v aktuálním setu. Některé ligy stolního tenisu mají body v currentSetScore
    // a pointScore 0:0 (Hruska – Dolezal: 8:2 vs. 0:0) → při neprázdném currentSetScore se body neberou (nejasné)
    if (!pair(e.currentSetScore) && Array.isArray(e.pointScore) && e.pointScore.length === 2) st.points = `${e.pointScore[0]}:${e.pointScore[1]}`;
  }
  if (BREAK_RE.test(text) || (sport === 'football' && e.timer?.matchPhase === 3)) st.breakFlag = true;
  if (/konec zápasu|ukončen|skončen|^konec$|finished|ended/i.test(text)) st.finished = true;
  const t = e.timer;
  if (t && typeof t.playtime === 'number') {
    const at = Date.parse(t.timeUtc ?? '');
    const running = t.isPaused === false;
    const drift = running && Number.isFinite(at) && now > at ? now - at : 0;
    if (t.isTimerCountDown) st.periodRemainingSec = Math.max(0, Math.min(3600, Math.round((t.playtime - drift) / 1000)));
    else st.clockSec = Math.max(0, Math.min(4 * 3600, Math.round((t.playtime + drift) / 1000)));
    st.clockRunning = running;
  } else if (!UNTIMED.has(sport)) {
    // „19'“ = běží 19. minuta; na hranici periody (konec třetiny/poločasu) ukazuje web celou minutu
    const min = /^(\d+)'/.exec(e.liveTime ?? '')?.[1];
    if (min) st.clockSec = Math.min(4 * 3600, Number(min) * 60);
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

/** Listing (GetEvents / GetLiveEvents / GetEventsById) → RawEvent[]. */
export function parseAltenarList(r: AltListResponse, site: AltenarSite, o: ParseOptions): RawEvent[] {
  const odds = new Map((r.odds ?? []).map((x) => [x.id, x]));
  const markets = new Map((r.markets ?? []).map((x) => [x.id, x]));
  const comp = new Map((r.competitors ?? []).map((x) => [x.id, x.name]));
  const champ = new Map((r.champs ?? []).map((x) => [x.id, x.name]));
  const cat = new Map((r.categories ?? []).map((x) => [x.id, x.name]));
  const live = o.scope === 'live';
  const out: RawEvent[] = [];
  const seen = new Set<number>();
  for (const e of r.events ?? []) {
    const sport = ID_TO_SPORT[e.sportId];
    if (!sport || (o.sports && !o.sports.includes(sport))) continue;
    if ((e.et ?? 0) !== 0 || e.competitorIds?.length !== 2 || seen.has(e.id)) continue;
    const home = comp.get(e.competitorIds[0])?.trim();
    const away = comp.get(e.competitorIds[1])?.trim();
    const startTime = Date.parse(e.startDate);
    if (!home || !away || !Number.isFinite(startTime)) continue;
    const competition = (e.champId !== undefined ? champ.get(e.champId) : undefined) ?? '';
    if (isVirtualName(competition, home, away)) continue;
    // prematch: už začalo → kurzy neaktuální; live: „Zápas ještě nezačal“ (status 0) do live nepatří
    if (!live && startTime <= o.now) continue;
    if (live && (e.status ?? 1) === 0) continue;
    seen.add(e.id);
    const closed = live && e.status !== undefined && e.status !== 1;
    const ev: RawEvent = {
      sourceId: String(e.id),
      sport,
      competition,
      home,
      away,
      startTime,
      live,
      markets: collect(sport, e.marketIds ?? [], markets, odds, site, closed),
      url: site.eventUrl(e),
    };
    const country = e.catId !== undefined ? cat.get(e.catId) : undefined;
    if (country) ev.country = country;
    if (live) ev.state = altenarState(e, sport, o.now);
    out.push(ev);
  }
  return out;
}

/** Trhy z GetEventDetails (hlavní + child trhy); BetBuilder kopie (isBB) jsou podmnožiny → pryč. */
export function parseAltenarDetails(d: AltDetailResponse, sport: Sport, site: Pick<AltenarSite, 'rounding'>): RawMarket[] {
  const all = [...(d.markets ?? []), ...(d.childMarkets ?? [])].filter((m) => !m.isBB);
  const byId = new Map<number, AltMarket>();
  for (const m of all) if (!byId.has(m.id)) byId.set(m.id, m);
  const odds = new Map((d.odds ?? []).map((x) => [x.id, x]));
  return collect(sport, byId.keys(), byId, odds, site, false);
}

/** Doplní události z listingu o trhy z detailu (detail je stažený později → má přednost). */
export function mergeAltenarDetails(events: RawEvent[], details: Map<string, AltDetailResponse>, site: Pick<AltenarSite, 'rounding'>): RawEvent[] {
  return events.map((e) => {
    const d = details.get(e.sourceId);
    if (!d) return e;
    const dm = parseAltenarDetails(d, e.sport, site);
    if (!dm.length) return e;
    const keys = new Set(dm.map((m) => m.key));
    return { ...e, markets: [...dm, ...e.markets.filter((m) => !keys.has(m.key))] };
  });
}
