// SYNOT TIP (sport.synottip.cz) – platforma eBet, čisté parsování.
//
// Prematch: GetWebStandardEvents → base64 protobuf (proto.ts) se stromem sport → země → liga →
// události. Live: GetLiveEventsWL (live stránka webu; starší GetLIPEvtsDsk = live box na prematch
// stránce má stejný tvar, jen jiný výběr trhů) → čistý JSON (stejné názvy polí, navíc stav zápasu).
// Událost má GameGroups[] → Games[] (typ trhu; `ID` = "<typ>d<detail>" nebo jen "<typ>" u trhů
// s liniemi) → Details[] (jedna linie) → OddsList[] (výběr: Name "1"/"0"/"2", "Pod (2.5)",
// "Tým 1 (-1.5)", "Ano"…, Rate, State). Typ trhu bereme z čísla na začátku Game.ID a navíc
// kontrolujeme název (vč. prodloužení vs. základní doba). Live seznam posílá v každé skupině
// (Hlavní sázky / Góly / Handicap / Gamy / Set / Body) jen JEDEN trh a ten se mění podle stavu
// zápasu – např. "Zápas" nahradí "Který tým vyhraje zbytek zápasu od skóre 5:0" (typ 365),
// "Celkový počet gólů" nahradí "Tým1 celkový počet gólů" (80) → vždy rozhoduje typ + název.
import { marketKey } from '../../core/markets.js';
import type { GameState, MarketScope, MarketType, RawEvent, RawMarket, RawSelection, SelectionKey, Sport } from '../../core/types.js';
import type { PbCategory, PbDetail, PbEvent, PbEventsResponse, PbGame } from './proto.js';

export const ORIGIN = 'https://sport.synottip.cz';

/**
 * Kořenové kategorie sportů (CategoryID pro GetWebStandardEvents) = DisciplineID v live feedu.
 * Seznam: GetWebStandardCategories. E-sporty (87 virtuální, 202 eFotbal, 222 eHokej, 214 eBasketbal)
 * a ostatní sporty vynechány.
 */
export const SPORT_IDS: Partial<Record<Sport, number>> = {
  football: 12,
  hockey: 14,
  tennis: 19,
  basketball: 21,
  handball: 33,
  volleyball: 23,
  table_tennis: 20,
  baseball: 13,
  american_football: 22,
  boxing: 17,
  mma: 35,
  snooker: 39,
  darts: 24,
};
const ID_TO_SPORT: Record<number, Sport> = Object.fromEntries(Object.entries(SPORT_IDS).map(([s, id]) => [id, s as Sport]));

/** Texty feedu obsahují nezlomitelné mezery ("Tým 1 (-1.5)") → sjednotit bílé znaky. */
const norm = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

// ---------- surové typy live feedu (JSON) ----------

export interface SynLiveOdds {
  TipID?: string;
  Name?: string;
  Rate?: number;
  State?: number;
}
export interface SynLiveResult {
  ID?: number;
  Name?: string;
  Score?: string;
  MainResult?: boolean;
  /** 64 = výsledek periody, 1 = gamové skóre (tenis) */
  Flags?: number;
}
export interface SynLiveEvent {
  ID: number;
  Name: string;
  /**
   * Plánovaný začátek (ne skutečný výkop): "2026-09-30T20:45:00+02:00" (GetLiveEventsWL)
   * nebo "/Date(1790793900000+0200)/" (GetLIPEvtsDsk).
   */
  Date: string;
  CategoryPath?: string;
  DisciplineID?: number;
  /**
   * Stav nabídky události (enum webu): 1 Created, 2 Opened, 3 Suspended, 4 Closed.
   * 3 = sázení zastaveno – gól (~3 s), konec zákl. doby (fotbal 90:00), posledních ~3 min hokeje,
   * prodloužení, "Nezačalo", "Ukončeno" … → NEZNAMENÁ konec zápasu. Web při 3 zamkne všechny kurzy.
   */
  State?: number;
  StateName?: string;
  /** Uplynulý herní čas v s od začátku zápasu. */
  StateTime?: number;
  RemainingPeriodTime?: number;
  ClockStopped?: boolean;
  Results?: SynLiveResult[];
  GameGroups?: { ID?: number; Name?: string; Games?: (PbGame & { Details?: (PbDetail & { OddsList?: SynLiveOdds[] })[] })[] }[];
}
export interface SynLiveDiscipline {
  DisciplineID: number;
  Events?: SynLiveEvent[];
}
export interface SynLiveResponse {
  Result: number;
  TimeStamp?: number;
  ReturnValue?: SynLiveDiscipline[] | null;
}

// ---------- mapování trhů ----------

type Kind = '1X2' | 'ML' | 'OU' | 'AH' | 'BTTS' | 'OE' | 'DC';
interface Rule {
  type: MarketType;
  kind: Kind;
  /** Pevný rozsah, nebo číslo periody z názvu trhu ("2. třetina", "1. set", "3. čtvrtina"). */
  scope: MarketScope | 'P' | 'S' | 'Q';
  /** Název trhu (Game.Name) musí odpovídat – ochrana proti posunu významu ID typu. */
  name?: RegExp;
}

/** Prodloužení / nájezdy / extra směny (baseball) v názvu trhu. */
const OT = /prodl|nájezd|extra směn/i;
/**
 * Sporty, kde MATCH = výslovně "(včetně prodloužení …)" / "(včetně extra směn)"; trh bez toho je podle
 * herního plánu (čl. 8.3: výsledek po uplynutí stanovené hrací doby, bez ohledu na prodloužení,
 * pokud název neříká jinak) základní doba.
 */
