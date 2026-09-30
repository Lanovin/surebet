// Mapování trhů Sportradar UOF (id trhu + specifikátory + id výsledku) na kanonické trhy.
// Altenar (kingsbet) posílá UOF id trhu jako market.typeId a id výsledku jako odd.typeId,
// betx je posílá v Odds[].UofKey ("uof:3/sr:sport:4/18/13?total=5.5"). Sdílí to oba adaptéry.
// Používá ho i sdílené parsování Altenar (common/altenar.ts – Kingsbet a MerkurXtip).
import type { MarketScope, MarketType, RawMarket, RawSelection, SelectionKey, Sport } from '../../core/types.js';
import { marketKey } from '../../core/markets.js';

/** Scope trhu: pevný, nebo perioda/čtvrtina/set ze specifikátoru. */
type ScopeDef = MarketScope | 'PERIOD' | 'QUARTER' | 'SET';

export interface UofDef {
  type: MarketType;
  scope: ScopeDef;
  /** Specifikátory trhu v abecedním pořadí (Altenar je v tomto pořadí spojuje "|" do market.sv). */
  specs: string[];
  /**
   * Povinná shoda s názvem trhu (Altenar posílá název, betx ne): pojistka tam, kde stejné UOF id
   * znamená v různých sportech jinou jednotku (187 = gemy v tenise, ale sety ve stolním tenise).
   */
  name?: RegExp;
}

const d = (type: MarketType, scope: ScopeDef, ...specs: string[]): UofDef => ({ type, scope, specs: specs.sort() });
/** Definice s povinnou shodou názvu trhu (jednotka handicapu/totalu). */
const n = (name: RegExp, def: UofDef): UofDef => ({ ...def, name });

const SETS = /\bset/i;
const LEGS = /\bleg/i;
const FRAMES = /fram/i;
const POINTS = /\bbod/i;

/** Trhy základní hrací doby (UOF: trhy bez "(incl. overtime)" platí jen pro základní dobu). */
const REG_MARKETS: Record<number, UofDef> = {
  1: d('1X2', 'REG'),
  10: d('DC', 'REG'), // dvojtip: výsledky 9 = 1X, 10 = 12, 11 = X2
  11: d('DNB', 'REG'),
  16: d('AH', 'REG', 'hcp'),
  18: d('OU', 'REG', 'total'),
  19: d('OU_HOME', 'REG', 'total'),
  20: d('OU_AWAY', 'REG', 'total'),
  26: d('OE', 'REG'),
  29: d('BTTS', 'REG'),
};

const H1_MARKETS: Record<number, UofDef> = {
  60: d('1X2', 'H1'),
  63: d('DC', 'H1'),
  64: d('DNB', 'H1'),
  66: d('AH', 'H1', 'hcp'),
  68: d('OU', 'H1', 'total'),
  69: d('OU_HOME', 'H1', 'total'),
  70: d('OU_AWAY', 'H1', 'total'),
};

const H2_MARKETS: Record<number, UofDef> = {
  83: d('1X2', 'H2'),
  85: d('DC', 'H2'),
  86: d('DNB', 'H2'),
  88: d('AH', 'H2', 'hcp'),
  90: d('OU', 'H2', 'total'),
  91: d('OU_HOME', 'H2', 'total'),
  92: d('OU_AWAY', 'H2', 'total'),
};

/** Vítěz 186 u sportů bez remízy (tenis, stolní tenis, volejbal, šipky, snooker). */
const WINNER = d('ML', 'MATCH');

