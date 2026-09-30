// Sazka / Allwyn (OpenBet "engage" platforma) – čisté parsování odpovědí bez I/O.
//
// Zdroj dat: apigw.allwyn.cz/openbet/orchestrations/sazkaEventsDrilldownList|Detail (JSON).
// Trhy bereme v "surovém" (negroupovaném) tvaru: event.markets[] → outcomes[] → prices[].
// Scope trhu se určuje z groupCode + názvu trhu (Sazka píše "(60 minut)", "do rozhodnutí",
// "(včetně prodloužení)"), linie vždy z outcome.prices[0].handicapLow (market.handicapValue je
// u asijských trhů kódovaný index, ne linie).
import { marketKey } from '../../core/markets.js';
import type {
  GameState,
  MarketScope,
  MarketType,
  RawEvent,
  RawMarket,
  RawSelection,
  SelectionKey,
  Sport,
} from '../../core/types.js';

export const SITE = 'https://www.allwyn.cz/kurzove-sazky';

/** OpenBet drilldown ID sportu (level 2) → náš sport. Pozor: kód "hockey" je pozemní hokej. */
export const SPORT_NODES: Record<Sport, { id: string; code: string }> = {
  football: { id: '11', code: 'football' },
  tennis: { id: '12', code: 'tennis' },
  basketball: { id: '5', code: 'basketball' },
  hockey: { id: '8', code: 'ice-hockey' },
};
const CODE_TO_SPORT: Record<string, Sport> = {
  football: 'football',
  tennis: 'tennis',
  basketball: 'basketball',
  'ice-hockey': 'hockey',
};

// ---------- surové typy (jen pole, která používáme) ----------

export interface ObPrice {
  decimal: number;
  handicapLow?: string | null;
  handicapHigh?: string | null;
}
export interface ObOutcome {
  id: string;
  name: string;
  type?: string | null;
  subType?: string | null;
  active?: boolean;
  status?: string;
  displayed?: boolean;
  prices?: ObPrice[];
}
export interface ObMarket {
  id: string;
  name: string;
  groupCode: string | null;
  type?: string | null;
  subType?: string | null;
  handicapValue?: number | null;
  active?: boolean;
  status?: string;
  displayed?: boolean;
  outcomes: ObOutcome[];
}
export interface ObFact {
  type: string;
  value: string;
  participantId: string | null;
}
export interface ObClock {
  offset?: number;
  lastUpdate?: string;
  state?: string;
}
export interface ObPeriod {
  type: string;
  startTime?: string;
  periodIndex?: number | null;
  order?: number;
  clock?: ObClock;
  facts?: ObFact[];
  periods?: ObPeriod[];
  status?: string;
}
export interface ObCommentary {
  facts?: ObFact[];
  participants?: { id: string; name: string; roleCode: string }[];
  periods?: ObPeriod[];
}
export interface ObDrilldownNode {
  id: string;
  name: string;
  code: string | null;
  levelNumber: number;
}
export interface ObEvent {
  id: string;
  name: string;
  active?: boolean;
  status?: string;
  displayed?: boolean;
  started?: boolean;
  startTime: string;
  sortCode?: string;
  liveNow?: boolean;
  resulted?: boolean;
  teams?: { name: string; side: string }[];
  commentary?: ObCommentary | null;
  drilldownNodes?: ObDrilldownNode[];
  markets?: ObMarket[];
}
export interface ObEventsResponse {
  data?: { events?: ObEvent[] } | null;
  errors?: unknown[];
}

// ---------- mapování trhů ----------

type ScopeRule = MarketScope | ((m: ObMarket) => MarketScope | null);
interface Rule {
  type: MarketType;
  scope: ScopeRule;
}

const nth = (re: RegExp, prefix: 'P' | 'S' | 'Q') => (m: ObMarket): MarketScope | null => {
  const n = re.exec(m.name)?.[1];
  if (!n) return null;
  const s = `${prefix}${n}`;
  const max = prefix === 'P' ? 3 : prefix === 'Q' ? 4 : 5;
  return Number(n) >= 1 && Number(n) <= max ? (s as MarketScope) : null;
};

/** Číslo třetiny kdekoli v názvu ("Oba dají gól 2. třetina"). */
const periodAnywhere = nth(/(\d)\.\s*třetin/i, 'P');

/** Hokej/basket: rozsah podle textu v názvu trhu, jinak fallback (nebo null = přeskoč). */
const byName = (fallback: MarketScope | null) => (m: ObMarket): MarketScope | null => {
  const n = m.name.toLowerCase();
  if (/do rozhodnut|včetně prodl|vč\. prodl|including ot/.test(n)) return 'MATCH';
  if (/60 minut|základní hrací dob|bez prodl/.test(n)) return 'REG';
  return fallback;
};