const MATCH_NEEDS_OT = new Set<Sport>(['hockey', 'basketball', 'baseball', 'american_football']);
const R = (type: MarketType, kind: Kind, scope: Rule['scope'], name?: RegExp): Rule => ({ type, kind, scope, name });

/**
 * ID typu trhu (číslo na začátku Game.ID) → pravidlo. ID a názvy jsou z filtru trhů webu
 * (GetWebStandardEvents → AvailableGames) a ze skutečných odpovědí. **ID nejsou napříč sporty
 * jednoznačná** (209 = tenis "Gamy - Handicap", stolní tenis "Sety - Handicap") → pravidla po
 * sportech + kontrola názvu. Evropský handicap "Handicap 0:1" (5), kombinace, hráčské trhy,
 * přesné výsledky … vynechány.
 */
const RULES: Partial<Record<Sport, Record<number, Rule>>> = {
  football: {
    2: R('1X2', '1X2', 'REG', /^Zápas$/),
    3: R('DC', 'DC', 'REG', /^Dvojtip$/),
    4: R('DNB', 'ML', 'REG', /^Sázka bez remízy$/),
    79: R('OU', 'OU', 'REG', /^Celkový počet gólů$/),
    7: R('AH', 'AH', 'REG', /^Handicap$/),
    88: R('BTTS', 'BTTS', 'REG', /^Oba týmy dají gól$/),
    8: R('OE', 'OE', 'REG', /^Lichá\/Sudá \(počet gólů\)$/),
    80: R('OU_HOME', 'OU', 'REG', /^Tým1 celkový počet gólů$/),
    81: R('OU_AWAY', 'OU', 'REG', /^Tým2 celkový počet gólů$/),
    12: R('1X2', '1X2', 'H1', /^1\. poločas$/),
    13: R('DC', 'DC', 'H1', /^1\. poločas - Dvojtip$/),
    14: R('DNB', 'ML', 'H1', /^1\. poločas - Sázka bez remízy$/),
    113: R('OU', 'OU', 'H1', /^1\. poločas - Počet gólů$/),
    16: R('AH', 'AH', 'H1', /^1\. poločas - Handicap$/),
    117: R('BTTS', 'BTTS', 'H1', /^1\. poločas - Oba týmy dají gól$/),
    114: R('OU_HOME', 'OU', 'H1', /^1\. poločas - Tým1 počet gólů$/),
    115: R('OU_AWAY', 'OU', 'H1', /^1\. poločas - Tým2 počet gólů$/),
    123: R('1X2', '1X2', 'H2', /^2\. poločas$/),
    124: R('DC', 'DC', 'H2', /^2\. poločas - Dvojtip$/),
    125: R('DNB', 'ML', 'H2', /^2\. poločas - Sázka bez remízy$/),
    130: R('OU', 'OU', 'H2', /^2\. poločas - Počet gólů$/),
    127: R('AH', 'AH', 'H2', /^2\. poločas - Handicap$/),
    135: R('BTTS', 'BTTS', 'H2', /^2\. poločas - Oba týmy dají gól$/),
    131: R('OU_HOME', 'OU', 'H2', /^2\. poločas - Tým1 počet gólů$/),
    132: R('OU_AWAY', 'OU', 'H2', /^2\. poločas - Tým2 počet gólů$/),
  },
  hockey: {
    2: R('1X2', '1X2', 'REG', /^Zápas$/),
    // dvojtip = základní doba (kurz "12" odpovídá 1 − P(remíza po 60 min) z 1X2)
    3: R('DC', 'DC', 'REG', /^Dvojtip$/),
    4: R('DNB', 'ML', 'REG', /^Sázka bez remízy$/),
    79: R('OU', 'OU', 'REG', /^Celkový počet gólů$/),
    7: R('AH', 'AH', 'REG', /^Handicap$/),
    88: R('BTTS', 'BTTS', 'REG', /^Oba týmy dají gól$/),
    8: R('OE', 'OE', 'REG', /^Lichá\/Sudá \(počet gólů\)$/),
    80: R('OU_HOME', 'OU', 'REG', /^Tým1 celkový počet gólů$/),
    81: R('OU_AWAY', 'OU', 'REG', /^Tým2 celkový počet gólů$/),
    228: R('ML', 'ML', 'MATCH', /^Vítěz \(včetně prodloužení a sam\. nájezdů\)$/),
    229: R('AH', 'AH', 'MATCH', /^Handicap \(včetně prodloužení a sam\. nájezdů\)$/),
    230: R('OU', 'OU', 'MATCH', /^Počet gólů \(včetně prodloužení a sam\. nájezdů\)$/),
    233: R('1X2', '1X2', 'P', /^[123]\. třetina$/),
    245: R('DC', 'DC', 'P', /^[123]\. třetina - Dvojtip$/),
    240: R('DNB', 'ML', 'P', /^[123]\. třetina - Sázka bez remízy$/),
    235: R('OU', 'OU', 'P', /^1\. třetina - Počet gólů$/),
    236: R('OU', 'OU', 'P', /^2\. třetina - Počet gólů$/),
    237: R('OU', 'OU', 'P', /^3\. třetina - Počet gólů$/),
    241: R('AH', 'AH', 'P', /^1\. třetina - Handicap$/),
    242: R('AH', 'AH', 'P', /^2\. třetina - Handicap$/),
    243: R('AH', 'AH', 'P', /^3\. třetina - Handicap$/),
    238: R('BTTS', 'BTTS', 'P', /^[123]\. třetina - Oba týmy dají gól$/),
  },
  tennis: {
    178: R('ML', 'ML', 'MATCH', /^Vítěz zápasu$/),
    209: R('AH', 'AH', 'MATCH', /^Gamy - Handicap$/),
    210: R('AH_SETS', 'AH', 'MATCH', /^Sety - Handicap$/),
    211: R('OU', 'OU', 'MATCH', /^Celkový počet gamů$/),
    // název je "<jméno hráče> počet gamů"
    212: R('OU_HOME', 'OU', 'MATCH', / počet gamů$/),
    213: R('OU_AWAY', 'OU', 'MATCH', / počet gamů$/),
    356: R('OU_SETS', 'OU', 'MATCH', /^Počet setů$/),
    221: R('ML', 'ML', 'S', /^[1-5]\. set - Vítěz$/),
    222: R('AH', 'AH', 'S', /^[1-5]\. set - Gamy handicap$/),
    223: R('OU', 'OU', 'S', /^[1-5]\. set - Počet gamů$/),
  },
  basketball: {
    // Zápas (1/0/2) = základní hrací doba – ve filtru trhů webu chybí, ale GameIds [2] ho vrací
    2: R('1X2', '1X2', 'REG', /^Zápas$/),
    251: R('ML', 'ML', 'MATCH', /^Vítěz \(včetně prodloužení\)$/),
    252: R('AH', 'AH', 'MATCH', /^Handicap \(včetně prodloužení\)$/),
    253: R('OU', 'OU', 'MATCH', /^Počet bodů \(včetně prodloužení\)$/),
    // "<tým> počet bodů (včetně prodloužení)"
    254: R('OU_HOME', 'OU', 'MATCH', / počet bodů \(včetně prodloužení\)$/),
    255: R('OU_AWAY', 'OU', 'MATCH', / počet bodů \(včetně prodloužení\)$/),
    12: R('1X2', '1X2', 'H1', /^1\. poločas$/),
    14: R('DNB', 'ML', 'H1', /^1\. poločas - Sázka bez remízy$/),
    113: R('OU', 'OU', 'H1', /^1\. poločas - Počet bodů$/),
    16: R('AH', 'AH', 'H1', /^1\. poločas - Handicap$/),
    // 2. poločas a 4. čtvrtina vynechány: u basketu nemusí být jasné, jestli zahrnují prodloužení
    257: R('1X2', '1X2', 'Q', /^[123]\. čtvrtina$/),
    262: R('DNB', 'ML', 'Q', /^[123]\. čtvrtina - Sázka bez remízy$/),
    258: R('OU', 'OU', 'Q', /^1\. čtvrtina - Počet bodů$/),
    259: R('OU', 'OU', 'Q', /^2\. čtvrtina - Počet bodů$/),
    260: R('OU', 'OU', 'Q', /^3\. čtvrtina - Počet bodů$/),
    263: R('AH', 'AH', 'Q', /^1\. čtvrtina - Handicap$/),
    264: R('AH', 'AH', 'Q', /^2\. čtvrtina - Handicap$/),
    265: R('AH', 'AH', 'Q', /^3\. čtvrtina - Handicap$/),
  },
  // házená: vše bez "(včetně prodloužení)" = 60 min (herní plán čl. 8.3); vítěz vč. prodloužení Synot nevypisuje
  handball: {
    2: R('1X2', '1X2', 'REG', /^Zápas$/),
    3: R('DC', 'DC', 'REG', /^Dvojtip$/),
    4: R('DNB', 'ML', 'REG', /^Sázka bez remízy$/),
    79: R('OU', 'OU', 'REG', /^Celkový počet gólů$/),
    7: R('AH', 'AH', 'REG', /^Handicap$/),
    8: R('OE', 'OE', 'REG', /^Lichá\/Sudá \(počet gólů\)$/),
    80: R('OU_HOME', 'OU', 'REG', /^Tým1 celkový počet gólů$/),
    81: R('OU_AWAY', 'OU', 'REG', /^Tým2 celkový počet gólů$/),
    12: R('1X2', '1X2', 'H1', /^1\. poločas$/),
    13: R('DC', 'DC', 'H1', /^1\. poločas - Dvojtip$/),
    14: R('DNB', 'ML', 'H1', /^1\. poločas - Sázka bez remízy$/),
    113: R('OU', 'OU', 'H1', /^1\. poločas - Počet gólů$/),
    16: R('AH', 'AH', 'H1', /^1\. poločas - Handicap$/),
    17: R('OE', 'OE', 'H1', /^1\. poločas - Lichá\/Sudá \(počet gólů\)$/),
    123: R('1X2', '1X2', 'H2', /^2\. poločas$/),
    124: R('DC', 'DC', 'H2', /^2\. poločas - Dvojtip$/),
    125: R('DNB', 'ML', 'H2', /^2\. poločas - Sázka bez remízy$/),
    134: R('OE', 'OE', 'H2', /^2\. poločas - Lichá\/Sudá \(počet gólů\)$/),
  },
  volleyball: {
    178: R('ML', 'ML', 'MATCH', /^Vítěz zápasu$/),
    210: R('AH_SETS', 'AH', 'MATCH', /^Sety - Handicap$/),
    356: R('OU_SETS', 'OU', 'MATCH', /^Počet setů$/),
    269: R('OU', 'OU', 'MATCH', /^Celkový počet bodů$/),
    8: R('OE', 'OE', 'MATCH', /^Lichá\/Sudá \(počet bodů\)$/),
    221: R('ML', 'ML', 'S', /^[1-5]\. set - Vítěz$/),
    287: R('OU', 'OU', 'S', /^[1-5]\. set - Počet bodů$/),
    288: R('OE', 'OE', 'S', /^[1-5]\. set - Lichá\/Sudá \(počet bodů\)$/),
  },
  table_tennis: {
    178: R('ML', 'ML', 'MATCH', /^Vítěz zápasu$/),
    // 209 je u stolního tenisu handicap na sety (u tenisu na gamy!) – zatím jen v live
    209: R('AH_SETS', 'AH', 'MATCH', /^Sety - Handicap$/),
    268: R('AH', 'AH', 'MATCH', /^Body - Handicap$/),
    269: R('OU', 'OU', 'MATCH', /^Celkový počet bodů$/),
    // body jednoho hráče za zápas ("Tým1 celkový počet bodů", linie ~37.5 při celku ~74.5); zatím jen v live,
    // kde nahrazuje "Celkový počet bodů" (jako u fotbalu 79 → 80)
    80: R('OU_HOME', 'OU', 'MATCH', /^Tým1 celkový počet bodů$/),
    81: R('OU_AWAY', 'OU', 'MATCH', /^Tým2 celkový počet bodů$/),
    249: R('ML', 'ML', 'S', /^[1-5]\. set$/),
    270: R('AH', 'AH', 'S', /^[1-5]\. set - Body handicap$/),
    271: R('OU', 'OU', 'S', /^[1-5]\. set - Počet bodů$/),
    250: R('OE', 'OE', 'S', /^[1-5]\. set - Lichá\/Sudá \(počet bodů\)$/),
  },
  // baseball: "Zápas" 1/0/2 = 9 směn (remíza = nerozhodno po 9. směně; jen MLB – viz eventMarkets). Důkaz z kurzů
  // (1. 10. 2026, 3 zápasy MLB): P(remíza) 10,7–11,5 % a ML vč. extra směn ≈ P(1) + P(X)/2 (0,550 vs 0,550, 0,562
  // vs 0,570, 0,490 vs 0,487); Synot "9 směn" výslovně neuvádí (herní plán čl. 8.3: hrací doba bez prodloužení).
  // Trhy se jmény nadhazovačů Synot nemá. "Směny 1 až 5", jednotlivé směny, odpaly, bezbodové směny a hráčské
  // statistiky vynechány.
  baseball: {
    2: R('1X2', '1X2', 'REG', /^Zápas$/),
    293: R('ML', 'ML', 'MATCH', /^Vítěz \(včetně extra směn\)$/),
    294: R('AH', 'AH', 'MATCH', /^Handicap \(včetně extra směn\)$/),
    295: R('OU', 'OU', 'MATCH', /^Počet bodů \(včetně extra směn\)$/),
    // "<tým> počet bodů (včetně extra směn)"
    296: R('OU_HOME', 'OU', 'MATCH', / počet bodů \(včetně extra směn\)$/),
    297: R('OU_AWAY', 'OU', 'MATCH', / počet bodů \(včetně extra směn\)$/),
    298: R('OE', 'OE', 'MATCH', /^Lichá\/Sudá - Počet bodů \(včetně extra směn\)$/),
  },
  // americký fotbal: "Vítěz (včetně prodloužení)" (251) vynechán – Synot neuvádí, jak vyhodnotí remízu
  // po prodloužení (NFL, CFL). 2. poločas a 4. čtvrtina vynechány (jako u basketu).
  american_football: {
    2: R('1X2', '1X2', 'REG', /^Zápas$/),
    252: R('AH', 'AH', 'MATCH', /^Handicap \(včetně prodloužení\)$/),
    253: R('OU', 'OU', 'MATCH', /^Počet bodů \(včetně prodloužení\)$/),
    254: R('OU_HOME', 'OU', 'MATCH', / počet bodů \(včetně prodloužení\)$/),
    255: R('OU_AWAY', 'OU', 'MATCH', / počet bodů \(včetně prodloužení\)$/),
    256: R('OE', 'OE', 'MATCH', /^Lichá\/Sudá - Počet bodů \(včetně prodloužení\)$/),
    12: R('1X2', '1X2', 'H1', /^1\. poločas$/),
    14: R('DNB', 'ML', 'H1', /^1\. poločas - Sázka bez remízy$/),
    113: R('OU', 'OU', 'H1', /^1\. poločas - Počet bodů$/),
    16: R('AH', 'AH', 'H1', /^1\. poločas - Handicap$/),
    17: R('OE', 'OE', 'H1', /^1\. poločas - Lichá\/Sudá \(počet bodů\)$/),
    257: R('1X2', '1X2', 'Q', /^[123]\. čtvrtina$/),
    262: R('DNB', 'ML', 'Q', /^[123]\. čtvrtina - Sázka bez remízy$/),
    258: R('OU', 'OU', 'Q', /^1\. čtvrtina - Počet bodů$/),
    259: R('OU', 'OU', 'Q', /^2\. čtvrtina - Počet bodů$/),
    260: R('OU', 'OU', 'Q', /^3\. čtvrtina - Počet bodů$/),
    263: R('AH', 'AH', 'Q', /^1\. čtvrtina - Handicap$/),
    264: R('AH', 'AH', 'Q', /^2\. čtvrtina - Handicap$/),
    265: R('AH', 'AH', 'Q', /^3\. čtvrtina - Handicap$/),
  },
  // MMA / box: jen "Zápas" 1/0/2 (vč. remízy). "Vítěz zápasu" (178, dvoucestný) vynechán – Synot
  // neuvádí, jak ho vyhodnotí při remíze (ML je zakázané, DNB jen s výslovným vrácením vkladu).
  // Počet kol (79) a způsob výhry vynechány.
  mma: {
    2: R('1X2', '1X2', 'REG', /^Zápas$/),
  },
  boxing: {
    2: R('1X2', '1X2', 'REG', /^Zápas$/),
  },
  snooker: {
    178: R('ML', 'ML', 'MATCH', /^Vítěz zápasu$/),
    1276: R('AH', 'AH', 'MATCH', /^Framy - Handicap$/),
    1277: R('OU', 'OU', 'MATCH', /^Počet framů$/),
  },
  // šipky: AH/OU|MATCH jen na legy, sety zvlášť (AH_SETS/OU_SETS); v setu handicap/počet legů
  darts: {
    178: R('ML', 'ML', 'MATCH', /^Vítěz zápasu$/),
    210: R('AH_SETS', 'AH', 'MATCH', /^Sety - Handicap$/),
    356: R('OU_SETS', 'OU', 'MATCH', /^Počet setů$/),
    1587: R('OU', 'OU', 'MATCH', /^Celkový počet legů$/),
    221: R('ML', 'ML', 'S', /^[1-5]\. set - Vítěz$/),
    700: R('AH', 'AH', 'S', /^[1-5]\. set - Legy handicap$/),
    701: R('OU', 'OU', 'S', /^[1-5]\. set - Počet legů$/),
  },
};

