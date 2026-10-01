// Konzervativní mapování hlavních trhů podle tvaru výběrů (ne podle názvu trhu sázkovky):
//  * 3 výběry 1 / X(0) / 2 u sportů s remízou  → 1X2|REG  (remíza existuje jen v základní době)
//  * 3 výběry 1X / 12 / X2 u sportů s remízou → DC|REG
//  * 2 výběry 1 / 2 u sportů bez remízy        → ML|MATCH
// Ostatní (hokej/basket 2-cestně = nejasné, zda vč. prodloužení) se vynechává – viz docs/adapters.md.
import type { RawMarket, RawSelection, SelectionKey, Sport } from '../../core/types.js';
import { marketKey, REQUIRED_SELECTIONS } from '../../core/markets.js';
import { ODDS_MAX, ODDS_MIN } from '../../core/validate.js';

const DRAW_SPORTS: readonly Sport[] = ['football', 'hockey', 'handball'];
const NO_DRAW_SPORTS: readonly Sport[] = ['tennis', 'table_tennis', 'volleyball'];

const LABELS: Record<string, SelectionKey> = {
  '1': 'HOME',
  X: 'DRAW',
  '0': 'DRAW',
  '2': 'AWAY',
  '1X': 'HOME_DRAW',
  '10': 'HOME_DRAW',
  '12': 'HOME_AWAY',
  X2: 'DRAW_AWAY',
  '02': 'DRAW_AWAY',
};

export interface LabeledOdd {
  label: string;
  odds: unknown;
  open?: boolean;
}

export function labelToKey(label: string): SelectionKey | undefined {
  return LABELS[label.replace(/\s+/g, '').toUpperCase()];
}

export function toOdds(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) && n >= ODDS_MIN && n <= ODDS_MAX ? n : undefined;
}

const sameSet = (a: SelectionKey[], b: SelectionKey[]) => a.length === b.length && b.every((k) => a.includes(k));

/** Vrátí kanonický hlavní trh, nebo null, když tvar výběrů neodpovídá jednoznačně. */
export function mainMarket(sport: Sport, sels: LabeledOdd[], meta: { sourceId?: string; rawName?: string } = {}): RawMarket | null {
  const out: RawSelection[] = [];
  for (const s of sels) {
    const key = labelToKey(s.label);
    const odds = toOdds(s.odds);
    if (!key || odds === undefined) return null; // neznámý výběr = jiný trh, nebo rozbitý kurz → nic
    if (out.some((x) => x.key === key)) return null;
    out.push({ key, odds, open: s.open !== false, rawName: s.label });
  }
  const keys = out.map((s) => s.key);
  let key: string | null = null;
  if (DRAW_SPORTS.includes(sport) && sameSet(keys, REQUIRED_SELECTIONS['1X2'])) key = marketKey('1X2', 'REG');
  else if (DRAW_SPORTS.includes(sport) && sameSet(keys, REQUIRED_SELECTIONS.DC)) key = marketKey('DC', 'REG');
  else if (NO_DRAW_SPORTS.includes(sport) && sameSet(keys, REQUIRED_SELECTIONS.ML)) key = marketKey('ML', 'MATCH');
  if (!key) return null;
  return { key, open: out.some((s) => s.open !== false), selections: out, sourceId: meta.sourceId, rawName: meta.rawName };
}

/** Čas začátku z čísla (ms nebo s) nebo ISO řetězce. */
export function toEpochMs(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string' && v) {
    if (/^\d+$/.test(v)) return toEpochMs(Number(v));
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
}

export const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Názvy trhů/period, které nejsou celý zápas (poločas, třetina, set …) → vynechat. */
export const PARTIAL_PERIOD_RX = /poločas|polocas|třetin|tretin|čtvrtin|ctvrtin|\bset\b|\bsetu\b|\bgem|period|half|quarter|inning|směn/i;
/** Virtuály / e-sporty → vynechat. */
export const VIRTUAL_RX = /virtu|e-?sport|esoccer|e-fotbal|efootball|ebasket|cyber|simul/i;

/**
 * Jeden řádek kurzů, který míchá víc trhů (Tipsport výpis: 1 0 2 10 02 12) → rozdělí na
 * jednoduché výsledky a dvojtipy a každou skupinu namapuje přes mainMarket().
 */
export function mainMarketsFromRow(sport: Sport, sels: LabeledOdd[], meta: { sourceId?: string; rawName?: string } = {}): RawMarket[] {
  const singles: LabeledOdd[] = [];
  const doubles: LabeledOdd[] = [];
  for (const s of sels) {
    const k = labelToKey(s.label);
    if (!k) continue;
    (k === 'HOME' || k === 'DRAW' || k === 'AWAY' ? singles : doubles).push(s);
  }
  return [mainMarket(sport, singles, meta), mainMarket(sport, doubles, meta)].filter((m): m is RawMarket => m !== null);
}