const RULES: Record<Sport, Record<string, Rule>> = {
  football: {
    MATCH_RESULT: { type: '1X2', scope: 'REG' },
    NO_BET_DRAW: { type: 'DNB', scope: 'REG' },
    'TOTAL_GOALS_OVER/UNDER': { type: 'OU', scope: 'REG' },
    'TOTAL_GOALS_OVER/UNDER_ASIAN': { type: 'OU', scope: 'REG' },
    ASIAN_HANDICAP: { type: 'AH', scope: 'REG' },
    BOTH_TEAMS_TO_SCORE: { type: 'BTTS', scope: 'REG' },
    'TOTAL_GOALS_OVER/UNDER_HOME': { type: 'OU_HOME', scope: 'REG' },
    'TOTAL_GOALS_OVER/UNDER_AWAY': { type: 'OU_AWAY', scope: 'REG' },
    MATCH_RESULT_1ST_HALF: { type: '1X2', scope: 'H1' },
    MATCH_RESULT_2ND_HALF: { type: '1X2', scope: 'H2' },
    NO_BET_DRAW_1ST_HALF: { type: 'DNB', scope: 'H1' },
    NO_BET_DRAW_2ND_HALF: { type: 'DNB', scope: 'H2' },
    'TOTAL_GOALS_OVER/UNDER_1ST_HALF': { type: 'OU', scope: 'H1' },
    'TOTAL_GOALS_OVER/UNDER_2ND_HALF': { type: 'OU', scope: 'H2' },
    'TOTAL_GOALS_OVER/UNDER_ASIAN_1ST_HALF': { type: 'OU', scope: 'H1' },
    'TOTAL_GOALS_OVER/UNDER_ASIAN_2ND_HALF': { type: 'OU', scope: 'H2' },
    ASIAN_HANDICAP_1ST_HALF: { type: 'AH', scope: 'H1' },
    ASIAN_HANDICAP_2ND_HALF: { type: 'AH', scope: 'H2' },
    BOTH_TEAMS_TO_SCORE_1ST_HALF: { type: 'BTTS', scope: 'H1' },
    BOTH_TEAMS_TO_SCORE_2ND_HALF: { type: 'BTTS', scope: 'H2' },
    'TOTAL_GOALS_OVER/UNDER_1ST_HALF_HOME': { type: 'OU_HOME', scope: 'H1' },
    'TOTAL_GOALS_OVER/UNDER_1ST_HALF_AWAY': { type: 'OU_AWAY', scope: 'H1' },
    'TOTAL_GOALS_OVER/UNDER_2ND_HALF_HOME': { type: 'OU_HOME', scope: 'H2' },
    'TOTAL_GOALS_OVER/UNDER_2ND_HALF_AWAY': { type: 'OU_AWAY', scope: 'H2' },
    // MATCH_RESULT_2 = "Mega kurz (3+ ako)" – jen do AKO, vynecháno záměrně
  },
  hockey: {
    MATCH_RESULT_NO_OVERTIME: { type: '1X2', scope: 'REG' },
    MATCH_RESULT: { type: '1X2', scope: 'REG' }, // 3-cestný výsledek je v hokeji vždy po 60'
    MONEY_LINE: { type: 'ML', scope: byName('MATCH') },
    DRAW_NO_BET: { type: 'DNB', scope: 'REG' },
    'TOTAL_GOALS_OVER/UNDER': { type: 'OU', scope: byName(null) },
    'TOTAL_GOALS_OVER/UNDER_NO_OT': { type: 'OU', scope: 'REG' },
    'TOTAL_GOALS_OVER/UNDER_INC_OT_PENS': { type: 'OU', scope: 'MATCH' },
    HANDICAP_2_WAY: { type: 'AH', scope: byName(null) },
    HANDICAP_2_WAY_INC_OT_PENS: { type: 'AH', scope: 'MATCH' },
    TOTAL_HOME_GOALS_OVER_UNDER: { type: 'OU_HOME', scope: byName(null) },
    TOTAL_AWAY_GOALS_OVER_UNDER: { type: 'OU_AWAY', scope: byName(null) },
    TOTAL_HOME_GOALS_OVER_UNDER_INC_OT_PENS: { type: 'OU_HOME', scope: 'MATCH' },
    TOTAL_AWAY_GOALS_OVER_UNDER_INC_OT_PENS: { type: 'OU_AWAY', scope: 'MATCH' },
    MATCH_RESULT_3_WAY_1ST_PERIOD: { type: '1X2', scope: 'P1' },
    MATCH_RESULT_3_WAY_2ND_PERIOD: { type: '1X2', scope: 'P2' },
    MATCH_RESULT_3_WAY_3RD_PERIOD: { type: '1X2', scope: 'P3' },
    'TOTAL_GOALS_OVER/UNDER_FIRST_PERIOD': { type: 'OU', scope: 'P1' },
    'TOTAL_GOALS_OVER/UNDER_SECOND_PERIOD': { type: 'OU', scope: 'P2' },
    'TOTAL_GOALS_OVER/UNDER_THIRD_PERIOD': { type: 'OU', scope: 'P3' },
    HANDICAP_2_WAY_FIRST_PERIOD: { type: 'AH', scope: 'P1' },
    HANDICAP_2_WAY_SECOND_PERIOD: { type: 'AH', scope: 'P2' },
    HANDICAP_2_WAY_THIRD_PERIOD: { type: 'AH', scope: 'P3' },
    DRAW_NO_BET_NTH_PERIOD: { type: 'DNB', scope: nth(/^\s*(\d)\.\s*třetin/i, 'P') },
    BOTH_TEAMS_TO_SCORE_NTH_PERIOD: { type: 'BTTS', scope: nth(/^\s*(\d)\.\s*třetin/i, 'P') },
    // live šablony třetin: "2. třetina: vítěz" (3 výběry bez subType), "2. třetina: handicap 0.5",
    // "Oba dají gól 2. třetina" – vše jen góly dané třetiny
    PERIOD_WINNER_NTH_PERIOD: { type: '1X2', scope: nth(/^\s*(\d)\.\s*třetin/i, 'P') },
    PERIOD_HANDICAP_2_WAY_NTH_PERIOD: { type: 'AH', scope: nth(/^\s*(\d)\.\s*třetin/i, 'P') },
    BOTH_TEAMS_TO_SCORE_CURRENT_PERIOD: { type: 'BTTS', scope: periodAnywhere },
    'PERIOD_GOALS_OVER/UNDER_HOME_TEAM_FIRST_PERIOD': { type: 'OU_HOME', scope: 'P1' },
    'PERIOD_GOALS_OVER/UNDER_HOME_TEAM_SECOND_PERIOD': { type: 'OU_HOME', scope: 'P2' },
    'PERIOD_GOALS_OVER/UNDER_HOME_TEAM_THIRD_PERIOD': { type: 'OU_HOME', scope: 'P3' },
    'PERIOD_GOALS_OVER/UNDER_AWAY_TEAM_FIRST_PERIOD': { type: 'OU_AWAY', scope: 'P1' },
    'PERIOD_GOALS_OVER/UNDER_AWAY_TEAM_SECOND_PERIOD': { type: 'OU_AWAY', scope: 'P2' },
    'PERIOD_GOALS_OVER/UNDER_AWAY_TEAM_THIRD_PERIOD': { type: 'OU_AWAY', scope: 'P3' },
    // BOTH_TEAMS_TO_SCORE (celý zápas) – nejasné, zda vč. prodloužení → vynecháno
  },
  basketball: {
    MONEY_LINE: { type: 'ML', scope: byName('MATCH') },
    MATCH_RESULT: { type: '1X2', scope: 'REG' },
    HANDICAP_2_WAY: { type: 'AH', scope: byName(null) },
    'TOTAL_POINTS_OVER/UNDER': { type: 'OU', scope: byName(null) },
    'TOTAL_POINTS_OVER/UNDER_HOME': { type: 'OU_HOME', scope: byName(null) },
    'TOTAL_POINTS_OVER/UNDER_AWAY': { type: 'OU_AWAY', scope: byName(null) },
    MATCH_RESULT_1ST_HALF: { type: '1X2', scope: 'H1' },
    'TOTAL_POINTS_OVER/UNDER_1ST_HALF': { type: 'OU', scope: 'H1' },
    HANDICAP_2_WAY_1ST_HALF: { type: 'AH', scope: 'H1' },
    MATCH_RESULT_1ST_QUARTER: { type: '1X2', scope: 'Q1' },
    MATCH_RESULT_2ND_QUARTER: { type: '1X2', scope: 'Q2' },
    MATCH_RESULT_3RD_QUARTER: { type: '1X2', scope: 'Q3' },
    MATCH_RESULT_4TH_QUARTER: { type: '1X2', scope: 'Q4' },
    'TOTAL_POINTS_OVER/UNDER_1ST_QUARTER': { type: 'OU', scope: 'Q1' },
    'TOTAL_POINTS_OVER/UNDER_2ND_QUARTER': { type: 'OU', scope: 'Q2' },
    'TOTAL_POINTS_OVER/UNDER_3RD_QUARTER': { type: 'OU', scope: 'Q3' },
    HANDICAP_2_WAY_1ST_QUARTER: { type: 'AH', scope: 'Q1' },
    HANDICAP_2_WAY_2ND_QUARTER: { type: 'AH', scope: 'Q2' },
    HANDICAP_2_WAY_3RD_QUARTER: { type: 'AH', scope: 'Q3' },
    // 4. čtvrtina OU/AH vynechána: nejisté, zda nezahrnuje prodloužení; 2. poločas (H2) taktéž
  },
  tennis: {
    MATCH_WINNER: { type: 'ML', scope: 'MATCH' },
    'TOTAL_GAMES_OVER/UNDER': { type: 'OU', scope: 'MATCH' },
    GAME_HANDICAP: { type: 'AH', scope: 'MATCH' },
    SET_HANDICAP: { type: 'AH_SETS', scope: 'MATCH' },
    'TOTAL_SETS_OVER/UNDER': { type: 'OU_SETS', scope: 'MATCH' },
    'TOTAL_GAMES_OVER/UNDER_HOME': { type: 'OU_HOME', scope: 'MATCH' },
    'TOTAL_GAMES_OVER/UNDER_AWAY': { type: 'OU_AWAY', scope: 'MATCH' },
    SET_WINNER_FIRST_SET: { type: 'ML', scope: 'S1' },
    SET_WINNER_NTH_SET: { type: 'ML', scope: nth(/^\s*Set\s*(\d)\b/i, 'S') },
    'TOTAL_GAMES_OVER/UNDER_NTH_SET': { type: 'OU', scope: nth(/^\s*Set\s*(\d)\b/i, 'S') },
    GAME_HANDICAP_NTH_SET: { type: 'AH', scope: nth(/^\s*Set\s*(\d)\b/i, 'S') },
  },
};

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