/**
 * Typ trhu, který vrací hlavní nabídka (bez filtru GameIds) – nemusí být namapovaný
 * (americký fotbal 251, MMA/box 178). Ostatní typy z RULES se stahují filtrem GameIds.
 */
const MAIN_GAME_ID: Partial<Record<Sport, number>> = {
  football: 2,
  hockey: 2,
  handball: 2,
  tennis: 178,
  volleyball: 178,
  table_tennis: 178,
  snooker: 178,
  darts: 178,
  boxing: 178,
  mma: 178,
  basketball: 251,
  american_football: 251,
  baseball: 293,
};

/** ID typů trhů, které prematch stahuje filtrem GameIds (druhý požadavek). */
export const PREMATCH_GAME_IDS: Partial<Record<Sport, number[]>> = Object.fromEntries(
  Object.entries(RULES).map(([s, rules]) => [s, Object.keys(rules).map(Number).filter((id) => id !== MAIN_GAME_ID[s as Sport])]),
);

/**
 * Sporty, u kterých hlavní výpis (bez GameIds) vrací nenamapovaný trh (americký fotbal 251, MMA/box 178) – jejich
 * namapované trhy (1X2, handicap, total …) přijdou jen s filtrem GameIds, a to jen pro zápasy v okně. Protože jsou
 * malé (MMA a box pár kB, americký fotbal ~450 kB za týden), mají vlastní požadavek s delším oknem.
 */
