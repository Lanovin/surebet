// Matematika arbů: marže a vklady zaokrouhlené tak, aby zisk zůstal kladný ve všech výsledcích.

export function impliedSum(odds: number[]): number {
  let s = 0;
  for (const o of odds) s += 1 / o;
  return s;
}

/** Marže arbu jako podíl (0.012 = 1,2 %). Záporná = není arb. */
export function arbMargin(odds: number[]): number {
  return 1 / impliedSum(odds) - 1;
}

/** Efektivní kurz po poplatku z vkladu (feePct v %). */
export function effectiveOdds(odds: number, feePct = 0): number {
  return feePct > 0 ? odds * (1 - feePct / 100) : odds;
}

export interface StakePlan {
  stakes: number[];
  total: number;
  payouts: number[];
  profits: number[];
  minProfit: number;
  /** minProfit / total */
  roi: number;
  /** Všechny výsledky v zisku. */
  positive: boolean;
}

function evaluate(odds: number[], stakes: number[]): StakePlan {
  const total = stakes.reduce((a, b) => a + b, 0);
  const payouts = stakes.map((s, i) => s * odds[i]);
  const profits = payouts.map((p) => round2(p - total));
  const minProfit = Math.min(...profits);
  return {
    stakes,
    total,
    payouts: payouts.map(round2),
    profits,
    minProfit,
    roi: total > 0 ? minProfit / total : 0,
    positive: minProfit > 0 && stakes.every((s) => s > 0),
  };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function better(a: StakePlan, b: StakePlan | null, bankroll: number): boolean {
  if (!b) return true;
  if (a.positive !== b.positive) return a.positive;
  if (a.minProfit !== b.minProfit) return a.minProfit > b.minProfit;
  return Math.abs(a.total - bankroll) < Math.abs(b.total - bankroll);
}

/** Pro daný celkový vklad zkusí všechny kombinace zaokrouhlení nahoru/dolů. */
function bestRounding(odds: number[], total: number, unit: number, inv: number, bankroll: number): StakePlan | null {
  const ideal = odds.map((o) => (total * (1 / o)) / inv);
  const n = odds.length;
  let best: StakePlan | null = null;
  for (let mask = 0; mask < 1 << n; mask++) {
    const stakes = ideal.map((s, i) => {
      const down = Math.floor(s / unit) * unit;
      return mask & (1 << i) ? down + unit : down;
    });
    if (stakes.some((s) => s <= 0)) continue;
    const plan = evaluate(odds, stakes);
    if (better(plan, best, bankroll)) best = plan;
  }
  return best;
}

/**
 * Vklady pro bankroll zaokrouhlené na `unit` Kč. Nejdřív zkusí celý bankroll, když zaokrouhlení
 * zabije zisk, hledá nejbližší nižší (a mírně vyšší) celkový vklad, kde zisk zůstane kladný.
 */
export function computeStakes(odds: number[], bankroll: number, unit = 1): StakePlan | null {
  if (odds.length < 2 || odds.some((o) => !(o > 1)) || bankroll <= 0) return null;
  const inv = impliedSum(odds);
  let best = bestRounding(odds, bankroll, unit, inv, bankroll);
  if (best?.positive) return best;
  const steps = Math.min(400, Math.floor(bankroll / unit / 2));
  for (let k = 1; k <= steps; k++) {
    for (const t of [bankroll - k * unit, bankroll + k * unit]) {
      if (t <= 0 || t > bankroll * 1.05) continue;
      const p = bestRounding(odds, t, unit, inv, bankroll);
      if (p?.positive) return p;
      if (p && better(p, best, bankroll)) best = p;
    }
  }
  return best;
}

/**
 * Dopočet ostatních vkladů, když je jedna noha už podaná (např. sázkovka přijala jiný vklad).
 * Ostatní vklady se nastaví tak, aby výplaty byly co nejrovnější.
 */
export function computeStakesFixed(odds: number[], fixedIndex: number, fixedStake: number, unit = 1): StakePlan | null {
  if (fixedStake <= 0 || !odds[fixedIndex]) return null;
  const target = fixedStake * odds[fixedIndex];
  const n = odds.length;
  let best: StakePlan | null = null;
  const ideal = odds.map((o, i) => (i === fixedIndex ? fixedStake : target / o));
  for (let mask = 0; mask < 1 << n; mask++) {
    if (mask & (1 << fixedIndex)) continue;
    const stakes = ideal.map((s, i) => {
      if (i === fixedIndex) return fixedStake;
      const down = Math.floor(s / unit) * unit;
      return mask & (1 << i) ? down + unit : down;
    });
    if (stakes.some((s) => s <= 0)) continue;
    const plan = evaluate(odds, stakes);
    if (better(plan, best, fixedStake / (1 / odds[fixedIndex]) / impliedSum(odds))) best = plan;
  }
  return best;
}

export function marginBand(marginPct: number): string {
  if (marginPct < 1) return '0-1';
  if (marginPct < 2) return '1-2';
  if (marginPct < 3) return '2-3';
  if (marginPct < 5) return '3-5';
  return '5+';
}
