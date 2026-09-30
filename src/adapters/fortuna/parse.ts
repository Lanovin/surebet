// Fortuna (ifortuna.cz, platforma FEG „ufo“) – čisté parsování odpovědí offer API (bez I/O).
// Formát a endpointy: docs/bookmakers/fortuna.md
import { marketKey } from '../../core/markets.js';
import type {
  FeedScope,
  GameState,
  MarketScope,
  MarketType,
  RawEvent,
  RawMarket,
  RawSelection,
  SelectionKey,
  Sport,
} from '../../core/types.js';

export const SITE = 'https://www.ifortuna.cz';
export const API = 'https://api.ifortuna.cz';

/**
 * Naše sporty -> Fortuna sportId a dvouznakové kódy (prefix ID kategorií a typů trhů). Obvykle jeden
 * kód = kód sportu; box má trhy pod `14-…` (kategorie `01-…`), bojové sporty (MMA) mají vedle `19-…`
 * i UFC kategorii a trhy `05-…`. Kategorie s jiným kódem = e-sport (eFotbal `0c`, eHokej `35`…).
 */
export const SPORTS_MAP: Partial<Record<Sport, { id: string; codes: string[] }>> = {
  football: { id: 'ufo:sprt:00', codes: ['00'] },
  hockey: { id: 'ufo:sprt:0w', codes: ['0w'] },
  basketball: { id: 'ufo:sprt:0i', codes: ['0i'] },
  tennis: { id: 'ufo:sprt:0x', codes: ['0x'] },
  handball: { id: 'ufo:sprt:0y', codes: ['0y'] },
  volleyball: { id: 'ufo:sprt:0m', codes: ['0m'] },
  baseball: { id: 'ufo:sprt:0q', codes: ['0q'] },
  american_football: { id: 'ufo:sprt:0g', codes: ['0g'] },
  boxing: { id: 'ufo:sprt:01', codes: ['01', '14'] },
  mma: { id: 'ufo:sprt:19', codes: ['19', '05'] }, // „Bojové sporty“ (UFC, KSW, Oktagon, PFL, One FC…)
  darts: { id: 'ufo:sprt:0l', codes: ['0l'] },
  snooker: { id: 'ufo:sprt:0h', codes: ['0h'] },
  table_tennis: { id: 'ufo:sprt:0j', codes: ['0j'] },
};
const SPORT_BY_ID = new Map<string, Sport>(Object.entries(SPORTS_MAP).map(([s, v]) => [v.id, s as Sport]));

/** Původní (hlavní) sporty – přednost v rozpočtu detailů zápasů (prematch i websocket). */
export const PRIMARY_SPORTS: Sport[] = ['football', 'hockey', 'basketball', 'tennis'];

/**
 * Typy trhů, které vrací hromadný endpoint /markets/api/v1_0/fixtures/markets/overview
 * (jen „overview“ typy – seznam per sport dává /markets/api/v1_0/codebook/sport/{id}/overview-market-types;
 * s explicitním marketTypeIds vrací víc linií). Ostatní jen v detailu zápasu. Jen typy, které mapujeme.
 */
export const OVERVIEW_TYPES: Partial<Record<Sport, string[]>> = {
  football: ['00-00', '00-01', '00-03', '00-0u'],
  hockey: ['0w-00', '0w-02', '0w-05', '0w-0d', '0w-0j'],
  basketball: ['0i-00', '0i-04', '0i-06', '0i-07'],
  tennis: ['0x-01', '0x-0e', '0x-0g', '0x-04', '0x-02'],
  handball: ['0y-00', '0y-04', '0y-05', '0y-0c'],
  volleyball: ['0m-00', '0m-09', '0m-0b', '0m-0d', '0m-0f'],
  baseball: ['0q-0d', '0q-0g'],
  american_football: ['0g-08', '0g-0q'],
  boxing: ['14-00', '14-01'],
  mma: ['05-00', '05-02', '19-00'],
  darts: ['0l-01', '0l-02', '0l-04', '0l-05', '0l-06'],
  snooker: ['0h-01', '0h-04'],
  table_tennis: ['0j-00', '0j-02', '0j-03', '0j-0a'],
};

// ---------- surové typy feedu ----------

export interface FtnParticipant {
  id: string;
  name: string;
  type: string; // HOME | AWAY
}

export interface FtnFixture {
  id: string;
  sportId: string;
  categoryId: string;
  tournamentId: string;
  kind: string; // PREMATCH | LIVE
  name: string;
  sportSeoName?: string;
  categorySeoName?: string;
  tournamentSeoName?: string;
  seoName?: string;
  participants?: FtnParticipant[];
  startDatetime: number;
  status?: string;
  marketTypeIds?: string[];
  hasMarkets?: boolean;
}

export interface FtnTournament {
  id: string;
  sportId?: string;
  categoryId?: string;
  name: string;
}

export interface FtnCategory {
  id: string;
  sportId?: string;
  name: string;
}

export interface FtnPagingInfo {
  pageNumber: number;
  pageSize: number;
  pageCount: number;
  totalCount: number;
  hasNext: boolean;
}

/** Odpověď /structure/api/v1_0/[live/]sport/{sportId}/matches */
export interface FtnMatchesPage {
  categories?: FtnCategory[];
  tournaments?: FtnTournament[];
  fixtures?: FtnFixture[];
  pagingInfo?: FtnPagingInfo;
}

export interface FtnOutcome {
  id: string;
  name: string;
  longName?: string;
  odds: number;
  displayType?: string; // OPEN | LOCKED | SUSPENDED | CLOSED
}

export interface FtnMarket {
  id: string;
  fixtureId: string;
  marketTypeId: string;
  kind?: string;
  name: string;
  marketTypeName?: string;
  syntheticGroupKey?: string;
  /** STANDARD (vše, co mapujeme) | GOALSCORER | COMPOUND_EXT … */
  variant?: string;
  outcomes: FtnOutcome[];
}