export const NICHE_SPORTS: Sport[] = (Object.keys(RULES) as Sport[]).filter((s) => RULES[s]?.[MAIN_GAME_ID[s] ?? -1] === undefined);

/** Sjednocení GameIds pro jeden požadavek přes všechny sporty (filtr GameIds platí pro všechny sporty najednou). */
export function prematchGameIds(sports: Sport[]): number[] {
  return [...new Set(sports.flatMap((s) => PREMATCH_GAME_IDS[s] ?? []))].sort((a, b) => a - b);
}

const REQUIRED: Record<Kind, number> = { '1X2': 3, ML: 2, OU: 2, AH: 2, BTTS: 2, OE: 2, DC: 3 };

/** ID typu trhu z Game.ID ("233d462443661" → 233, "79" → 79). */
export function gameTypeId(id: string | undefined): number | undefined {
  const m = /^(\d+)(?:d\d+)?$/.exec(id ?? '');
  return m ? Number(m[1]) : undefined;
}

function periodScope(name: string, prefix: 'P' | 'S' | 'Q'): MarketScope | null {
  const n = /^(\d)\.\s*(třetina|set|čtvrtina)/i.exec(name)?.[1];
  if (!n) return null;
  const max = prefix === 'P' ? 3 : prefix === 'Q' ? 4 : 5;
  return Number(n) >= 1 && Number(n) <= max ? (`${prefix}${n}` as MarketScope) : null;
}