const UOF_BY_SPORT: Partial<Record<Sport, Record<number, UofDef>>> = {
  football: {
    ...REG_MARKETS,
    ...H1_MARKETS,
    74: d('OE', 'H1'),
    75: d('BTTS', 'H1'),
    ...H2_MARKETS,
    94: d('OE', 'H2'),
    95: d('BTTS', 'H2'),
  },
  hockey: {
    ...REG_MARKETS,
    406: d('ML', 'MATCH'), // vítěz vč. prodloužení a nájezdů
    410: d('AH', 'MATCH', 'hcp'),
    412: d('OU', 'MATCH', 'total'),
    443: d('1X2', 'PERIOD', 'periodnr'),
    446: d('OU', 'PERIOD', 'periodnr', 'total'),
    452: d('BTTS', 'PERIOD', 'periodnr'),
    459: d('DNB', 'PERIOD', 'periodnr'),
    460: d('AH', 'PERIOD', 'hcp', 'periodnr'),
    462: d('OE', 'PERIOD', 'periodnr'),
    529: d('DC', 'PERIOD', 'periodnr'), // „Výsledek 1. třetiny – dvojtip“ / „1 třetina - dvojitá šance“ (betx UofKey 529/9?periodnr=1)
  },
  basketball: {
    ...REG_MARKETS,
    219: d('ML', 'MATCH'), // vítěz vč. prodloužení
    223: d('AH', 'MATCH', 'hcp'),
    225: d('OU', 'MATCH', 'total'),
    227: d('OU_HOME', 'MATCH', 'total'),
    228: d('OU_AWAY', 'MATCH', 'total'),
    229: d('OE', 'MATCH'),
    ...H1_MARKETS,
    // 2. poločas u basketu vynechán (nejasné, zda zahrnuje prodloužení)
    235: d('1X2', 'QUARTER', 'quarternr'),
    236: d('OU', 'QUARTER', 'quarternr', 'total'),
    302: d('DNB', 'QUARTER', 'quarternr'),
    303: d('AH', 'QUARTER', 'hcp', 'quarternr'),
    304: d('OE', 'QUARTER', 'quarternr'),
  },
  tennis: {
    186: WINNER,
    187: d('AH', 'MATCH', 'hcp'), // handicap na gemy
    188: d('AH_SETS', 'MATCH', 'hcp'),
    189: d('OU', 'MATCH', 'total'), // počet gemů
    190: d('OU_HOME', 'MATCH', 'total'),
    191: d('OU_AWAY', 'MATCH', 'total'),
    198: d('OE', 'MATCH'),
    202: d('ML', 'SET', 'setnr'),
    203: d('AH', 'SET', 'hcp', 'setnr'),
    204: d('OU', 'SET', 'setnr', 'total'),
  },
  // házená: 60 min bez prodloužení (UOF 1/10/11/16/18 = základní doba), poločasy bez prodloužení
  handball: {
    1: REG_MARKETS[1],
    10: REG_MARKETS[10],
    11: REG_MARKETS[11],
    16: REG_MARKETS[16], // „Handicap – počet gólů“
    18: REG_MARKETS[18],
    19: REG_MARKETS[19],
    20: REG_MARKETS[20],
    26: REG_MARKETS[26],
    ...H1_MARKETS,
    ...H2_MARKETS,
  },
  // volejbal: remíza neexistuje; počet setů (OU_SETS) ani handicap bodů v setu v datech nebyly → vynechány
  volleyball: {
    186: WINNER,
    188: n(SETS, d('AH_SETS', 'MATCH', 'hcp')), // „Handicap – sety“
    202: d('ML', 'SET', 'setnr'), // „1. set – vítěz“
    237: n(POINTS, d('AH', 'MATCH', 'hcp')), // „Handicap – body“ (celý zápas; Altenar live 1. 10. 2026, betx 519)
    238: n(POINTS, d('OU', 'MATCH', 'total')), // „Celkový počet bodů“
    310: n(POINTS, d('OU', 'SET', 'setnr', 'total')), // „1. set – počet bodů“
  },
  // baseball: vše „vč. extra směny“ (akční linie – bez vazby na nadhazovače); 1.–5. směna a jednotlivé směny vynechány
  baseball: {
    251: d('ML', 'MATCH'),
    256: d('AH', 'MATCH', 'hcp'),
    258: d('OU', 'MATCH', 'total'),
    260: d('OU_HOME', 'MATCH', 'total'),
    261: d('OU_AWAY', 'MATCH', 'total'),
  },
  // americký fotbal: 1 = základní doba (s remízou), 219+ vč. prodloužení; 2. poločas / 4. čtvrtina vč. prodl. (231/232/294/613–615) vynechány
  american_football: {
    1: REG_MARKETS[1],
    // 219 „Vítěz (vč. prodl.)“ NENÍ mapován: NFL může skončit remízou a pravidlo (vrácení/prohra) není potvrzeno;
    // handicap ±0.5 (223) pokrývá totéž
    223: d('AH', 'MATCH', 'hcp'),
    225: d('OU', 'MATCH', 'total'),
    227: d('OU_HOME', 'MATCH', 'total'),
    228: d('OU_AWAY', 'MATCH', 'total'),
    229: d('OE', 'MATCH'),
    60: H1_MARKETS[60],
    63: H1_MARKETS[63], // dvojtip 1. poločas (zatím v datech nebyl)
    64: H1_MARKETS[64],
    66: H1_MARKETS[66],
    68: H1_MARKETS[68],
    69: H1_MARKETS[69],
    70: H1_MARKETS[70],
    83: H2_MARKETS[83],
    85: H2_MARKETS[85], // dvojtip 2. poločas (zatím v datech nebyl)
    235: d('1X2', 'QUARTER', 'quarternr'),
    236: d('OU', 'QUARTER', 'quarternr', 'total'),
    302: d('DNB', 'QUARTER', 'quarternr'),
    303: d('AH', 'QUARTER', 'hcp', 'quarternr'),
  },
  // MMA / box: 3-cestné 1X2 včetně remízy;
  // 1 = 3-cestné 1X2 včetně remízy (betx „1X2-Základní nabídka“, UofKey 1/1–3); počet kol (18) a způsob výhry vynechány
  // (186 se NEmapuje jako DNB: u Altenar/BetX není potvrzeno, že remíza vrací vklad – jen 3-cestné 1X2)
  mma: { 1: REG_MARKETS[1] },
  boxing: { 1: REG_MARKETS[1] },
  // šipky: handicap/total na legy vs. na sety – nemíchat (kontrola názvu)
  darts: {
    186: WINNER,
    188: n(SETS, d('AH_SETS', 'MATCH', 'hcp')), // „Handicap – sety“
    314: n(SETS, d('OU_SETS', 'MATCH', 'total')), // „Počet setů“
    366: n(LEGS, d('AH', 'MATCH', 'hcp')), // „Handicap – legy“
    367: n(LEGS, d('OU', 'MATCH', 'total')), // „Počet legů“
  },
  snooker: {
    186: WINNER,
    493: n(FRAMES, d('AH', 'MATCH', 'hcp')), // „Handicap – framy“
    494: n(FRAMES, d('OU', 'MATCH', 'total')), // „Počet framů“
  },
  // stolní tenis: UOF „game“ = set → 187 je handicap na SETY (v tenise gemy!)
  table_tennis: {
    186: WINNER,
    187: n(SETS, d('AH_SETS', 'MATCH', 'hcp')), // „Handicap – sety“
    237: n(POINTS, d('AH', 'MATCH', 'hcp')), // „Handicap – body“
    238: n(POINTS, d('OU', 'MATCH', 'total')), // „Počet bodů“
  },
};

