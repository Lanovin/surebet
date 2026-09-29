// Kanonické doménové typy sdílené ingestem, detekcí, gatewayí i dashboardem.

export const BOOKMAKERS = [
  'tipsport',
  'fortuna',
  'betano',
  'chance',
  'sazka',
  'merkurxtip',
  'kingsbet',
  'betx',
  'synot',
] as const;
export type BookmakerId = (typeof BOOKMAKERS)[number];

export const SPORTS = ['football', 'tennis', 'basketball', 'hockey'] as const;
export type Sport = (typeof SPORTS)[number];

export const MODES = ['PREMATCH', 'PAUSED', 'LIVE'] as const;
export type Mode = (typeof MODES)[number];

/** Rozsah feedu, který strategie stahuje. PAUSED zápasy jsou součástí live feedu. */
export type FeedScope = 'prematch' | 'live';

/**
 * Typ trhu. Jednotka OU/AH je "primární skóre" sportu:
 * góly (fotbal, hokej), body (basket), gemy (tenis).
 */
export const MARKET_TYPES = [
  '1X2', // HOME / DRAW / AWAY
  'ML', // vítěz bez remízy (tenis, basket vč. prodl., hokej vč. prodl. a nájezdů) HOME / AWAY
  'DNB', // sázka bez remízy (remíza = vrácení) HOME / AWAY
  'OU', // celkový počet (góly/body/gemy) OVER / UNDER
  'AH', // handicap 2-cestný (asijský / ±x.5), linie z pohledu domácích HOME / AWAY
  'BTTS', // oba týmy skórují YES / NO
  'OE', // lichý / sudý ODD / EVEN
  'OU_HOME', // počet skóre domácích OVER / UNDER
  'OU_AWAY', // počet skóre hostů OVER / UNDER
  'OU_SETS', // tenis: počet setů OVER / UNDER
  'AH_SETS', // tenis: handicap na sety HOME / AWAY
] as const;
export type MarketType = (typeof MARKET_TYPES)[number];

/**
 * Časový rozsah trhu – kritické pro správnost arbů.
 *  REG   = základní hrací doba (fotbal 90', hokej 60', basket 4 čtvrtiny bez prodloužení)
 *  MATCH = celý zápas vč. prodloužení / nájezdů (hokej ML, basket ML/OU/AH vč. prodl., tenis zápas)
 *  H1/H2 = poločasy, P1–P3 = hokejové třetiny, Q1–Q4 = čtvrtiny, S1–S5 = sety
 */
export const MARKET_SCOPES = [
  'REG',
  'MATCH',
  'H1',
  'H2',
  'P1',
  'P2',
  'P3',
  'Q1',
  'Q2',
  'Q3',
  'Q4',
  'S1',
  'S2',
  'S3',
  'S4',
  'S5',
] as const;
export type MarketScope = (typeof MARKET_SCOPES)[number];

export const SELECTION_KEYS = ['HOME', 'DRAW', 'AWAY', 'OVER', 'UNDER', 'YES', 'NO', 'ODD', 'EVEN'] as const;
export type SelectionKey = (typeof SELECTION_KEYS)[number];

/** Parsovaný trh; `key` vytvářej výhradně přes marketKey() ze src/core/markets.ts. */
export interface MarketKeyParts {
  type: MarketType;
  scope: MarketScope;
  line?: number;
}

/** Herní stav tak, jak ho umí dodat feed sázkovky (vše volitelné). */
export interface GameState {
  /** Surový text stavu z feedu, např. "Poločas", "HT", "Přestávka", "2. třetina", "Break". */
  statusText?: string;
  /** Aktuální perioda (poločas/třetina/čtvrtina/set), 1-based. */
  period?: number;
  /** Feed výslovně hlásí přestávku (HT, mezi třetinami/čtvrtinami/sety). */
  breakFlag?: boolean;
  /** Uplynulý herní čas v sekundách od začátku zápasu (fotbal 45' = 2700). */
  clockSec?: number;
  /** Zbývající čas periody v sekundách (basket, hokej), pokud feed dodává odpočet. */
  periodRemainingSec?: number;
  /** Běží hodiny? (undefined = neznámo) */
  clockRunning?: boolean;
  score?: [number, number];
  periodScores?: [number, number][];
  /** Tenis: stav gemů v aktuálním setu a body. */
  games?: [number, number];
  points?: string;
  finished?: boolean;
}

export interface RawSelection {
  key: SelectionKey;
  odds: number;
  /** false = výběr uzavřený/suspendovaný. Default true. */
  open?: boolean;
  rawName?: string;
}

export interface RawMarket {
  /** Kanonický klíč trhu z marketKey(), např. "OU|REG|2.5", "1X2|REG", "ML|MATCH". */
  key: string;
  /** false = trh suspendovaný (např. po gólu). */
  open: boolean;
  selections: RawSelection[];
  sourceId?: string;
  rawName?: string;
}

/** Jedna událost tak, jak ji vrátila sázkovka, s trhy už v kanonickém tvaru. */
export interface RawEvent {
  /** ID události u sázkovky (stabilní napříč fetchi). */
  sourceId: string;
  sport: Sport;
  competition: string;
  country?: string;
  /** Surová jména účastníků (tenis: hráč 1 / hráč 2) – párování dělá matcher. */
  home: string;
  away: string;
  /** Začátek (epoch ms). */
  startTime: number;
  live: boolean;
  state?: GameState;
  markets: RawMarket[];
  url?: string;
}

/** Výstup Strategy.fetch(). */
export interface RawOdds {
  bookmaker: BookmakerId;
  strategy: string;
  scope: FeedScope;
  /** Kdy data opustila sázkovku (nebo kdy přišla odpověď), epoch ms. */
  fetchedAt: number;
  events: RawEvent[];
}

export type AdapterState = 'OK' | 'DEGRADED' | 'BLOCKED';

export interface HealthResult {
  ok: boolean;
  latencyMs: number;
  httpStatus?: number;
  message?: string;
}

/** Noha arbu. */
export interface ArbLeg {
  bookmaker: BookmakerId;
  selection: SelectionKey;
  odds: number;
  /** Odds očištěné o poplatek sázkovky (pokud je nastaven). */
  effOdds: number;
  sourceEventId: string;
  /** Selekce je u této sázkovky v opačném pořadí týmů (prohozené HOME/AWAY). */
  swapped: boolean;
  changedAt: number;
  seenAt: number;
  stake?: number;
  url?: string;
}

export type EndReason =
  | `leg_odds_changed:${BookmakerId}`
  | 'suspended'
  | 'event_started'
  | 'pause_started'
  | 'pause_ended'
  | 'event_finished'
  | `stale:${BookmakerId}`
  | 'threshold_changed'
  | 'unlinked'
  | 'system_restart';

/** Důvody, které znamenají cenzurované pozorování (arb nezanikl "sám"). */
export const CENSORING_PREFIXES = [
  'system_restart',
  'stale',
  'threshold_changed',
  'unlinked',
  'event_started',
  'pause_started',
  'pause_ended',
  'event_finished',
] as const;

export function isCensored(reason: string): boolean {
  return CENSORING_PREFIXES.some((p) => reason === p || reason.startsWith(p + ':'));
}

export type PauseType =
  | 'football_ht'
  | 'basketball_ht'
  | 'basketball_quarter'
  | 'hockey_intermission'
  | 'tennis_set_break';

export interface PauseInfo {
  type: PauseType;
  startedAt: number;
  expectedSec: number;
  /** Jak byla přestávka zjištěna. */
  source: 'feed' | 'clock_fallback';
}
