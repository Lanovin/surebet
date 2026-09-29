// Skórování Cox PH modelu exportovaného z Pythonu (fáze 2): S(t|x) = exp(-H0(t) * exp(β·x)).

export interface CoxPayload {
  kind: 'cox';
  version: 1;
  trainedAt: string;
  nTrain: number;
  cIndex: number;
  /** kategoriální proměnné (one-hot, referenční úroveň = chybí v coef) */
  categorical: { name: string; levels: string[] }[];
  /** numerické proměnné se standardizací */
  numeric: { name: string; mean: number; std: number }[];
  /** koeficienty: "sport=football", "margin" … */
  coef: Record<string, number>;
  /** kumulativní baseline hazard H0(t), t v ms, rostoucí */
  baseline: { t: number; H: number }[];
}

export function coxLinearPredictor(m: CoxPayload, x: Record<string, string | number>): number {
  let lp = 0;
  for (const c of m.categorical) {
    const v = String(x[c.name]);
    const lvl = c.levels.includes(v) ? v : c.levels.includes('other') ? 'other' : v; // neznámá úroveň -> "other"
    lp += m.coef[`${c.name}=${lvl}`] ?? 0;
  }
  for (const n of m.numeric) {
    const v = Number(x[n.name]);
    if (Number.isFinite(v)) lp += (m.coef[n.name] ?? 0) * ((v - n.mean) / (n.std || 1));
  }
  return lp;
}

/** H0(t) s lineární interpolací mezi body (stejně jako lifelines predict_survival_function(times=...)). */
function baselineAt(m: CoxPayload, t: number): number {
  const b = m.baseline;
  if (!b.length || t < b[0].t) return b.length ? (b[0].H * Math.max(0, t)) / Math.max(1, b[0].t) : 0;
  let lo = 0;
  let hi = b.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (b[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  if (lo === b.length - 1) return b[lo].H;
  const a = b[lo];
  const c = b[lo + 1];
  return a.H + ((c.H - a.H) * (t - a.t)) / (c.t - a.t || 1);
}

export function coxSurvival(m: CoxPayload, lp: number, t: number): number {
  return Math.exp(-baselineAt(m, t) * Math.exp(lp));
}

function quantile(m: CoxPayload, lp: number, q: number): number | null {
  const risk = Math.exp(lp);
  for (const b of m.baseline) if (Math.exp(-b.H * risk) <= 1 - q) return b.t;
  return null;
}

export function coxPredict(m: CoxPayload, x: Record<string, string | number>, neededMs: number) {
  if (!m.baseline?.length) return null;
  const lp = coxLinearPredictor(m, x);
  return {
    medianMs: quantile(m, lp, 0.5),
    p25Ms: quantile(m, lp, 0.25),
    p75Ms: quantile(m, lp, 0.75),
    pOver: {
      5: coxSurvival(m, lp, 5_000),
      10: coxSurvival(m, lp, 10_000),
      30: coxSurvival(m, lp, 30_000),
      60: coxSurvival(m, lp, 60_000),
    },
    n: m.nTrain,
    nEvents: m.nTrain,
    segment: `cox (C=${m.cIndex.toFixed(3)})`,
    level: -1,
    pNeeded: coxSurvival(m, lp, neededMs),
  };
}