/** "2.5" / "+1.5" / "-0" → číslo; jen celé a půlové linie (čtvrtinové x.25/x.75 = rozdělená sázka). */
function parseLine(s: string): number | undefined {
  const v = Number(s.replace(',', '.'));
  if (!Number.isFinite(v)) return undefined;
  return Math.abs(v * 2 - Math.round(v * 2)) < 1e-9 ? v : undefined;
}

interface Sel {
  key: SelectionKey;
  line?: number;
}

/** Název výběru → kanonický klíč (+ linie z pohledu domácích u AH). */
function selectionOf(kind: Kind, name: string): Sel | null | undefined {
  const n = norm(name);
  switch (kind) {
    case '1X2':
      return n === '1' ? { key: 'HOME' } : n === '0' ? { key: 'DRAW' } : n === '2' ? { key: 'AWAY' } : null;
    case 'ML':
      return n === '1' ? { key: 'HOME' } : n === '2' ? { key: 'AWAY' } : null;
    case 'BTTS':
      return n === 'Ano' ? { key: 'YES' } : n === 'Ne' ? { key: 'NO' } : null;
    case 'OE':
      return n === 'Lichá' ? { key: 'ODD' } : n === 'Sudá' ? { key: 'EVEN' } : null;
    case 'DC':
      // "10" = 1X, "12" = 12, "02" = X2
      return n === '10' ? { key: 'HOME_DRAW' } : n === '12' ? { key: 'HOME_AWAY' } : n === '02' ? { key: 'DRAW_AWAY' } : null;
    case 'OU': {
      const m = /^(Pod|Nad) \(([^)]+)\)$/.exec(n);
      if (!m) return null;
      const line = parseLine(m[2]);
      return line === undefined ? undefined : { key: m[1] === 'Nad' ? 'OVER' : 'UNDER', line };
    }
    case 'AH': {
      // "Tým 1 (-1.5)" / "Tým 2 (+1.5)" – linie domácích = číslo u Týmu 1, u Týmu 2 opačné znaménko
      const m = /^Tým ([12]) \(([^)]+)\)$/.exec(n);
      if (!m) return null;
      const v = parseLine(m[2]);
      if (v === undefined) return undefined;
      return m[1] === '1' ? { key: 'HOME', line: v } : { key: 'AWAY', line: -v };
    }
  }
}