/** fixtureId -> trhy (odpověď overview endpointu, případně doplněná o detail). */
export type FtnMarketsByFixture = Record<string, FtnMarket[]>;

export interface FtnSideScore {
  Home: string;
  Away: string;
}

export interface FtnPeriodInfo {
  order: number;
  home: number;
  away: number;
  finished?: boolean;
}

/** /stats-v2/api/v2_0/miniscoreboards?fixtureIds=… (a WS topic /topic/offer/v2/cs/miniscoreboard) */
export interface FtnMiniScoreboard {
  type?: string;
  fixtureId: string;
  servingCompetitor?: string;
  columns?: Record<string, FtnSideScore | undefined>;
  overview?: { gameTime?: string; info?: FtnPeriodInfo[] };
  scheduledStartTime?: number;
}

/** Plný scoreboard (/fixture/{id}/scoreboard, WS scoreboard.{id}) – přesné hodiny. */
export interface FtnScoreboard {
  type?: string;
  fixtureId: string;
  overview?: { gameTime?: string; info?: FtnPeriodInfo[] };
  summaryScoreboards?: { Home?: { score?: number }; Away?: { score?: number } };
  eventTime?: number;
  remainingTimeInPeriod?: number;
  timerRunning?: boolean;
  scores?: FtnSideScore;
}

/** Vše, co strategie stáhla pro jeden scope. */
export interface FortunaBundle {
  scope: FeedScope;
  pages: FtnMatchesPage[];
  markets: FtnMarketsByFixture;
  scoreboards?: FtnMiniScoreboard[];
  clocks?: Record<string, FtnScoreboard>;
  /** Kdy se začaly stahovat kurzy (overview je bez CDN cache) = fetchedAt výstupu. */
  dataAt?: number;
}

// ---------- mapování trhů ----------

type PeriodKind = 'H' | 'P' | 'Q' | 'S';

interface MarketDef {
  type: MarketType;
  /** Pevný scope, nebo perioda, jejíž číslo se čte z názvu trhu. */
  scope: MarketScope | PeriodKind;
  /** Týmové totaly: čí tým (kontroluje se i podle jména v názvu trhu). */
  team?: 'HOME' | 'AWAY';
}

/**
 * Typ trhu Fortuny (bez prefixu „ufo:mtyp:“) -> kanonický trh. Scope ověřen podle
 * marketTypeDesc/syntheticGroupKey („v zápasu“ = základní doba, „do rozhodnutí“ / „včetně
 * prodloužení“ = vč. prodloužení a nájezdů). Dvojtipy (`DC`) jen pro rozsahy, které můžou skončit
 * remízou. Kombinace, přesné výsledky, hráčské trhy, totaly kol a způsob výhry (MMA/box) vynechány.
 */
