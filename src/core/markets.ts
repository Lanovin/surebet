import type { MarketKeyParts, MarketScope, MarketType, SelectionKey, Sport } from './types.js';
import { MARKET_SCOPES, MARKET_TYPES } from './types.js';

/** Výběry, které tvoří úplný rozklad výsledků daného typu trhu. */
export const REQUIRED_SELECTIONS: Record<MarketType, SelectionKey[]> = {
  '1X2': ['HOME', 'DRAW', 'AWAY'],
  ML: ['HOME', 'AWAY'],
  DNB: ['HOME', 'AWAY'],
  OU: ['OVER', 'UNDER'],
  AH: ['HOME', 'AWAY'],
  BTTS: ['YES', 'NO'],
  OE: ['ODD', 'EVEN'],
  OU_HOME: ['OVER', 'UNDER'],
  OU_AWAY: ['OVER', 'UNDER'],
  OU_SETS: ['OVER', 'UNDER'],
  AH_SETS: ['HOME', 'AWAY'],
  DC: ['HOME_DRAW', 'HOME_AWAY', 'DRAW_AWAY'],
  H_DA: ['HOME', 'DRAW_AWAY'],
  A_HD: ['AWAY', 'HOME_DRAW'],
  D_HA: ['DRAW', 'HOME_AWAY'],
};

/** Typy, které nejsou úplným rozkladem výsledků (výběry se překrývají) – samy arb netvoří. */
export const NON_PARTITION_TYPES = new Set<MarketType>(['DC']);

/** Jednotka primárního skóre sportu (počet X / handicap X). */
export const SCORE_UNIT: Record<Sport, string> = {
  football: 'gólů',
  hockey: 'gólů',
  handball: 'gólů',
  basketball: 'bodů',
  volleyball: 'bodů',
  american_football: 'bodů',
  table_tennis: 'bodů',
  tennis: 'gemů',
  baseball: 'běhů',
  darts: 'legů',
  snooker: 'framů',
  mma: 'kol',
  boxing: 'kol',
};

const LINE_TYPES = new Set<MarketType>(['OU', 'AH', 'OU_HOME', 'OU_AWAY', 'OU_SETS', 'AH_SETS']);

export function marketHasLine(type: MarketType): boolean {
  return LINE_TYPES.has(type);
}

/** Normalizuje linii na 2 desetinná místa, aby "2.50" i "2.5" dalo stejný klíč. */
export function normLine(line: number): number {
  const r = Math.round(line * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}

/** Jediný povolený způsob, jak vytvořit klíč trhu: "TYPE|SCOPE" nebo "TYPE|SCOPE|LINE". */
export function marketKey(type: MarketType, scope: MarketScope, line?: number): string {
  if (marketHasLine(type)) {
    if (line === undefined || !Number.isFinite(line)) throw new Error(`market ${type} requires a line`);
    return `${type}|${scope}|${normLine(line)}`;
  }
  return `${type}|${scope}`;
}

export function parseMarketKey(key: string): MarketKeyParts {
  const [type, scope, line] = key.split('|');
  if (!MARKET_TYPES.includes(type as MarketType)) throw new Error(`unknown market type in ${key}`);
  if (!MARKET_SCOPES.includes(scope as MarketScope)) throw new Error(`unknown market scope in ${key}`);
  const parts: MarketKeyParts = { type: type as MarketType, scope: scope as MarketScope };
  if (line !== undefined) parts.line = Number(line);
  return parts;
}

export function isValidMarketKey(key: string): boolean {
  try {
    const p = parseMarketKey(key);
    return marketHasLine(p.type) ? p.line !== undefined && Number.isFinite(p.line) : p.line === undefined;
  } catch {
    return false;
  }
}

/**
 * Když sázkovka uvádí týmy v opačném pořadí (typicky tenis), je potřeba převést její trh
 * do orientace kanonické události: HOME<->AWAY, handicap mění znaménko, týmové totaly se prohodí.
 */
export function swapMarketKey(key: string): string {
  const p = parseMarketKey(key);
  switch (p.type) {
    case 'AH':
    case 'AH_SETS':
      return marketKey(p.type, p.scope, -(p.line ?? 0));
    case 'OU_HOME':
      return marketKey('OU_AWAY', p.scope, p.line);
    case 'OU_AWAY':
      return marketKey('OU_HOME', p.scope, p.line);
    case 'H_DA':
      return marketKey('A_HD', p.scope);
    case 'A_HD':
      return marketKey('H_DA', p.scope);
    default:
      return key;
  }
}

export function swapSelection(sel: SelectionKey): SelectionKey {
  switch (sel) {
    case 'HOME':
      return 'AWAY';
    case 'AWAY':
      return 'HOME';
    case 'HOME_DRAW':
      return 'DRAW_AWAY';
    case 'DRAW_AWAY':
      return 'HOME_DRAW';
    default:
      return sel;
  }
}

/** Popisek trhu pro UI (česky). */
export function marketLabel(key: string, sport?: Sport): string {
  const p = parseMarketKey(key);
  const scope = SCOPE_LABEL[p.scope];
  const unit = SCORE_UNIT[sport ?? 'football'];
  const isTotal = p.type.startsWith('OU');
  const l = p.line === undefined ? '' : isTotal ? String(p.line) : formatLine(p.line);
  const base: Record<MarketType, string> = {
    '1X2': '1X2',
    ML: 'Vítěz',
    DNB: 'Bez remízy',
    OU: `Počet ${unit} ${l}`,
    AH: `Handicap ${l}`,
    BTTS: 'Oba skórují',
    OE: 'Lichý/sudý',
    OU_HOME: `Domácí ${unit} ${l}`,
    OU_AWAY: `Hosté ${unit} ${l}`,
    OU_SETS: `Počet setů ${l}`,
    AH_SETS: `Handicap setů ${l}`,
    DC: 'Dvojtip',
    H_DA: '1 vs. X2',
    A_HD: '2 vs. 1X',
    D_HA: 'X vs. 12',
  };
  return scope ? `${base[p.type]} · ${scope}` : base[p.type];
}

export function selectionLabel(sel: SelectionKey, marketType: MarketType): string {
  switch (sel) {
    case 'HOME':
      return marketType === '1X2' || marketType === 'H_DA' ? '1' : 'Domácí';
    case 'DRAW':
      return 'X';
    case 'AWAY':
      return marketType === '1X2' || marketType === 'A_HD' ? '2' : 'Hosté';
    case 'HOME_DRAW':
      return '1X';
    case 'HOME_AWAY':
      return '12';
    case 'DRAW_AWAY':
      return 'X2';
    case 'OVER':
      return 'Více';
    case 'UNDER':
      return 'Méně';
    case 'YES':
      return 'Ano';
    case 'NO':
      return 'Ne';
    case 'ODD':
      return 'Lichý';
    case 'EVEN':
      return 'Sudý';
  }
}

function formatLine(line: number): string {
  return line > 0 ? `+${line}` : `${line}`;
}

export const SCOPE_LABEL: Record<MarketScope, string> = {
  REG: 'zákl. doba',
  MATCH: 'zápas',
  H1: '1. poločas',
  H2: '2. poločas',
  P1: '1. třetina',
  P2: '2. třetina',
  P3: '3. třetina',
  Q1: '1. čtvrtina',
  Q2: '2. čtvrtina',
  Q3: '3. čtvrtina',
  Q4: '4. čtvrtina',
  S1: '1. set',
  S2: '2. set',
  S3: '3. set',
  S4: '4. set',
  S5: '5. set',
};