function outcomeOpen(o: ObOutcome): boolean {
  return o.active !== false && (o.status === undefined || o.status === 'ACTIVE');
}

function priceOf(o: ObOutcome): ObPrice | undefined {
  return o.prices?.[0];
}

/** Linie z outcome: handicapLow === handicapHigh, jinak (dělená asijská linie) undefined. */
function outcomeLine(o: ObOutcome): number | undefined {
  const p = priceOf(o);
  if (!p || p.handicapLow == null) return undefined;
  const lo = Number(p.handicapLow);
  const hi = p.handicapHigh == null ? lo : Number(p.handicapHigh);
  if (!Number.isFinite(lo) || lo !== hi) return undefined;
  return lo;
}

/** Jen celé a půlové linie (x.0 / x.5); čtvrtinové asijské linie vynecháváme. */
const isHalfOrWhole = (l: number) => Math.abs(l * 2 - Math.round(l * 2)) < 1e-9;

function sideOf(o: ObOutcome, home: string, away: string): 'HOME' | 'AWAY' | 'DRAW' | undefined {
  const st = (o.subType ?? '').toUpperCase();
  if (st === 'H') return 'HOME';
  if (st === 'A') return 'AWAY';
  if (st === 'D') return 'DRAW';
  const n = norm(o.name);
  if (n === norm(home)) return 'HOME';
  if (n === norm(away)) return 'AWAY';
  if (n === 'remiza' || n === 'x' || n === '0') return 'DRAW';
  if (n === '1') return 'HOME';
  if (n === '2') return 'AWAY';
  return undefined;
}