const DEFS: Record<string, MarketDef> = {
  // fotbal (vše základní doba)
  '00-00': { type: '1X2', scope: 'REG' }, // Výsledek zápasu
  '00-03': { type: 'DNB', scope: 'REG' }, // Výsledek zápasu bez remízy
  '00-0u': { type: 'OU', scope: 'REG' }, // Počet gólů v zápasu
  '00-0b': { type: 'AH', scope: 'REG' }, // Handicap v zápasu (2-cestný, asijský)
  '00-1c': { type: 'BTTS', scope: 'REG' }, // Každý z týmů dá gól v zápasu
  '00-10': { type: 'OU_HOME', scope: 'REG', team: 'HOME' }, // {1. tým} počet gólů v zápasu
  '00-13': { type: 'OU_AWAY', scope: 'REG', team: 'AWAY' },
  '00-2d': { type: '1X2', scope: 'H1' }, // Výsledek 1. poločasu
  '00-2g': { type: 'DNB', scope: 'H1' },
  '00-2i': { type: 'OU', scope: 'H1' },
  '00-2h': { type: 'AH', scope: 'H1' },
  '00-2n': { type: 'BTTS', scope: 'H1' },
  '00-2m': { type: 'OE', scope: 'H1' }, // Součet gólů v 1. poločasu (lichý/sudý)
  '00-2j': { type: 'OU_HOME', scope: 'H1', team: 'HOME' },
  '00-2k': { type: 'OU_AWAY', scope: 'H1', team: 'AWAY' },
  '00-2w': { type: '1X2', scope: 'H2' },
  '00-2z': { type: 'DNB', scope: 'H2' },
  '00-3b': { type: 'OU', scope: 'H2' },
  '00-3g': { type: 'BTTS', scope: 'H2' },
  '00-3c': { type: 'OU_HOME', scope: 'H2', team: 'HOME' },
  '00-3d': { type: 'OU_AWAY', scope: 'H2', team: 'AWAY' },
  '00-01': { type: 'DC', scope: 'REG' }, // Výsledek zápasu - dvojtip („v základní hrací době“), výběry 10 / 12 / 02
  '00-2f': { type: 'DC', scope: 'H1' }, // Výsledek 1. poločasu - dvojtip
  '00-2y': { type: 'DC', scope: 'H2' }, // Výsledek 2. poločasu - dvojtip
  // lední hokej
  '0w-00': { type: '1X2', scope: 'REG' }, // Výsledek zápasu (60 min)
  '0w-02': { type: 'DNB', scope: 'REG' },
  '0w-04': { type: 'AH', scope: 'REG' }, // Handicap v zápasu
  '0w-05': { type: 'OU', scope: 'REG' }, // Počet gólů v zápasu
  '0w-06': { type: 'OU_HOME', scope: 'REG', team: 'HOME' },
  '0w-08': { type: 'OU_AWAY', scope: 'REG', team: 'AWAY' },
  '0w-0b': { type: 'BTTS', scope: 'REG' },
  '0w-0d': { type: 'ML', scope: 'MATCH' }, // Vítěz zápasu do rozhodnutí
  '0w-0e': { type: 'AH', scope: 'MATCH' }, // Handicap do rozhodnutí
  '0w-0f': { type: 'OU', scope: 'MATCH' }, // Počet gólů do rozhodnutí
  '0w-0g': { type: 'OU_HOME', scope: 'MATCH', team: 'HOME' },
  '0w-0h': { type: 'OU_AWAY', scope: 'MATCH', team: 'AWAY' },
  '0w-0j': { type: '1X2', scope: 'P' }, // Výsledek N. třetiny
  '0w-0q': { type: 'DNB', scope: 'P' },
  '0w-0l': { type: 'OU', scope: 'P' },
  '0w-0r': { type: 'AH', scope: 'P' },
  '0w-0o': { type: 'BTTS', scope: 'P' },
  '0w-0m': { type: 'OU_HOME', scope: 'P', team: 'HOME' },
  '0w-0n': { type: 'OU_AWAY', scope: 'P', team: 'AWAY' },
  '0w-01': { type: 'DC', scope: 'REG' }, // Výsledek zápasu - dvojtip (60 min)
  '0w-0t': { type: 'DC', scope: 'P' }, // Výsledek N. třetiny - dvojtip
  // basketbal
  '0i-00': { type: '1X2', scope: 'REG' }, // Výsledek zápasu (3-cestný, bez prodloužení)
  '0i-04': { type: 'ML', scope: 'MATCH' }, // Vítěz zápasu (včetně prodloužení)
  '0i-06': { type: 'AH', scope: 'MATCH' }, // Handicap (včetně prodloužení)
  '0i-07': { type: 'OU', scope: 'MATCH' }, // Počet bodů (včetně prodloužení)
  '0i-08': { type: 'OU_HOME', scope: 'MATCH', team: 'HOME' },
  '0i-09': { type: 'OU_AWAY', scope: 'MATCH', team: 'AWAY' },
  '0i-0a': { type: 'OE', scope: 'MATCH' },
  '0i-0h': { type: '1X2', scope: 'H1' },
  '0i-0i': { type: 'DNB', scope: 'H1' },
  '0i-0j': { type: 'AH', scope: 'H1' },
  '0i-0k': { type: 'OU', scope: 'H1' },
  '0i-0n': { type: 'OE', scope: 'H1' },
  '0i-0l': { type: 'OU_HOME', scope: 'H1', team: 'HOME' },
  '0i-0m': { type: 'OU_AWAY', scope: 'H1', team: 'AWAY' },
  '0i-0b': { type: '1X2', scope: 'Q' }, // Výsledek N. čtvrtiny
  '0i-0c': { type: 'OU', scope: 'Q' },
  '0i-0e': { type: 'OE', scope: 'Q' },
  '0i-1b': { type: 'AH', scope: 'Q' },
  '0i-0o': { type: 'OU_HOME', scope: 'Q', team: 'HOME' },
  '0i-0p': { type: 'OU_AWAY', scope: 'Q', team: 'AWAY' },
  // tenis (jednotka OU/AH = gemy)
  '0x-01': { type: 'ML', scope: 'MATCH' }, // Vítěz zápasu
  '0x-02': { type: 'AH', scope: 'MATCH' }, // Handicap gamů v zápasu
  '0x-03': { type: 'AH_SETS', scope: 'MATCH' }, // Handicap setů v zápasu
  '0x-04': { type: 'OU', scope: 'MATCH' }, // Počet gamů v zápasu
  '0x-05': { type: 'OU_HOME', scope: 'MATCH', team: 'HOME' }, // {hráč 1}: počet gamů
  '0x-06': { type: 'OU_AWAY', scope: 'MATCH', team: 'AWAY' },
  '0x-0i': { type: 'OU_SETS', scope: 'MATCH' }, // Počet setů v zápasu
  '0x-0e': { type: 'ML', scope: 'S' }, // Vítěz N. setu
  '0x-0f': { type: 'AH', scope: 'S' }, // Handicap gamů v N. setu
  '0x-0g': { type: 'OU', scope: 'S' }, // Počet gamů v N. setu
  // házená (vše základní hrací doba 60 min; výběry handicapu „1 -1.5“ / „2 +1.5“)
  '0y-00': { type: '1X2', scope: 'REG' }, // Výsledek zápasu
  '0y-01': { type: 'DC', scope: 'REG' }, // Výsledek zápasu - dvojtip
  '0y-02': { type: 'DNB', scope: 'REG' }, // Výsledek zápasu bez remízy
  '0y-04': { type: 'AH', scope: 'REG' }, // Handicap v zápasu
  '0y-05': { type: 'OU', scope: 'REG' }, // Počet gólů v zápasu
  '0y-06': { type: 'OU_HOME', scope: 'REG', team: 'HOME' }, // {1. tým} počet gólů v zápasu
  '0y-07': { type: 'OU_AWAY', scope: 'REG', team: 'AWAY' },
  '0y-08': { type: 'OE', scope: 'REG' }, // Součet gólů v zápasu (lichý/sudý)
  '0y-0c': { type: '1X2', scope: 'H1' }, // Výsledek 1. poločasu
  '0y-0d': { type: 'DC', scope: 'H1' },
  '0y-0e': { type: 'DNB', scope: 'H1' },
  '0y-0f': { type: 'AH', scope: 'H1' },
  '0y-0g': { type: 'OU', scope: 'H1' },
  '0y-0h': { type: 'OE', scope: 'H1' },
  '0y-0i': { type: '1X2', scope: 'H2' }, // Výsledek 2. poločasu
  '0y-0j': { type: 'DNB', scope: 'H2' },
  '0y-0k': { type: 'OE', scope: 'H2' },
  // volejbal (remíza neexistuje; OU/AH na body, sety zvlášť)
  '0m-00': { type: 'ML', scope: 'MATCH' }, // Vítěz zápasu
  '0m-01': { type: 'AH_SETS', scope: 'MATCH' }, // Handicap setů v zápasu („Tým -1.5“)
  '0m-02': { type: 'OU_HOME', scope: 'MATCH', team: 'HOME' }, // {1. tým} počet bodů v zápasu
  '0m-07': { type: 'OU_AWAY', scope: 'MATCH', team: 'AWAY' },
  '0m-09': { type: 'ML', scope: 'S' }, // Vítěz N. setu
  '0m-0a': { type: 'AH', scope: 'MATCH' }, // Handicap bodů v zápasu
  '0m-0b': { type: 'OU', scope: 'MATCH' }, // Počet bodů v zápasu
  '0m-0c': { type: 'AH', scope: 'S' }, // Handicap bodů v N. setu
  '0m-0d': { type: 'OU', scope: 'S' }, // Počet bodů v N. setu
  '0m-0e': { type: 'OE', scope: 'S' }, // Součet bodů v N. setu
  '0m-0f': { type: 'OU_SETS', scope: 'MATCH' }, // Počet setů v zápasu
  // baseball: vše „včetně extra inningů“ = MATCH, „Výsledek zápasu“ s remízou = 9 směn (REG);
  // první směna / po 5. směně / hity vynechány, nadhazovače Fortuna u trhů neuvádí
  '0q-00': { type: '1X2', scope: 'REG' }, // Výsledek zápasu
  '0q-0d': { type: 'ML', scope: 'MATCH' }, // Vítěz zápasu včetně extra inningů
  '0q-0f': { type: 'AH', scope: 'MATCH' }, // Handicap včetně extra inningů (run line)
  '0q-0g': { type: 'OU', scope: 'MATCH' }, // Počet bodů (běhů) včetně extra inningů
  '0q-0h': { type: 'OU_HOME', scope: 'MATCH', team: 'HOME' }, // {1. tým}: počet bodů včetně extra inningů
  '0q-0i': { type: 'OU_AWAY', scope: 'MATCH', team: 'AWAY' },
  // americký fotbal: „včetně prodloužení“ = MATCH, 3-cestný výsledek = základní doba;
  // `0g-05` Vítěz zápasu včetně prodloužení vynechán – nevíme, jestli Fortuna při remíze vrací vklad
  '0g-00': { type: '1X2', scope: 'REG' }, // Výsledek zápasu
  '0g-07': { type: 'AH', scope: 'MATCH' }, // Handicap včetně prodloužení
  '0g-08': { type: 'OU', scope: 'MATCH' }, // Počet bodů včetně prodloužení
  '0g-09': { type: 'OU_HOME', scope: 'MATCH', team: 'HOME' }, // {1. tým} počet bodů v zápasu včetně prodloužení
  '0g-0a': { type: 'OU_AWAY', scope: 'MATCH', team: 'AWAY' },
  '0g-0b': { type: 'OE', scope: 'MATCH' }, // Součet bodů včetně prodloužení
  '0g-0q': { type: '1X2', scope: 'H1' }, // Výsledek 1. poločasu
  '0g-0w': { type: 'DNB', scope: 'H1' },
  '0g-0x': { type: 'AH', scope: 'H1' },
  '0g-0y': { type: 'OU', scope: 'H1' },
  '0g-0f': { type: '1X2', scope: 'Q' }, // Výsledek N. čtvrtiny
  '0g-0m': { type: 'DNB', scope: 'Q' },
  '0g-0n': { type: 'AH', scope: 'Q' },
  '0g-0g': { type: 'OU', scope: 'Q' },
  // box (trhy 14-…): „Výsledek zápasu“ vč. remízy; „Vítěz zápasu“ = při remíze vrácení (DNB, viz docs)
  '14-01': { type: '1X2', scope: 'REG' },
  '14-00': { type: 'DNB', scope: 'REG' },
  // MMA / bojové sporty: popis trhu „Vítěz zápasu“: „V případě remízy budou sázky vráceny“
  '05-00': { type: '1X2', scope: 'REG' }, // Výsledek zápasu (UFC), „jedním z možných typů je remíza“
  '05-02': { type: 'DNB', scope: 'REG' }, // Vítěz zápasu (UFC)
  '19-00': { type: 'DNB', scope: 'REG' }, // Vítěz zápasu (KSW, Oktagon, PFL…)
  // šipky: OU/AH „legů“ = legy (MATCH), „setů“ = AH_SETS/OU_SETS; N. set: vítěz, legy v setu
  '0l-01': { type: 'ML', scope: 'MATCH' }, // Vítěz zápasu
  '0l-02': { type: 'AH_SETS', scope: 'MATCH' }, // Handicap setů v zápasu
  '0l-04': { type: 'OU_SETS', scope: 'MATCH' }, // Počet setů v zápasu
  '0l-05': { type: 'AH', scope: 'MATCH' }, // Handicap legů v zápasu
  '0l-06': { type: 'OU', scope: 'MATCH' }, // Počet legů v zápasu
  '0l-03': { type: 'ML', scope: 'S' }, // Vítěz N. setu
  '0l-07': { type: 'AH', scope: 'S' }, // Handicap legů v N. setu
  '0l-08': { type: 'OU', scope: 'S' }, // Počet legů v N. setu
  // snooker (jednotka = framy)
  '0h-01': { type: 'ML', scope: 'MATCH' }, // Vítěz zápasu
  '0h-03': { type: 'AH', scope: 'MATCH' }, // Handicap framů v zápasu
  '0h-04': { type: 'OU', scope: 'MATCH' }, // Počet framů v zápasu
  // stolní tenis (OU/AH na body; sety nad 5. se nemapují – S1–S5)
  '0j-00': { type: 'ML', scope: 'MATCH' }, // Vítěz zápasu
  '0j-02': { type: 'AH', scope: 'MATCH' }, // Handicap bodů v zápasu
  '0j-03': { type: 'OU', scope: 'MATCH' }, // Počet bodů v zápasu
  '0j-0n': { type: 'AH_SETS', scope: 'MATCH' }, // Handicap setů v zápasu
  '0j-0o': { type: 'OE', scope: 'MATCH' }, // Zápas: součet bodů
  '0j-0p': { type: 'OU_HOME', scope: 'MATCH', team: 'HOME' }, // {hráč 1}: počet bodů
  '0j-0q': { type: 'OU_AWAY', scope: 'MATCH', team: 'AWAY' },
  '0j-0a': { type: 'ML', scope: 'S' }, // Vítěz N. setu
  '0j-0b': { type: 'OU', scope: 'S' }, // Počet bodů v N. setu
  '0j-0c': { type: 'AH', scope: 'S' }, // Handicap bodů v N. setu
  '0j-0d': { type: 'OE', scope: 'S' }, // Součet bodů v N. setu
};

