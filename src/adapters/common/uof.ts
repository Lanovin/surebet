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
}

const d = (type: MarketType, scope: ScopeDef, ...specs: string[]): UofDef => ({ type, scope, specs: specs.sort() });

/** Trhy základní hrací doby (UOF: trhy bez "(incl. overtime)" platí jen pro základní dobu). */
const REG_MARKETS: Record<number, UofDef> = {
  1: d('1X2', 'REG'),
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
  64: d('DNB', 'H1'),
  66: d('AH', 'H1', 'hcp'),
  68: d('OU', 'H1', 'total'),
  69: d('OU_HOME', 'H1', 'total'),
  70: d('OU_AWAY', 'H1', 'total'),
};

const H2_MARKETS: Record<number, UofDef> = {
  83: d('1X2', 'H2'),
  86: d('DNB', 'H2'),
  88: d('AH', 'H2', 'hcp'),
  90: d('OU', 'H2', 'total'),
  91: d('OU_HOME', 'H2', 'total'),
  92: d('OU_AWAY', 'H2', 'total'),
};

const UOF_BY_SPORT: Record<Sport, Record<number, UofDef>> = {
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
    186: d('ML', 'MATCH'),
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
};

export function uofDef(sport: Sport, marketId: number): UofDef | undefined {
  return UOF_BY_SPORT[sport][marketId];
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