function overUnder(o: ObOutcome): 'OVER' | 'UNDER' | undefined {
  const st = (o.subType ?? '').toUpperCase();
  if (st === 'H') return 'OVER';
  if (st === 'L') return 'UNDER';
  const n = norm(o.name);
  if (n.startsWith('nad') || n.startsWith('vice')) return 'OVER';
  if (n.startsWith('pod') || n.startsWith('mene')) return 'UNDER';
  return undefined;
}

function yesNo(o: ObOutcome): 'YES' | 'NO' | undefined {
  const n = norm(o.name);
  if (n === 'ano') return 'YES';
  if (n === 'ne') return 'NO';
  return undefined;
}

function sel(key: SelectionKey, o: ObOutcome): RawSelection | null {
  const odds = priceOf(o)?.decimal;
  if (typeof odds !== 'number' || !Number.isFinite(odds)) return null;
  return { key, odds, open: outcomeOpen(o), rawName: o.name };
}

/**
 * Pojistka proti náhradním/odvozeným šablonám se stejným groupCode: názvy, které se nikdy nesmí
 * namapovat na kanonický trh (zbytek zápasu, další gól, "po X minutách", Mega kurz jen do AKO,
 * evropský handicap "s remízou", postup, přesný výsledek, race-to). Žádný dnes mapovaný název je
 * neobsahuje (ověřeno na live i prematch datech 30. 9. 2026).
 */