export function uofDef(sport: Sport, marketId: number): UofDef | undefined {
  return UOF_BY_SPORT[sport]?.[marketId];
}

/** Výběr podle UOF id výsledku (Altenar u vítěze/DNB používá 1/3 místo 4/5). */
export function uofSelection(type: MarketType, outcomeId: number): SelectionKey | undefined {
  switch (type) {
    case '1X2':
      return outcomeId === 1 ? 'HOME' : outcomeId === 2 ? 'DRAW' : outcomeId === 3 ? 'AWAY' : undefined;
    case 'ML':
    case 'DNB':
      return outcomeId === 4 || outcomeId === 1 ? 'HOME' : outcomeId === 5 || outcomeId === 3 ? 'AWAY' : undefined;
    case 'AH':
    case 'AH_SETS':
      return outcomeId === 1714 ? 'HOME' : outcomeId === 1715 ? 'AWAY' : undefined;
    case 'OU':
    case 'OU_HOME':
    case 'OU_AWAY':
    case 'OU_SETS':
      return outcomeId === 12 ? 'OVER' : outcomeId === 13 ? 'UNDER' : undefined;
    case 'BTTS':
      return outcomeId === 74 ? 'YES' : outcomeId === 76 ? 'NO' : undefined;
    case 'OE':
      return outcomeId === 70 ? 'ODD' : outcomeId === 72 ? 'EVEN' : undefined;
    case 'DC':
      return outcomeId === 9 ? 'HOME_DRAW' : outcomeId === 10 ? 'HOME_AWAY' : outcomeId === 11 ? 'DRAW_AWAY' : undefined;
  }
}