/**
 * Stav události/trhu/linie/výběru (OfferItemState webu): 0 None (prematch protobuf neposílá),
 * 2 Opened = aktivní; 1 Created, 3 Suspended, 4 Closed = ne. Suspendovaný výběr chodí v live s
 * `Rate: 0` → celá linie se vynechá (web zamkne jen ten výběr, ostatní nechá – typicky jde o
 * favorita s kurzem < 1.01, takže o arb nepřicházíme).
 */
const isOpenState = (s: number | undefined) => s === undefined || s === 0 || s === 2;

function odds2dp(rate: number | undefined): number | null {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return null;
  // prematch posílá float32 (2.3499999) → zaokrouhlit na 2 místa, web ukazuje totéž
  const o = Math.round(rate * 100) / 100;
  return o >= 1.01 ? o : null;
}

/**
 * Jeden Synot trh (Game) → 0..n kanonických trhů (každý Detail = jedna linie).
 * `eventOpen` = false (událost ve stavu Suspended/Closed) zavře všechny trhy – web v tu chvíli
 * zamyká všechny kurzy události, i kdyby výběry samy hlásily Opened.
 */
export function mapGame(sport: Sport, g: PbGame, eventOpen = true): RawMarket[] {
  const typeId = gameTypeId(g.ID);
  if (typeId === undefined) return [];
  const rule = RULES[sport]?.[typeId];
  const name = norm(g.Name);
  if (!rule || (rule.name && !rule.name.test(name))) return [];
  // pojistka rozsahu: REG/periody nesmí mluvit o prodloužení, MATCH hokeje/basketu/baseballu/amer. fotbalu ho mít musí
  if (rule.scope !== 'MATCH' && OT.test(name)) return [];
  if (rule.scope === 'MATCH' && MATCH_NEEDS_OT.has(sport) && !OT.test(name)) return [];
  const scope = rule.scope === 'P' || rule.scope === 'S' || rule.scope === 'Q' ? periodScope(name, rule.scope) : rule.scope;
  if (!scope) return [];

  const out: RawMarket[] = [];
  const seen = new Set<string>();
  for (const d of g.Details ?? []) {
    const sels: RawSelection[] = [];
    let line: number | undefined;
    let bad = false;
    for (const o of d.OddsList ?? []) {
      const s = selectionOf(rule.kind, o.Name ?? '');
      if (s === null) {
        bad = true; // neznámý výběr → linii vynechat celou
        break;
      }
      if (s === undefined) {
        bad = true; // čtvrtinová linie
        break;
      }
      if (s.line !== undefined) {
        if (line !== undefined && Math.abs(line - s.line) > 1e-9) {
          bad = true; // výběry jedné linie nesouhlasí
          break;
        }
        line = s.line;
      }
      const odds = odds2dp(o.Rate);
      if (odds === null) {
        // dvojtip: výběry jsou samostatné sázky (detektor je bere jednotlivě) → chybějící/zamčený
        // výběr (Synot "12" s kurzem ≤ 1.00 vůbec nevypisuje) jen vynechat
        if (rule.kind === 'DC') continue;
        bad = true; // suspendovaný výběr bez kurzu (Rate 0)
        break;
      }
      sels.push({ key: s.key, odds, open: isOpenState(o.State), rawName: o.Name });
    }
    const complete = rule.kind === 'DC' ? sels.length >= 1 : sels.length === REQUIRED[rule.kind];
    if (bad || !complete || new Set(sels.map((s) => s.key)).size !== sels.length) continue;
    if (rule.kind === 'OU' && (line === undefined || line < 0)) continue;
    if (rule.kind === 'AH' && line === undefined) continue;
    const key = marketKey(rule.type, scope, line);
    if (seen.has(key)) continue;
    seen.add(key);
    // Game.State posílá jen live JSON (prematch protobuf ho nemá → undefined = otevřeno)
    const detailOpen = eventOpen && isOpenState(g.State) && isOpenState(d.State) && !d.Suspended;
    out.push({
      key,
      open: detailOpen && sels.some((s) => s.open !== false),
      selections: sels,
      sourceId: String(d.ID ?? g.ID),
      rawName: name,
    });
  }
  return out;
}

function mapGroups(sport: Sport, groups: PbEvent['GameGroups'], eventOpen = true): RawMarket[] {
  const out: RawMarket[] = [];
  const keys = new Set<string>();
  for (const gg of groups ?? []) {
    for (const g of gg.Games ?? []) {
      for (const m of mapGame(sport, g, eventOpen)) {
        if (keys.has(m.key)) continue;
        keys.add(m.key);
        out.push(m);
      }
    }
  }
  return out;
}

/**
 * Baseball: "Zápas" 1/0/2 (9 směn) a "Vítěz (včetně extra směn)" jen pro MLB. V NPB, KBO, CPBL a přátelácích může
 * zápas skončit remízou i po extra směnách a herní plán neříká, zda se u vítěze remíza vrací; "Zápas" Synot mimo
 * MLB nevypisuje, takže jeho význam (9 směn) ověřit nejde. AH/OU vč. extra směn se vyhodnotí podle konečného skóre.
 */
const BASEBALL_FULL = /\bMLB\b/;
/** Volejbal: přátelské zápasy (formát na pevný počet setů) a zlatý set vynechat celé. */
const VOLLEYBALL_SKIP = /přátel|zlatý set|golden set/i;
/** Šipky: ligová kola (Premier League) končí i remízou – "Vítěz zápasu" by neměl definované vyhodnocení. */
const DARTS_DRAW_POSSIBLE = /premier league|liga|league/i;