const NAME_BLACKLIST = /zbyt(?:ek|ku|kem)|zbývající|po \d+\s*minut|mega kurz|\bako\b|\d+\.\s*gól|další gól|postup|s remízou|rozstřel|přesný|první dosáhne|kdo dá/i;

/** Má groupCode pro daný sport mapovací pravidlo? (push: zprávy k nemapovaným trhům nevyžadují resync) */
export function isMappedMarketCode(sport: Sport, code: string | null | undefined): boolean {
  return !!code && !!RULES[sport][code];
}

/** Převede jeden surový trh na kanonický (nebo null, když ho neumíme přesně namapovat). */
export function mapMarket(sport: Sport, m: ObMarket, home: string, away: string): RawMarket | null {
  if (m.displayed === false || !m.groupCode) return null;
  const rule = RULES[sport][m.groupCode];
  if (!rule) return null;
  if (NAME_BLACKLIST.test(m.name)) return null;
  const scope = typeof rule.scope === 'function' ? rule.scope(m) : rule.scope;
  if (!scope) return null;
  const outs = m.outcomes.filter((o) => o.displayed !== false);
  const sels: RawSelection[] = [];
  let line: number | undefined;
  const t = rule.type;

  if (t === '1X2' || t === 'ML' || t === 'DNB') {
    const allowed: SelectionKey[] = t === '1X2' ? ['HOME', 'DRAW', 'AWAY'] : ['HOME', 'AWAY'];
    for (const o of outs) {
      const side = sideOf(o, home, away);
      if (!side || !allowed.includes(side)) return null; // neznámý výběr → trh nechápeme
      const s = sel(side, o);
      if (s) sels.push(s);
    }
    if (outs.length !== allowed.length) return null;
  } else if (t === 'OU' || t === 'OU_HOME' || t === 'OU_AWAY' || t === 'OU_SETS') {
    for (const o of outs) {
      const k = overUnder(o);
      const l = outcomeLine(o);
      if (!k || l === undefined) return null;
      if (line !== undefined && l !== line) return null;
      line = l;
      const s = sel(k, o);
      if (s) sels.push(s);
    }
    if (outs.length !== 2 || line === undefined || line < 0) return null;
  } else if (t === 'AH' || t === 'AH_SETS') {
    let homeLine: number | undefined;
    let awayLine: number | undefined;
    for (const o of outs) {
      const side = sideOf(o, home, away);
      const l = outcomeLine(o);
      if ((side !== 'HOME' && side !== 'AWAY') || l === undefined) return null;
      if (side === 'HOME') homeLine = l;
      else awayLine = l;
      const s = sel(side, o);
      if (s) sels.push(s);
    }
    if (outs.length !== 2 || homeLine === undefined || awayLine === undefined) return null;
    if (Math.abs(homeLine + awayLine) > 1e-9) return null; // linie musí být zrcadlové
    line = homeLine; // z pohledu domácích
  } else if (t === 'BTTS') {
    for (const o of outs) {
      const k = yesNo(o);
      if (!k) return null;
      const s = sel(k, o);
      if (s) sels.push(s);
    }
    if (outs.length !== 2) return null;
  } else {
    return null;
  }

  if (line !== undefined && !isHalfOrWhole(line)) return null;
  if (sels.length === 0) return null;
  const keys = new Set(sels.map((s) => s.key));
  if (keys.size !== sels.length) return null;
  const open = m.active !== false && (m.status === undefined || m.status === 'ACTIVE');
  return {
    key: marketKey(t, scope, line),
    open,
    selections: sels,
    sourceId: m.id,
    rawName: m.name,
  };
}

// ---------- herní stav ----------

const FB_ORDER = ['FIRST_HALF', 'SECOND_HALF', 'FIRST_HALF_EXTRA_TIME', 'SECOND_HALF_EXTRA_TIME', 'FIRST_OVERTIME', 'SECOND_OVERTIME', 'PENALTIES', 'PENALTIES_ET', 'PENALTY_SHOOTOUT'];
const HK_ORDER = ['PERIOD_1', 'PERIOD_2', 'PERIOD_3', 'OVERTIME', 'SHOOTOUT', 'PENALTY_SHOOTOUT'];
const BB_ORDER = ['QUARTER_1', 'QUARTER_2', 'QUARTER_3', 'QUARTER_4', 'OVERTIME'];
/** Typy period, které samy o sobě znamenají přestávku. */
const BREAK_TYPES = /HALF_TIME|BREAK/;
const FINISHED_TYPES = /^(FULL_TIME|POST_MATCH|POST_GAME)$/;

