// Skupiny ekvivalentních trhů pro arby napříč typy trhů.
//
// Arb = výběry, jejichž výsledky se nepřekrývají a dohromady pokrývají všechny možnosti. Stejný
// výsledek se dá často vsadit víc způsoby (u každé sázkovky jinak):
//   výhra domácích        = 1X2 „1“        = asijský handicap domácích −0.5
//   remíza nebo hosté     = dvojtip „X2“   = asijský handicap hostů +0.5 (AH −0.5, výběr AWAY)
//   bez remízy            = DNB            = asijský handicap 0 (remíza = vrácení u obou)
//   vítěz vč. prodloužení = ML             = handicap vč. prodloužení ±0.5 (hokej, basket, házená – remíza
//                                            po prodloužení/nájezdech nastat nemůže)
// Detektor proto nevyhodnocuje jednotlivé trhy, ale skupiny: pro každý výsledek skupiny vezme nejlepší
// kurz ze všech sázkovek a všech ekvivalentních trhů. Noha si pamatuje, který trh se skutečně sází.
import type { MarketScope, SelectionKey, Sport } from './types.js';
import { marketKey, NON_PARTITION_TYPES, parseMarketKey, REQUIRED_SELECTIONS } from './markets.js';

export interface GroupSource {
  /** kanonický klíč trhu, který se u sázkovky skutečně sází */
  market: string;
  /** výběr v tomto trhu (kanonická orientace) */
  sel: SelectionKey;
}

export interface GroupLeg {
  /** výsledek skupiny (výběr trhu skupiny) */
  sel: SelectionKey;
  sources: GroupSource[];
}

export interface ArbGroup {
  /** klíč skupiny = klíč trhu, pod kterým se arb eviduje (např. "H_DA|REG", "1X2|REG") */
  key: string;
  legs: GroupLeg[];
}

/** Sporty, kde základní doba / poločas / perioda / čtvrtina může skončit remízou. */
const DRAW_SPORTS = new Set<Sport>(['football', 'hockey', 'basketball', 'handball', 'american_football', 'mma', 'boxing']);
/** Vítěz vč. prodloužení = handicap vč. prodloužení ±0.5 (bez možnosti remízy na konci). */
const ML_AH_SPORTS = new Set<Sport>(['hockey', 'basketball', 'handball']);

/** Rozsah, který může skončit remízou (1X2 má tři výsledky). */
export function isThreeWayScope(sport: Sport, scope: MarketScope): boolean {
  return DRAW_SPORTS.has(sport) && scope !== 'MATCH' && !scope.startsWith('S');
}

const src = (market: string, sel: SelectionKey): GroupSource => ({ market, sel });

function threeWay(type: string, s: MarketScope): ArbGroup | null {
  const x12 = marketKey('1X2', s);
  const dc = marketKey('DC', s);
  const ahH = marketKey('AH', s, -0.5); // domácí −0.5 / hosté +0.5
  const ahA = marketKey('AH', s, 0.5); // domácí +0.5 / hosté −0.5
  const ah0 = marketKey('AH', s, 0);
  const home = [src(x12, 'HOME'), src(ahH, 'HOME')];
  const away = [src(x12, 'AWAY'), src(ahA, 'AWAY')];
  switch (type) {
    case '1X2':
      return { key: x12, legs: [{ sel: 'HOME', sources: home }, { sel: 'DRAW', sources: [src(x12, 'DRAW')] }, { sel: 'AWAY', sources: away }] };
    case 'H_DA':
      return { key: marketKey('H_DA', s), legs: [{ sel: 'HOME', sources: home }, { sel: 'DRAW_AWAY', sources: [src(dc, 'DRAW_AWAY'), src(ahH, 'AWAY')] }] };
    case 'A_HD':
      return { key: marketKey('A_HD', s), legs: [{ sel: 'AWAY', sources: away }, { sel: 'HOME_DRAW', sources: [src(dc, 'HOME_DRAW'), src(ahA, 'HOME')] }] };
    case 'D_HA':
      return { key: marketKey('D_HA', s), legs: [{ sel: 'DRAW', sources: [src(x12, 'DRAW')] }, { sel: 'HOME_AWAY', sources: [src(dc, 'HOME_AWAY')] }] };
    case 'DNB': {
      const dnb = marketKey('DNB', s);
      return { key: dnb, legs: [{ sel: 'HOME', sources: [src(dnb, 'HOME'), src(ah0, 'HOME')] }, { sel: 'AWAY', sources: [src(dnb, 'AWAY'), src(ah0, 'AWAY')] }] };
    }
  }
  return null;
}

function matchWinner(): ArbGroup {
  const ml = marketKey('ML', 'MATCH');
  const a = marketKey('AH', 'MATCH', -0.5);
  const b = marketKey('AH', 'MATCH', 0.5);
  return {
    key: ml,
    legs: [
      { sel: 'HOME', sources: [src(ml, 'HOME'), src(a, 'HOME'), src(b, 'HOME')] },
      { sel: 'AWAY', sources: [src(ml, 'AWAY'), src(a, 'AWAY'), src(b, 'AWAY')] },
    ],
  };
}

/** Definice skupiny pro klíč (běžný trh bez ekvivalentů = skupina s jediným zdrojem na výsledek). */
export function groupDef(sport: Sport, key: string): ArbGroup | null {
  const p = parseMarketKey(key);
  if (NON_PARTITION_TYPES.has(p.type)) return null;
  if (isThreeWayScope(sport, p.scope)) {
    const g = threeWay(p.type, p.scope);
    if (g) return g;
  } else if (p.type === 'H_DA' || p.type === 'A_HD' || p.type === 'D_HA') return null;
  if (p.type === 'ML' && p.scope === 'MATCH' && ML_AH_SPORTS.has(sport)) return matchWinner();
  return { key, legs: REQUIRED_SELECTIONS[p.type].map((sel) => ({ sel, sources: [src(key, sel)] })) };
}

/**
 * Skupiny, které je potřeba přehodnotit, když se změní trh `market` (u kterékoli sázkovky).
 * Trh pohlcený skupinou (AH ±0.5 / 0 v rozsahu s remízou, dvojtip) se samostatně nevyhodnocuje.
 */
export function groupsForMarket(sport: Sport, market: string): string[] {
  const p = parseMarketKey(market);
  const s = p.scope;
  if (isThreeWayScope(sport, s)) {
    const g = (t: 'H_DA' | 'A_HD' | 'D_HA') => marketKey(t, s);
    const x12 = marketKey('1X2', s);
    switch (p.type) {
      case '1X2':
        return [x12, g('H_DA'), g('A_HD'), g('D_HA')];
      case 'DC':
        return [g('H_DA'), g('A_HD'), g('D_HA')];
      case 'DNB':
        return [marketKey('DNB', s)];
      case 'AH':
        if (p.line === -0.5) return [x12, g('H_DA')];
        if (p.line === 0.5) return [x12, g('A_HD')];
        if (p.line === 0) return [marketKey('DNB', s)];
        return [market];
      case 'H_DA':
      case 'A_HD':
      case 'D_HA':
        return [market];
    }
  }
  if (NON_PARTITION_TYPES.has(p.type) || p.type === 'H_DA' || p.type === 'A_HD' || p.type === 'D_HA') return [];
  if (ML_AH_SPORTS.has(sport) && s === 'MATCH' && (p.type === 'ML' || (p.type === 'AH' && Math.abs(p.line ?? 1) === 0.5))) return [marketKey('ML', 'MATCH')];
  return [market];
}