/** Úpravy trhů podle soutěže; null = událost vynechat. */
function eventMarkets(sport: Sport, competition: string, name: string, markets: RawMarket[]): RawMarket[] | null {
  if (sport === 'volleyball' && (VOLLEYBALL_SKIP.test(competition) || VOLLEYBALL_SKIP.test(name))) return null;
  if (sport === 'baseball' && !BASEBALL_FULL.test(competition)) {
    const drop = new Set([marketKey('ML', 'MATCH'), marketKey('1X2', 'REG')]);
    return markets.filter((m) => !drop.has(m.key));
  }
  if (sport === 'darts' && DARTS_DRAW_POSSIBLE.test(competition)) return markets.filter((m) => m.key !== marketKey('ML', 'MATCH'));
  return markets;
}

/** "Domácí - Hosté"; jméno obsahující víc " - " je nejednoznačné → null (tenis "Příjmení, Jméno"). */
export function splitName(name: string): [string, string] | null {
  const parts = norm(name).split(' - ');
  if (parts.length !== 2) return null;
  const [h, a] = parts.map((p) => p.trim());
  return h && a ? [h, a] : null;
}

export const eventUrl = (id: number | string) => `${ORIGIN}/zapas/${id}`;
export const liveEventUrl = (id: number | string) => `${ORIGIN}/live/live-zapas/${id}`;

// ---------- prematch ----------

interface Located {
  e: PbEvent;
  sport: Sport;
  competition: string;
  country?: string;
}

/** Strom kategorií → události se sportem, zemí (2. úroveň pod sportem) a ligou (nejhlubší úroveň). */
function flatten(r: PbEventsResponse): Located[] {
  const out: Located[] = [];
  for (const sportCat of r.EventTree?.Categories ?? []) {
    const sport = ID_TO_SPORT[Number(sportCat.Base?.Id)];
    if (!sport || sportCat.IsVirtual) continue;
    const walk = (c: PbCategory, path: string[]) => {
      const names = norm(c.Base?.Name) ? [...path, norm(c.Base?.Name)] : path;
      for (const e of c.Base?.Events ?? []) {
        out.push({ e, sport, competition: names[names.length - 1] ?? '', country: names.length > 1 ? names[0] : undefined });
      }
      for (const sub of c.Categories ?? []) walk(sub, names);
    };
    for (const c of sportCat.Categories ?? []) walk(c, []);
  }
  return out;
}

export interface ParseOptions {
  now: number;
  sports?: Sport[];
}

/**
 * Prematch: hlavní nabídka (bez filtru trhů – všechny zápasy s hlavním trhem) + odpovědi s
 * vybranými trhy (filtr GameIds, jen blízké zápasy). Trhy stejné události se sloučí.
 */
export function parsePrematch(responses: PbEventsResponse[], o: ParseOptions): RawEvent[] {
  const byId = new Map<string, RawEvent>();
  for (const r of responses) {
    for (const { e, sport, competition, country } of flatten(r)) {
      if (o.sports && !o.sports.includes(sport)) continue;
      if (e.Id === undefined || e.IsLive) continue;
      const startTime = e.Date?.Value;
      if (typeof startTime !== 'number' || !Number.isFinite(startTime) || startTime <= o.now) continue; // už začal
      const teams = splitName(e.Name ?? '');
      if (!teams) continue;
      const id = String(e.Id);
      const markets = eventMarkets(sport, competition, e.Name ?? '', mapGroups(sport, e.GameGroups));
      if (!markets) continue;
      // událost bez jediného trhu (hlavní výpis vrací jen "Vítěz zápasu"/"Zápas", který se u boxu, MMA a amerického
      // fotbalu nemapuje; nebo nemá otevřený / úplný hlavní trh) nemá cenu; vedlejší trhy se sloučí, až přijdou
      if (!markets.length) continue;
      const cur = byId.get(id);
      if (cur) {
        const keys = new Set(cur.markets.map((m) => m.key));
        for (const m of markets) if (!keys.has(m.key)) cur.markets.push(m);
        continue;
      }
      const ev: RawEvent = { sourceId: id, sport, competition, home: teams[0], away: teams[1], startTime, live: false, markets, url: eventUrl(id) };
      if (country) ev.country = country;
      byId.set(id, ev);
    }
  }
  return [...byId.values()];
}

// ---------- live ----------

/**
 * Datum z API → epoch ms: WCF "/Date(1790690400000+0200)/" (číslo je UTC ms, posun jen informativní)
 * nebo ISO s posunem "2026-09-30T20:45:00+02:00" (GetLiveEventsWL).
 */
export function parseWcfDate(s: string | undefined): number | undefined {
  const m = /\/Date\((-?\d+)(?:[+-]\d{4})?\)\//.exec(s ?? '');
  if (m) return Number(m[1]);
  if (!s || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) return undefined;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
}

function parseScore(s: string | undefined): [number, number] | undefined {
  const m = /^(\d+):(\d+)$/.exec((s ?? '').trim());
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}

/**
 * "Poločas" (fotbal, házená), "Přestávka" (hokej, basket, volejbal, stolní tenis mezi sety, baseball),
 * "Pauza" (šipky), "Čekání na prodloužení" (před prodloužením).
 */