function scoreFromFacts(facts: ObFact[] | undefined, homeId?: string, awayId?: string, type = 'SCORE'): [number, number] | undefined {
  if (!facts || !homeId || !awayId) return undefined;
  const get = (pid: string) => {
    const f = facts.find((x) => x.type === type && x.participantId === pid);
    const n = f ? Number(f.value) : NaN;
    return Number.isInteger(n) && n >= 0 ? n : undefined;
  };
  const h = get(homeId);
  const a = get(awayId);
  return h === undefined || a === undefined ? undefined : [h, a];
}

function factValue(facts: ObFact[] | undefined, pid: string | undefined, type: string): string | undefined {
  if (!facts || !pid) return undefined;
  return facts.find((x) => x.type === type && x.participantId === pid)?.value;
}

const ts = (s?: string) => (s ? Date.parse(s) : NaN);
const rank = (order: string[], t: string) => (order.includes(t) ? order.indexOf(t) : 99);

/** Tenis: je set podle gemů dohraný? (6:x o 2, 7:5, 7:6) */
export function setComplete([a, b]: [number, number]): boolean {
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi >= 6 && hi - lo >= 2) || (hi === 7 && lo >= 5);
}

/** Stavy hodin, kdy čas běží (basket/hokej feed hlásí odpočet jako "COUNTING_DOWN"). */
const RUNNING_STATES = new Set(['RUNNING', 'COUNTING_DOWN', 'COUNTING_UP']);

/** Sekundy od lastUpdate, pokud hodiny běží. */
function sinceUpdate(c: ObClock | undefined, now: number): number {
  const lu = ts(c?.lastUpdate);
  return c && RUNNING_STATES.has(c.state ?? '') && Number.isFinite(lu) && now > lu ? (now - lu) / 1000 : 0;
}

/** Typické délky period (s) pro detekci "perioda vytvořená, ale ještě nezačala". */
const FULL_PERIOD: Record<string, number[]> = { hockey: [1200, 300], basketball: [600, 720, 300] };

/**
 * Herní stav z event.commentary (OpenBet). Přestávka: poslední začatá perioda je HALF_TIME /
 * *_BREAK, nebo hlavní perioda má status "FINISHED" a další ještě nezačala (logika webu –
 * breakPeriods), nebo odpočet periody stojí na 0, nebo další perioda je založená a stojí na
 * začátku. Hodiny: fotbal offset vzestupně v rámci poločasu, hokej/basket offset = zbývající čas
 * (state "COUNTING_DOWN" = běží).
 */
