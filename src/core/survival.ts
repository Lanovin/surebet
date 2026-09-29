// Kaplan–Meier a empirické predikce životnosti arbů (fáze 1).

export interface Observation {
  durationMs: number;
  /** true = arb skutečně zanikl, false = cenzurováno (restart, konec přestávky …). */
  event: boolean;
}

export interface KMCurve {
  /** časy (ms), v nichž se mění S(t) */
  times: number[];
  surv: number[];
  atRisk: number[];
  n: number;
  nEvents: number;
}

export function kaplanMeier(obs: Observation[]): KMCurve {
  const sorted = [...obs].sort((a, b) => a.durationMs - b.durationMs || Number(b.event) - Number(a.event));
  const times: number[] = [];
  const surv: number[] = [];
  const atRisk: number[] = [];
  let s = 1;
  let risk = sorted.length;
  let nEvents = 0;
  let i = 0;
  while (i < sorted.length) {
    const t = sorted[i].durationMs;
    let d = 0;
    let c = 0;
    while (i < sorted.length && sorted[i].durationMs === t) {
      if (sorted[i].event) d++;
      else c++;
      i++;
    }
    if (d > 0) {
      s *= 1 - d / risk;
      times.push(t);
      surv.push(s);
      atRisk.push(risk);
      nEvents += d;
    }
    risk -= d + c;
  }
  return { times, surv, atRisk, n: obs.length, nEvents };
}

/** S(t) – pravděpodobnost, že arb vydrží déle než t ms. */
export function survivalAt(curve: KMCurve, tMs: number): number {
  let lo = 0;
  let hi = curve.times.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (curve.times[mid] <= tMs) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans < 0 ? 1 : curve.surv[ans];
}

/** Čas, do kterého zanikne podíl q arbů (q=0.5 → medián). null = křivka tam nedosáhne. */
export function lifetimeQuantile(curve: KMCurve, q: number): number | null {
  const target = 1 - q;
  for (let i = 0; i < curve.times.length; i++) if (curve.surv[i] <= target + 1e-12) return curve.times[i];
  return null;
}

export const SURVIVAL_POINTS_S = [5, 10, 30, 60] as const;

export interface SurvivalSummary {
  n: number;
  nEvents: number;
  medianMs: number | null;
  p25Ms: number | null;
  p75Ms: number | null;
  /** P(přežije > 5/10/30/60 s) */
  pOver: Record<(typeof SURVIVAL_POINTS_S)[number], number>;
}

export function summarize(curve: KMCurve): SurvivalSummary {
  return {
    n: curve.n,
    nEvents: curve.nEvents,
    medianMs: lifetimeQuantile(curve, 0.5),
    p25Ms: lifetimeQuantile(curve, 0.25),
    p75Ms: lifetimeQuantile(curve, 0.75),
    pOver: {
      5: survivalAt(curve, 5_000),
      10: survivalAt(curve, 10_000),
      30: survivalAt(curve, 30_000),
      60: survivalAt(curve, 60_000),
    },
  };
}

/** Zmenšená křivka pro přenos do UI (max `points` bodů, schodovitá). */
export function downsampleCurve(curve: KMCurve, points = 120): { t: number; s: number }[] {
  const out: { t: number; s: number }[] = [{ t: 0, s: 1 }];
  const step = Math.max(1, Math.ceil(curve.times.length / points));
  for (let i = 0; i < curve.times.length; i += step) out.push({ t: curve.times[i], s: curve.surv[i] });
  const last = curve.times.length - 1;
  if (last >= 0 && out[out.length - 1].t !== curve.times[last]) out.push({ t: curve.times[last], s: curve.surv[last] });
  return out;
}

// --- segmenty ----------------------------------------------------------------------------------

export interface SegmentFeatures {
  mode: string;
  sport: string;
  marketType: string;
  pair: string;
  marginBand: string;
}

/** Hierarchie segmentů od nejjemnějšího po globální. */
export const SEGMENT_LEVELS: (keyof SegmentFeatures)[][] = [
  ['mode', 'sport', 'marketType', 'pair', 'marginBand'],
  ['mode', 'sport', 'marketType', 'pair'],
  ['mode', 'sport', 'marketType'],
  ['mode', 'sport'],
  ['mode'],
  [],
];

export function segmentKey(f: SegmentFeatures, level: number): string {
  const fields = SEGMENT_LEVELS[level];
  return fields.length ? fields.map((k) => `${k}=${f[k]}`).join('|') : 'all';
}

export interface Prediction extends SurvivalSummary {
  segment: string;
  level: number;
}

export interface SegmentModel {
  builtAt: number;
  minSamples: number;
  segments: Map<string, { curve: KMCurve; summary: SurvivalSummary }>;
}

export function buildSegmentModel(
  rows: (SegmentFeatures & Observation)[],
  minSamples = 30,
): SegmentModel {
  const groups = new Map<string, Observation[]>();
  for (const r of rows) {
    for (let lvl = 0; lvl < SEGMENT_LEVELS.length; lvl++) {
      const k = segmentKey(r, lvl);
      let g = groups.get(k);
      if (!g) groups.set(k, (g = []));
      g.push({ durationMs: r.durationMs, event: r.event });
    }
  }
  const segments = new Map<string, { curve: KMCurve; summary: SurvivalSummary }>();
  for (const [k, obs] of groups) {
    const curve = kaplanMeier(obs);
    segments.set(k, { curve, summary: summarize(curve) });
  }
  return { builtAt: Date.now(), minSamples, segments };
}

/** Predikce z nejjemnějšího segmentu, který má aspoň minSamples vzorků (jinak nadřazený). */
export function predict(model: SegmentModel, f: SegmentFeatures): Prediction | null {
  for (let lvl = 0; lvl < SEGMENT_LEVELS.length; lvl++) {
    const k = segmentKey(f, lvl);
    const seg = model.segments.get(k);
    if (seg && seg.summary.n >= model.minSamples) return { ...seg.summary, segment: k, level: lvl };
  }
  return null; // ani globálně není dost vzorků
}

/** P(přežije > t) z nejlepšího dostupného segmentu. */
export function survivalProb(model: SegmentModel, f: SegmentFeatures, tMs: number): number | null {
  for (let lvl = 0; lvl < SEGMENT_LEVELS.length; lvl++) {
    const seg = model.segments.get(segmentKey(f, lvl));
    if (seg && seg.summary.n >= model.minSamples) return survivalAt(seg.curve, tMs);
  }
  return null;
}