/** Umíme typ trhu namapovat? (detail zápasu má stovky hráčských trhů – ty se ani necachují) */
export function isMappedMarketType(marketTypeId: string): boolean {
  return marketTypeId.replace(/^ufo:mtyp:/, '') in DEFS;
}

const PERIOD_WORDS: Record<PeriodKind, { cz: string; en: string; max: number; prefix: string }> = {
  H: { cz: 'poločas', en: 'half', max: 2, prefix: 'H' },
  P: { cz: 'třetin', en: 'period', max: 3, prefix: 'P' },
  Q: { cz: 'čtvrtin', en: 'quarter', max: 4, prefix: 'Q' },
  S: { cz: 'set', en: 'set', max: 5, prefix: 'S' },
};

/** Normalizace mezer (feed používá NBSP a zdvojené mezery). */
export function norm(s: string | undefined): string {
  return (s ?? '').replace(/[ \t]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Obsahuje text jméno jako samostatné slovo (hranice = začátek/konec, mezera, dvojtečka, čárka, |)? */
function mentions(text: string, name: string): boolean {
  const n = norm(name).toLowerCase();
  if (!n) return false;
  const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s:,|])${esc}(?=$|[\\s:,|])`, 'i').test(text.toLowerCase());
}

function num(s: string): number {
  return Number(s.replace(',', '.'));
}

/** Číslo periody z názvu trhu („Vítěz 2.setu“, „1. Period - Handicap“) a syntheticGroupKey („2nd_period“). */
export function periodOf(m: FtnMarket, kind: PeriodKind): number | undefined {
  const w = PERIOD_WORDS[kind];
  const fromName = new RegExp(`(\\d)\\.\\s*(?:${w.cz}|${w.en})`, 'i').exec(norm(m.name))?.[1];
  const key = m.syntheticGroupKey ?? '';
  const fromKey =
    new RegExp(`(?:^|_)(\\d)(?:st|nd|rd|th)_?${w.en}`, 'i').exec(key)?.[1] ??
    new RegExp(`(?:^|_)${w.en}_(\\d)(?:_|:|$)`, 'i').exec(key)?.[1];
  if (fromName && fromKey && fromName !== fromKey) return undefined;
  const n = Number(fromName ?? fromKey);
  return n >= 1 && n <= w.max ? n : undefined;
}

/** Výběry 1/0/2, Ano/Ne, Lichý/Sudý, dvojtip 10/12/02. */
function simpleKey(type: MarketType, name: string): SelectionKey | undefined {
  const n = norm(name).toLowerCase();
  switch (type) {
    case '1X2':
      return n === '1' ? 'HOME' : n === '0' || n === 'x' ? 'DRAW' : n === '2' ? 'AWAY' : undefined;
    case 'ML':
    case 'DNB':
      return n === '1' ? 'HOME' : n === '2' ? 'AWAY' : undefined;
    case 'BTTS':
      return n === 'ano' || n === 'yes' ? 'YES' : n === 'ne' || n === 'no' ? 'NO' : undefined;
    case 'OE':
      return n === 'lichý' || n === 'odd' ? 'ODD' : n === 'sudý' || n === 'even' ? 'EVEN' : undefined;
    case 'DC':
      // dvojtip: „10“ = 1X, „12“, „02“ = X2 (ověřeno proti kurzům 1X2)
      return n === '10' || n === '1x' ? 'HOME_DRAW' : n === '12' ? 'HOME_AWAY' : n === '02' || n === 'x2' ? 'DRAW_AWAY' : undefined;
    default:
      return undefined;
  }
}

function selection(key: SelectionKey, o: FtnOutcome): RawSelection | null {
  if (!Number.isFinite(o.odds) || o.odds < 1.01 || o.odds > 1000) return null;
  const s: RawSelection = { key, odds: o.odds, rawName: norm(o.name) };
  if (o.displayType && o.displayType !== 'OPEN') s.open = false;
  return s;
}

/** Celkový počet: výběry „+ 2.5“ / „- 2.5“, obě strany musí mít stejnou linii. */
function parseTotal(m: FtnMarket): { line: number; sels: [SelectionKey, FtnOutcome][] } | null {
  let line: number | undefined;
  const sels: [SelectionKey, FtnOutcome][] = [];
  for (const o of m.outcomes) {
    const r = /^([+-])\s*(\d+(?:[.,]\d+)?)$/.exec(norm(o.name));
    if (!r) return null;
    const l = num(r[2]);
    if (line !== undefined && l !== line) return null;
    line = l;
    sels.push([r[1] === '+' ? 'OVER' : 'UNDER', o]);
  }
  return line === undefined ? null : { line, sels };
}

/**
 * Handicap: „Newcastle (-1)“ / „1 (+0.5)“ (fotbal, hokej, basket, tenis) nebo bez závorek „1 -1.5“,
 * „2+0.5“, „Jaworzno -1.5“ (házená, volejbal, baseball, americký fotbal, šipky, snooker, stolní tenis);
 * linie z pohledu domácích, hosté musí mít opačnou.
 */
function parseHandicap(m: FtnMarket, home: string, away: string): { line: number; sels: [SelectionKey, FtnOutcome][] } | null {
  const h = norm(home).toLowerCase();
  const a = norm(away).toLowerCase();
  let homeLine: number | undefined;
  let awayLine: number | undefined;
  const sels: [SelectionKey, FtnOutcome][] = [];
  for (const o of m.outcomes) {
    const n = norm(o.name);
    // bez závorek musí mít linie znaménko (kromě 0), jinak by šlo o jméno končící číslem
    const r = /^(.*?)\s*\(\s*([+-]?)\s*(\d+(?:[.,]\d+)?)\s*\)$/.exec(n) ?? /^(.*?)\s*([+-])\s*(\d+(?:[.,]\d+)?)$/.exec(n) ?? /^(.+?)\s+()(0)$/.exec(n);
    if (!r) return null;
    const label = r[1].toLowerCase();
    const l = (r[2] === '-' ? -1 : 1) * num(r[3]);
    const side: SelectionKey | undefined = label === '1' || label === h ? 'HOME' : label === '2' || label === a ? 'AWAY' : undefined;
    if (!side) return null;
    if (side === 'HOME') homeLine = l;
    else awayLine = l;
    sels.push([side, o]);
  }
  if (homeLine === undefined || awayLine === undefined || homeLine + awayLine !== 0) return null;
  return { line: homeLine, sels };
}

/** Jeden trh Fortuny -> kanonický trh; null = neznámý/nejistý trh (vynechat). */
export function mapMarket(m: FtnMarket, sport: Sport, home: string, away: string): RawMarket | null {
  const typeId = m.marketTypeId?.replace(/^ufo:mtyp:/, '');
  const def = DEFS[typeId];
  const codes = SPORTS_MAP[sport]?.codes;
  if (!def || !codes?.includes(typeId.slice(0, 2))) return null;
  if (!m.outcomes?.length) return null;
  // jiná varianta téhož typu (hráčské, kombinované, náhradní trhy) nemá stejná pravidla vyhodnocení
  if (m.variant && m.variant !== 'STANDARD') return null;

  let scope: MarketScope;
  if (def.scope.length === 1) {
    const kind = def.scope as PeriodKind;
    const n = periodOf(m, kind);
    if (!n) return null;
    scope = `${PERIOD_WORDS[kind].prefix}${n}` as MarketScope;
  } else {
    scope = def.scope as MarketScope;
    // pevný periodový trh (např. 00-2d = 1. poločas) – kontrola, že název nehlásí jinou periodu
    const k = scope[0] as PeriodKind;
    if (scope !== 'REG' && scope !== 'MATCH' && PERIOD_WORDS[k]) {
      const n = periodOf(m, k);
      if (n !== undefined && `${k}${n}` !== scope) return null;
    }
  }

  if (def.team) {
    // týmový total: v názvu musí být jméno správného týmu (nebo aspoň ne jméno soupeře)
    const title = norm(`${m.marketTypeName ?? ''} | ${m.name}`);
    const mine = def.team === 'HOME' ? home : away;
    const other = def.team === 'HOME' ? away : home;
    if (!mentions(title, mine) && mentions(title, other)) return null;
  }

  let line: number | undefined;
  let pairs: [SelectionKey, FtnOutcome][];
  if (def.type === 'OU' || def.type === 'OU_HOME' || def.type === 'OU_AWAY' || def.type === 'OU_SETS') {
    const t = parseTotal(m);
    if (!t) return null;
    line = t.line;
    pairs = t.sels;
  } else if (def.type === 'AH' || def.type === 'AH_SETS') {
    const t = parseHandicap(m, home, away);
    if (!t) return null;
    line = t.line;
    pairs = t.sels;
  } else {
    pairs = [];
    for (const o of m.outcomes) {
      const k = simpleKey(def.type, o.name);
      if (!k) return null; // neznámý výběr -> trh radši celý vynechat
      pairs.push([k, o]);
    }
  }
  const seen = new Set<SelectionKey>();
  const selections: RawSelection[] = [];
  for (const [k, o] of pairs) {
    if (seen.has(k)) return null;
    seen.add(k);
    const s = selection(k, o);
    if (s) selections.push(s);
  }
  if (!selections.length) return null;
  return {
    key: marketKey(def.type, scope, line),
    open: selections.some((s) => s.open !== false),
    selections,
    sourceId: m.id,
    rawName: norm(m.name),
  };
}

// ---------- události ----------

/** E-sporty a simulace, které Fortuna řadí pod reálné sporty (kategorie eFotbal/eHokej/eBasketbal). */
export function isEsport(f: FtnFixture, tournament?: FtnTournament, category?: FtnCategory): boolean {
  const codes = SPORTS_MAP[SPORT_BY_ID.get(f.sportId) ?? 'football']?.codes ?? [];
  const catCode = /^ufo:ctgr:([0-9a-z]{2})-/i.exec(f.categoryId ?? '')?.[1];
  if (catCode && !codes.includes(catCode)) return true;
  if (/^e(fotbal|hokej|basketbal|tenis)|esport|cyber|virtu/i.test(category?.name ?? '')) return true;
  return /e-?sports?\b|esports battle|cyber|virtu|\(\d+\s*x\s*\d+\s*min/i.test(tournament?.name ?? '');
}

/**
 * Formáty, které se mapují jinak než zbytek sportu – vynechat celý zápas: plážový volejbal
 * (hraje se na 2 vítězné sety), zápasy se zlatým setem.
 */
export function isUnsupportedFormat(f: FtnFixture, tournament?: FtnTournament): boolean {
  if (SPORT_BY_ID.get(f.sportId) !== 'volleyball') return false;
  return /pláž|beach|zlatý set|golden set/i.test(`${tournament?.name ?? ''} | ${f.name}`);
}

/** Zápas, který adaptér nevrací: e-sport / simulace / nepodporovaný formát. */
export function isSkipped(f: FtnFixture, tournament?: FtnTournament, category?: FtnCategory): boolean {
  return isEsport(f, tournament, category) || isUnsupportedFormat(f, tournament);
}

export function eventUrl(f: FtnFixture): string | undefined {
  if (!f.sportSeoName || !f.categorySeoName || !f.tournamentSeoName || !f.seoName) return undefined;
  return `${SITE}/sazeni/${f.sportSeoName}/${f.categorySeoName}/${f.tournamentSeoName}/${f.seoName}`;
}

function teams(f: FtnFixture): { home: string; away: string } | null {
  const home = f.participants?.find((p) => p.type === 'HOME')?.name;
  const away = f.participants?.find((p) => p.type === 'AWAY')?.name;
  if (home && away) return { home: norm(home), away: norm(away) };
  const parts = f.name.split(' - ');
  return parts.length === 2 ? { home: norm(parts[0]), away: norm(parts[1]) } : null;
}

function toInt(s: string | number | undefined): number | undefined {
  const n = typeof s === 'number' ? s : Number(s);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

function pair(s: FtnSideScore | undefined): [number, number] | undefined {
  const h = toInt(s?.Home);
  const a = toInt(s?.Away);
  return h !== undefined && a !== undefined ? [h, a] : undefined;
}

/** Ještě nezačalo: „Začne brzy“, „Začíná …“, „Za 3 m“ (odpočet do začátku), „29.09.26 3:00:00“. */
const NOT_STARTED = /^(začne brzy|začíná|za\s+\d)|^\d{1,2}\.\s?\d{1,2}\.\s?\d{2,4}/i;
/** Prodloužení („Prodl. < 5m“) – číslo periody = počet řádných period + 1. */
const OVERTIME_PERIOD: Partial<Record<Sport, number>> = { football: 3, hockey: 4, basketball: 5, handball: 3, american_football: 5 };
/** Text „1. pol. - 14m“ = uplynulá minuta (běžící hodiny od začátku zápasu). */
const ELAPSED_MINUTE_SPORTS = new Set<Sport>(['football', 'handball']);
/** Text „2. tř. < 3m“ = do konce periody zbývá méně než N minut. */
const COUNTDOWN_SPORTS = new Set<Sport>(['hockey', 'basketball', 'handball', 'american_football']);
/** Stav bodů v rozehraném setu (miniscoreboard PartialScoreL1) – stolní tenis, volejbal. */
const SET_POINTS_SPORTS = new Set<Sport>(['table_tennis', 'volleyball']);

/**
 * Při „Přestávka“ feed často pošle miniscoreboard bez overview.info (periody) – převezmeme
 * poslední známé periody, aby šlo určit, po které periodě přestávka je.
 */
export function mergeMini(prev: FtnMiniScoreboard | undefined, next: FtnMiniScoreboard): FtnMiniScoreboard {
  if (!prev?.overview?.info?.length || next.overview?.info?.length) return next;
  if (NOT_STARTED.test(norm(next.overview?.gameTime))) return next;
  return { ...next, overview: { ...next.overview, info: prev.overview.info } };
}

/**
 * Herní stav z miniscoreboardu (+ volitelně plného scoreboardu z WS). Texty gameTime:
 *  fotbal „1. pol. - 14m“ (uplynulá minuta), hokej „2. tř. < 3m“, basket „3. čt. < 4m“ (zbývá méně než N min),
 *  tenis „2. set“, prodloužení „Prodl. < 5m“, přestávky „Přestávka“ (poločas, mezi třetinami/čtvrtinami),
 *  „Přerušeno“/„Zápas přerušen“, konec „Konec“ / „Zápas skončil“, bez detailu „Probíhá“,
 *  před začátkem „Začne brzy“ / „Začíná …“ / „Za 3 m“. Stolní tenis „4. set“ (TotalScore = sety,
 *  PartialScoreL1 = body v setu, info = body v setech), baseball „1. směna“.
 */
export function parseGameState(
  sport: Sport,
  mini?: FtnMiniScoreboard,
  full?: FtnScoreboard,
): { state?: GameState; started: boolean } {
  // miniscoreboard chodí při každé změně -> jeho text má přednost; plný scoreboard jen pro hodiny
  const text = norm(mini?.overview?.gameTime ?? full?.overview?.gameTime);
  if (!mini && !full) return { started: true };
  if (NOT_STARTED.test(text)) return { state: text ? { statusText: text } : undefined, started: false };

  const st: GameState = {};
  if (text) st.statusText = text;
  const info = [...(mini?.overview?.info ?? full?.overview?.info ?? [])].sort((a, b) => a.order - b.order);
  const periodScores = info
    .map((p) => [toInt(p.home), toInt(p.away)] as const)
    .filter((p): p is readonly [number, number] => p[0] !== undefined && p[1] !== undefined)
    .map((p) => [p[0], p[1]] as [number, number]);
  if (periodScores.length && periodScores.length === info.length) st.periodScores = periodScores;

  const score =
    pair(mini?.columns?.TotalScore) ??
    (full?.summaryScoreboards ? pair({ Home: String(full.summaryScoreboards.Home?.score), Away: String(full.summaryScoreboards.Away?.score) }) : undefined);
  if (score) st.score = score;

  const isBreak = /přestávka|^poločas$|^ht$/i.test(text);
  // „Konec“ = konec zápasu (u všech sportů, periody už jsou finished), „Zápas skončil“
  const finished = /skončil|ukončen|^konec$/i.test(text);
  const interrupted = /přerušen/i.test(text);
  const overtime = /^prodl/i.test(text) ? OVERTIME_PERIOD[sport] : undefined;
  const lead = /^(\d{1,2})\.\s/.exec(text);
  const running = !!lead || overtime !== undefined;
  const maxOrder = info.length ? info[info.length - 1].order : undefined;
  const period = lead ? Number(lead[1]) : overtime ?? (isBreak || interrupted ? maxOrder : undefined);
  if (period !== undefined && Number.isInteger(period) && period >= 1 && period <= 20) st.period = period;

  if (finished) st.finished = true;
  if (isBreak) st.breakFlag = true;
  else if (running) st.breakFlag = false;
  if (isBreak || interrupted || finished) st.clockRunning = false;

  if (ELAPSED_MINUTE_SPORTS.has(sport)) {
    // „1. pol. - 14m“ = uplynulá minuta; „< 3m“ (zbývá) jen u e-sportů – uplynulý čas z toho nejde
    const m = /(\d{1,3})(?:\s*\+\s*(\d{1,2}))?\s*\.?\s*m(?:in)?\b/i.exec(text);
    if (running && m && !text.includes('<')) st.clockSec = (Number(m[1]) + Number(m[2] ?? 0)) * 60;
  }
  if (COUNTDOWN_SPORTS.has(sport)) {
    const m = /<\s*(\d{1,2})\s*m/i.exec(text);
    if (running && m) st.periodRemainingSec = Number(m[1]) * 60;
  }
  if (SET_POINTS_SPORTS.has(sport)) {
    const pts = pair(mini?.columns?.PartialScoreL1);
    if (pts) st.points = `${pts[0]}:${pts[1]}`;
  } else if (sport === 'tennis') {
    const games = pair(mini?.columns?.PartialScoreL1);
    if (games) st.games = games;
    const pts = mini?.columns?.PartialScoreL2 ?? full?.scores;
    if (pts && pts.Home !== undefined && pts.Away !== undefined) st.points = `${pts.Home}:${pts.Away}`;
  }

  // přesné hodiny z plného scoreboardu (jen když ho strategie má – websocket)
  if (full) {
    if (typeof full.eventTime === 'number' && full.eventTime >= 0 && full.eventTime <= 4 * 3600) st.clockSec = full.eventTime;
    if (typeof full.remainingTimeInPeriod === 'number' && full.remainingTimeInPeriod >= 0 && full.remainingTimeInPeriod <= 3600)
      st.periodRemainingSec = full.remainingTimeInPeriod;
    if (typeof full.timerRunning === 'boolean' && !isBreak && !finished) st.clockRunning = full.timerRunning;
  }
  return { state: Object.keys(st).length ? st : undefined, started: true };
}

/** Index struktury (fixture, turnaj, kategorie) přes všechny stránky výpisu. */
export function indexPages(pages: FtnMatchesPage[]): {
  fixtures: FtnFixture[];
  tournaments: Map<string, FtnTournament>;
  categories: Map<string, FtnCategory>;
} {
  const fixtures = new Map<string, FtnFixture>();
  const tournaments = new Map<string, FtnTournament>();
  const categories = new Map<string, FtnCategory>();
  for (const p of pages) {
    for (const t of p.tournaments ?? []) tournaments.set(t.id, t);
    for (const c of p.categories ?? []) categories.set(c.id, c);
    for (const f of p.fixtures ?? []) fixtures.set(f.id, f);
  }
  return { fixtures: [...fixtures.values()], tournaments, categories };
}

/** Fixture, které chceme: naše sporty, žádné e-sporty, správný druh (PREMATCH/LIVE), aktivní. */
export function selectFixtures(pages: FtnMatchesPage[], scope: FeedScope, sports: Sport[]): FtnFixture[] {
  const { fixtures, tournaments, categories } = indexPages(pages);
  const want = scope === 'live' ? 'LIVE' : 'PREMATCH';
  return fixtures.filter((f) => {
    const sport = SPORT_BY_ID.get(f.sportId);
    if (!sport || !sports.includes(sport)) return false;
    if (f.kind !== want) return false;
    if (f.status && f.status !== 'ACTIVE') return false;
    return !isSkipped(f, tournaments.get(f.tournamentId), categories.get(f.categoryId));
  });
}

export function sportOfFixture(f: FtnFixture): Sport | undefined {
  return SPORT_BY_ID.get(f.sportId);
}

/** Celý bundle -> RawEvent[]. */
export function buildEvents(b: FortunaBundle, sports: Sport[] = Object.keys(SPORTS_MAP) as Sport[]): RawEvent[] {
  const { tournaments, categories } = indexPages(b.pages);
  const boards = new Map((b.scoreboards ?? []).map((s) => [s.fixtureId, s]));
  const out: RawEvent[] = [];
  for (const f of selectFixtures(b.pages, b.scope, sports)) {
    const sport = SPORT_BY_ID.get(f.sportId)!;
    const t = teams(f);
    if (!t || !f.startDatetime) continue;
    const markets: RawMarket[] = [];
    const keys = new Set<string>();
    const ids = new Set<string>();
    for (const m of b.markets[f.id] ?? []) {
      if (ids.has(m.id)) continue; // overview a detail můžou obsahovat stejný trh
      ids.add(m.id);
      if (m.kind && m.kind !== f.kind) continue;
      const rm = mapMarket(m, sport, t.home, t.away);
      if (!rm || keys.has(rm.key)) continue;
      keys.add(rm.key);
      markets.push(rm);
    }
    const ev: RawEvent = {
      sourceId: f.id,
      sport,
      competition: norm(tournaments.get(f.tournamentId)?.name ?? ''),
      home: t.home,
      away: t.away,
      startTime: f.startDatetime,
      live: false,
      markets,
    };
    const country = categories.get(f.categoryId)?.name;
    if (country) ev.country = norm(country);
    const url = eventUrl(f);
    if (url) ev.url = url;
    if (b.scope === 'live') {
      const gs = parseGameState(sport, boards.get(f.id), b.clocks?.[f.id]);
      ev.live = gs.started;
      if (gs.state) ev.state = gs.state;
    }
    out.push(ev);
  }
  return out;
}