export function parseState(ev: ObEvent, sport: Sport, now: number): GameState | undefined {
  const c = ev.commentary;
  if (!c) return ev.resulted ? { finished: true } : undefined;
  const homeId = c.participants?.find((p) => p.roleCode === 'HOME')?.id;
  const awayId = c.participants?.find((p) => p.roleCode === 'AWAY')?.id;
  const st: GameState = {};
  const score = scoreFromFacts(c.facts, homeId, awayId);
  if (score) st.score = score;
  const periods = (c.periods ?? []).slice();

  if (sport === 'tennis') {
    const sets = periods.filter((p) => p.type === 'SET').sort((a, b) => (a.periodIndex ?? 0) - (b.periodIndex ?? 0));
    const ps: [number, number][] = [];
    for (const s of sets) {
      const sc = scoreFromFacts(s.facts, homeId, awayId);
      if (sc) ps.push(sc);
    }
    if (ps.length) st.periodScores = ps;
    const cur = sets[sets.length - 1];
    if (cur) {
      st.period = cur.periodIndex ?? sets.length;
      const g = scoreFromFacts(cur.facts, homeId, awayId);
      if (g) st.games = g;
      const games = (cur.periods ?? []).filter((p) => p.type.startsWith('GAME')).sort((a, b) => (a.periodIndex ?? 0) - (b.periodIndex ?? 0));
      const lastGame = games[games.length - 1];
      if (lastGame) {
        const hp = factValue(lastGame.facts, homeId, 'DISPLAY_SCORE');
        const ap = factValue(lastGame.facts, awayId, 'DISPLAY_SCORE');
        // "60" = gem dohrán; body pak nejsou (nový gem ještě nezačal)
        if (hp !== undefined && ap !== undefined) st.points = hp === '60' || ap === '60' ? '0:0' : `${hp}:${ap}`;
      }
      st.statusText = `SET_${st.period}`;
      // Sety nemají status FINISHED → set je dohraný podle gemů; další set ještě nezačal = přestávka.
      const maxSets = Number(c.facts?.find((f) => f.type === 'MAX_SETS')?.value) || 3;
      const won = st.score ? Math.max(...st.score) : 0;
      if (st.games && setComplete(st.games) && won < Math.ceil(maxSets / 2) && !ev.resulted) {
        st.breakFlag = true;
        st.statusText += ':FINISHED';
      }
    }
  } else {
    const order = sport === 'football' ? FB_ORDER : sport === 'hockey' ? HK_ORDER : BB_ORDER;
    // Aktuální = naposledy začatá perioda (HALF_TIME zůstává v seznamu i po začátku 2. poločasu).
    const known = periods.filter((p) => order.includes(p.type) || BREAK_TYPES.test(p.type));
    known.sort((a, b) => (ts(a.startTime) || 0) - (ts(b.startTime) || 0) || rank(order, a.type) - rank(order, b.type));
    const main = known.filter((p) => order.includes(p.type)).sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
    const cur = known[known.length - 1];
    const lastMain = main[main.length - 1];
    const ps: [number, number][] = [];
    for (const p of main) {
      const sc = scoreFromFacts(p.facts, homeId, awayId);
      if (sc) ps.push(sc);
    }
    if (ps.length) st.periodScores = ps;
    if (lastMain) st.period = order.indexOf(lastMain.type) + 1;
    if (cur && BREAK_TYPES.test(cur.type)) {
      st.statusText = cur.type;
      st.breakFlag = true;
      st.clockRunning = false;
    } else if (cur) {
      st.statusText = cur.type + (cur.status ? ':' + cur.status : '');
      const c0 = cur.clock;
      const state = c0?.state ?? '';
      const running = RUNNING_STATES.has(state);
      if (state) st.clockRunning = running;
      const offset = typeof c0?.offset === 'number' ? c0.offset : undefined;
      const d = sinceUpdate(c0, now);
      const idx = order.indexOf(cur.type);
      if (offset !== undefined) {
        if (sport === 'football') {
          // offset bývá relativní k poločasu (reálné zápasy), u některých feedů absolutní
          // (5400 po konci, e-fotbal) → vybereme variantu bližší času od startu periody.
          const base = cur.type === 'SECOND_HALF' ? 2700 : /EXTRA|OVERTIME/.test(cur.type) ? (cur.type.startsWith('SECOND') ? 6300 : 5400) : 0;
          const rel = base + offset + d;
          const abs = offset + d;
          const start = ts(cur.startTime);
          const ref = Number.isFinite(start) && now >= start ? base + (now - start) / 1000 : rel;
          const v = base > 0 && Math.abs(abs - ref) < Math.abs(rel - ref) ? abs : rel;
          st.clockSec = Math.min(4 * 3600, Math.max(0, Math.round(v)));
        } else {
          // hokej/basket: offset = zbývající čas periody (odpočet)
          st.periodRemainingSec = Math.min(3600, Math.max(0, Math.round(offset - d)));
        }
      }
      const lastRegular = sport === 'football' ? 'SECOND_HALF' : sport === 'hockey' ? 'PERIOD_3' : 'QUARTER_4';
      const isShootout = /PENALT|SHOOTOUT/.test(cur.type);
      const isOt = cur.type.startsWith('OVERTIME');
      // hokej/basket: konec základní doby (nebo prodloužení) za nerozhodného stavu → následuje
      // prodloužení/nájezdy = přestávka; s vítězem je to konec zápasu, ne přestávka
      const tiedEnd = sport !== 'football' && (cur.type === lastRegular || isOt) && !!st.score && st.score[0] === st.score[1];
      let brk = false;
      // a) perioda výslovně FINISHED a další ještě nezačala
      if (cur.status === 'FINISHED' && !isShootout) {
        if (sport === 'football') brk = cur.type !== lastRegular;
        else brk = (cur.type !== lastRegular && !isOt) || tiedEnd;
      }
      if (!running && offset !== undefined && !isShootout) {
        // b) odpočet doběhl na 0 (konec třetiny/čtvrtiny), další perioda ještě neexistuje
        if (sport !== 'football' && offset === 0 && ((cur.type !== lastRegular && !isOt) || tiedEnd)) brk = true;
        // c) nová perioda už založená, ale ještě nezačala (hodiny od založení nikdo neposunul:
        //    fotbal 0:00, hokej/basket plná délka periody)
        const lu = ts(c0?.lastUpdate);
        const st0 = ts(cur.startTime);
        const neverRan = !Number.isFinite(lu) || !Number.isFinite(st0) || Math.abs(lu - st0) < 5000;
        if (idx > 0 && neverRan && sport === 'football' && offset === 0) brk = true;
        if (idx > 0 && neverRan && sport !== 'football' && FULL_PERIOD[sport]?.includes(offset)) brk = true;
      }
      if (brk && !ev.resulted) {
        st.breakFlag = true;
        st.clockRunning = false;
      }
    }
    if (periods.some((p) => FINISHED_TYPES.test(p.type))) st.finished = true;
  }
  if (ev.resulted) st.finished = true;
  return Object.keys(st).length ? st : undefined;
}