const BREAK_RE = /^poločas$|přestávk|pauza|^čekání/i;
/** Konec zápasu jen z textu – event State 3 (Suspended) chodí i při gólu, v prodloužení, 3 min před koncem hokeje … */
const FINISHED_RE = /^ukončen|^konec zápasu$|^konec$|^po prodloužení$|^po (sam\.\s*|samostatných\s*)?nájezd/i;
/**
 * Sporty, u kterých feed posílá použitelné hodiny (StateTime = uplynulé s od začátku zápasu, RemainingPeriodTime).
 * Volejbal, stolní tenis, baseball, šipky a snooker hodiny nemají; u amerického fotbalu, MMA a boxu nebyl živý
 * vzorek → hodiny se nepřebírají (jen text stavu, perioda a skóre).
 */
const CLOCK_SPORTS = new Set<Sport>(['football', 'hockey', 'basketball', 'handball']);
/** Zápas je v live nabídce, ale ještě nezačal. */
const NOT_STARTED_RE = /^nezačal/i;

/**
 * Stav z live feedu: StateName (surový text: "1. poločas", "Poločas", "2. třetina", "Přestávka",
 * "3. set", "Nezačalo", "Přerušeno", "Čekání na prodloužení", "Prodloužení", "Po prodloužení",
 * "Ukončeno"; baseball "5. směna top/bottom"; šipky a snooker jen "Probíhá" / "Pauza"), StateTime
 * (uplynulé s – jen sporty s hodinami: fotbal, hokej, basket, házená), RemainingPeriodTime,
 * ClockStopped, Results[] (hlavní skóre = góly/body/sety/framy, periody s Flags 64 – poločasy,
 * třetiny, sety, směny –, tenisové "Game skóre" s Flags 1). Event `State` se na konec zápasu nepoužívá.
 */
export function parseState(e: SynLiveEvent, sport: Sport): GameState {
  const st: GameState = {};
  const text = norm(e.StateName);
  if (text) st.statusText = text;
  const results = e.Results ?? [];
  const main = results.find((r) => r.MainResult) ?? results.find((r) => r.ID === 1);
  const score = parseScore(main?.Score);
  if (score) st.score = score;
  const periods = results.filter((r) => r !== main && ((r.Flags ?? 0) & 64) !== 0 && /^\d{1,2}\.\s/.test(norm(r.Name)));
  const periodScores = periods.map((r) => parseScore(r.Score)).filter((x): x is [number, number] => !!x);
  if (periodScores.length && periodScores.length === periods.length) st.periodScores = periodScores;

  // "1. prodloužení" není 1. perioda → prodloužení periodu nenastavuje; baseball "10. směna top" → 10
  const per = /^(\d{1,2})\.\s*(poločas|třetina|čtvrtina|set|směna)/i.exec(text);
  if (per) st.period = Number(per[1]);
  else if (BREAK_RE.test(text) && periods.length) st.period = periods.length; // přestávka po n-té periodě
  if (BREAK_RE.test(text)) st.breakFlag = true;
  if (FINISHED_RE.test(text)) st.finished = true;

  if (sport === 'tennis') {
    if (st.period && periodScores.length >= st.period) st.games = periodScores[st.period - 1];
    const pts = results.find((r) => ((r.Flags ?? 0) & 1) !== 0 && /game/i.test(r.Name ?? ''));
    if (pts?.Score) st.points = pts.Score.trim();
  } else if (CLOCK_SPORTS.has(sport)) {
    if (typeof e.StateTime === 'number' && e.StateTime >= 0 && e.StateTime < 4 * 3600) st.clockSec = e.StateTime;
    if (typeof e.RemainingPeriodTime === 'number' && e.RemainingPeriodTime >= 0 && e.RemainingPeriodTime <= 3600) {
      st.periodRemainingSec = e.RemainingPeriodTime;
    }
    if (typeof e.ClockStopped === 'boolean' && (st.clockSec !== undefined || st.periodRemainingSec !== undefined)) st.clockRunning = !e.ClockStopped;
  }
  if (st.breakFlag || st.finished || /^přerušeno/i.test(text)) st.clockRunning = false;
  return st;
}

/**
 * GetLiveEventsWL / GetLIPEvtsDsk → RawEvent[]. "Nezačalo" = v live nabídce před začátkem →
 * `live: false` (jinak by Synot přepnul kanonickou událost do LIVE ještě před výkopem).
 * Event State 3/4 (Suspended/Closed) → všechny trhy `open: false` (v praxi feed trhy v tu chvíli
 * rovnou vynechává). Id události je stejné jako v prematch nabídce, `startTime` = plánovaný začátek.
 */
export function parseLive(r: SynLiveResponse, o: ParseOptions): RawEvent[] {
  const out: RawEvent[] = [];
  const seen = new Set<string>();
  for (const d of r.ReturnValue ?? []) {
    const sport = ID_TO_SPORT[d.DisciplineID];
    if (!sport || (o.sports && !o.sports.includes(sport))) continue;
    for (const e of d.Events ?? []) {
      const id = String(e.ID);
      const startTime = parseWcfDate(e.Date);
      const teams = splitName(e.Name ?? '');
      if (!teams || startTime === undefined || seen.has(id)) continue;
      seen.add(id);
      const path = norm(e.CategoryPath).split(' / ').map((s) => s.trim());
      const eventOpen = isOpenState(e.State);
      const competition = path.length > 1 ? path.slice(1).join(' / ') : (path[0] ?? '');
      const markets = eventMarkets(sport, competition, e.Name ?? '', mapGroups(sport, e.GameGroups as PbEvent['GameGroups'], eventOpen));
      if (!markets) continue;
      const ev: RawEvent = {
        sourceId: id,
        sport,
        competition,
        home: teams[0],
        away: teams[1],
        startTime,
        live: !NOT_STARTED_RE.test(norm(e.StateName)),
        state: parseState(e, sport),
        markets,
        url: liveEventUrl(id),
      };
      if (path.length > 1 && path[0]) ev.country = path[0];
      out.push(ev);
    }
  }
  return out;
}