const SCOPE_PREFIX = { PERIOD: ['P', 3], QUARTER: ['Q', 4], SET: ['S', 5] } as const;
const SCOPE_SPEC = { PERIOD: 'periodnr', QUARTER: 'quarternr', SET: 'setnr' } as const;

/**
 * Kanonický klíč z definice a hodnot specifikátorů. Vrací undefined, když specifikátor chybí
 * nebo nedává smysl (např. evropský handicap "0:1", perioda mimo rozsah).
 */
export function uofMarketKey(def: UofDef, specs: Record<string, string | undefined>): string | undefined {
  let scope: MarketScope;
  if (def.scope === 'PERIOD' || def.scope === 'QUARTER' || def.scope === 'SET') {
    const n = Number(specs[SCOPE_SPEC[def.scope]]);
    const [prefix, max] = SCOPE_PREFIX[def.scope];
    if (!Number.isInteger(n) || n < 1 || n > max) return undefined;
    scope = `${prefix}${n}` as MarketScope;
  } else scope = def.scope;
  const lineSpec = def.specs.find((s) => s === 'hcp' || s === 'total');
  if (!lineSpec) return marketKey(def.type, scope);
  const raw = specs[lineSpec];
  if (raw === undefined || !/^[+-]?\d+(\.\d+)?$/.test(raw.trim())) return undefined;
  const line = Number(raw);
  if (lineSpec === 'total' && line < 0) return undefined;
  return marketKey(def.type, scope, line);
}

/** Skládá výběry do trhů podle kanonického klíče (víc řádků/linií jednoho trhu feedu). */
export class MarketCollector {
  private readonly markets = new Map<string, RawMarket>();

  add(key: string, sel: RawSelection, o: { marketOpen: boolean; sourceId?: string; rawName?: string }): void {
    let m = this.markets.get(key);
    if (!m) {
      m = { key, open: o.marketOpen, selections: [], sourceId: o.sourceId, rawName: o.rawName };
      this.markets.set(key, m);
    }
    if (m.selections.some((s) => s.key === sel.key)) return; // první výskyt vyhrává
    m.selections.push(sel);
    if (!o.marketOpen) m.open = false;
  }

  /** Trh s jen uzavřenými výběry je uzavřený. */
  build(): RawMarket[] {
    const out: RawMarket[] = [];
    for (const m of this.markets.values()) {
      if (!m.selections.length) continue;
      if (m.selections.every((s) => s.open === false)) m.open = false;
      if (m.sourceId === undefined) delete m.sourceId;
      if (m.rawName === undefined) delete m.rawName;
      out.push(m);
    }
    return out;
  }
}

/** Platný kurz (1.01–1000); jinak undefined (0 = feed kurz nemá). */
export function validOdds(price: unknown): number | undefined {
  const n = typeof price === 'number' ? price : Number(price);
  if (!Number.isFinite(n) || n < 1.01 || n > 1000) return undefined;
  return Math.round(n * 10000) / 10000;
}

/** Odfiltruje e-sporty / simulované ligy podle názvu soutěže či týmů. */
export function isVirtualName(...names: (string | undefined)[]): boolean {
  return names.some((n) => !!n && /\b(srl|e-?sport|esoccer|e-?football|ebasketball|cyber|virtual|simulated)\b|\(esports?\)/i.test(n));
}