// ---------- události ----------

export function eventSport(ev: ObEvent): Sport | undefined {
  const code = ev.drilldownNodes?.find((n) => n.levelNumber === 2)?.code;
  return code ? CODE_TO_SPORT[code] : undefined;
}

export function eventUrl(ev: ObEvent): string {
  if (ev.liveNow) return `${SITE}/live/${ev.id}`;
  const league = ev.drilldownNodes?.find((n) => n.levelNumber === 4)?.id;
  const sport = ev.drilldownNodes?.find((n) => n.levelNumber === 2)?.id;
  return league && sport ? `${SITE}/kurzy/${sport}/${league}/${ev.id}` : SITE;
}

export interface ParseOptions {
  /** 'live' = jen běžící zápasy, 'prematch' = jen nezačaté. */
  scope: 'prematch' | 'live';
  now: number;
  sports?: Sport[];
}

/** Jedna OpenBet událost → RawEvent (nebo null: jiný sport, speciál, e-sport, ...). */
export function parseEvent(ev: ObEvent, o: ParseOptions): RawEvent | null {
  const sport = eventSport(ev);
  if (!sport || (o.sports && !o.sports.includes(sport))) return null;
  if (ev.sortCode && ev.sortCode !== 'MTCH') return null;
  if (ev.displayed === false) return null;
  const home = ev.teams?.find((t) => t.side === 'HOME')?.name?.trim();
  const away = ev.teams?.find((t) => t.side === 'AWAY')?.name?.trim();
  if (!home || !away) return null;
  const live = ev.liveNow === true;
  if (o.scope === 'live' ? !live : live || ev.started) return null;
  const startTime = Date.parse(ev.startTime);
  if (!Number.isFinite(startTime)) return null;
  const markets: RawMarket[] = [];
  const seen = new Set<string>();
  // suspendovaná událost (status/active na úrovni události) = všechny trhy zavřené
  const eventOpen = ev.active !== false && (ev.status === undefined || ev.status === 'ACTIVE');
  // standardní trhy před asijskými (při kolizi klíče vyhrává standardní)
  const src = (ev.markets ?? []).slice().sort((a, b) => Number((a.groupCode ?? '').includes('ASIAN')) - Number((b.groupCode ?? '').includes('ASIAN')));
  for (const m of src) {
    const rm = mapMarket(sport, m, home, away);
    if (!rm || seen.has(rm.key)) continue;
    seen.add(rm.key);
    if (!eventOpen) rm.open = false;
    markets.push(rm);
  }
  const league = ev.drilldownNodes?.find((n) => n.levelNumber === 4)?.name ?? '';
  const country = ev.drilldownNodes?.find((n) => n.levelNumber === 3)?.name;
  const re: RawEvent = {
    sourceId: String(ev.id),
    sport,
    competition: league,
    home,
    away,
    startTime,
    live,
    markets,
    url: eventUrl(ev),
  };
  if (country) re.country = country;
  if (live) {
    const st = parseState(ev, sport, o.now);
    if (st) re.state = st;
  }
  return re;
}

export function parseEvents(events: ObEvent[] | undefined, o: ParseOptions): RawEvent[] {
  const out: RawEvent[] = [];
  const seen = new Set<string>();
  for (const ev of events ?? []) {
    const r = parseEvent(ev, o);
    if (!r || seen.has(r.sourceId)) continue;
    seen.add(r.sourceId);
    out.push(r);
  }
  return out;
}

/**
 * Sloučí listing (hlavní trhy, všechny události) s detailem (všechny trhy, vybrané události).
 * Detail je pro své události autoritativní: obsahuje všechny trhy listingu (stejná market ID) a další.
 * Trh, který v (novějším) detailu chybí, byl mezitím skrytý/zrušený – z listingu se NEPŘEBÍRÁ
 * (dřív se doplňoval → zastaralé "otevřené" linie; 30. 9. ověřeno: 1 z 362 trhů listingu chyběl
 * v detailu a šlo o právě posunutou linii).
 */
export function mergeListingAndDetail(listing: ObEvent[], detail: ObEvent[]): ObEvent[] {
  const byId = new Map(detail.map((e) => [String(e.id), e]));
  const out: ObEvent[] = [];
  for (const e of listing) {
    const d = byId.get(String(e.id));
    if (!d) {
      out.push(e);
      continue;
    }
    out.push({ ...e, ...d, commentary: d.commentary ?? e.commentary, markets: d.markets ?? e.markets ?? [] });
    byId.delete(String(e.id));
  }
  for (const d of byId.values()) out.push(d);
  return out;
}
