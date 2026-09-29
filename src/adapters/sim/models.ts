// Férové pravděpodobnosti trhů pro simulátor (Poisson pro fotbal/hokej, normální rozdělení pro basket,
// jednoduchý model setů pro tenis). Výstup: klíč trhu -> {výběr: pravděpodobnost}.
import { marketKey } from '../../core/markets.js';
import type { SelectionKey } from '../../core/types.js';

export type FairMarkets = Map<string, Partial<Record<SelectionKey, number>>>;

function poissonPmf(lambda: number, max = 12): number[] {
  const out: number[] = [];
  let p = Math.exp(-lambda);
  for (let k = 0; k <= max; k++) {
    out.push(p);
    p = (p * lambda) / (k + 1);
  }
  const s = out.reduce((a, b) => a + b, 0);
  return out.map((x) => x / s);
}

export interface PoissonState {
  /** očekávaný počet gólů za zbytek základní doby */
  lamH: number;
  lamA: number;
  score: [number, number];
}

/** Joint rozdělení konečného skóre (po zbytek zápasu). */
function joint(s: PoissonState): { h: number; a: number; p: number }[] {
  const ph = poissonPmf(Math.max(1e-6, s.lamH));
  const pa = poissonPmf(Math.max(1e-6, s.lamA));
  const out: { h: number; a: number; p: number }[] = [];
  for (let x = 0; x < ph.length; x++)
    for (let y = 0; y < pa.length; y++) out.push({ h: s.score[0] + x, a: s.score[1] + y, p: ph[x] * pa[y] });
  return out;
}

export function footballMarkets(
  full: PoissonState,
  h1?: PoissonState,
  opts: { ouLines: number[]; ahLines: number[]; hockey?: boolean; periodScope?: 'H1' | 'P1' } = { ouLines: [], ahLines: [] },
): FairMarkets {
  const m: FairMarkets = new Map();
  const J = joint(full);
  let pH = 0,
    pD = 0,
    pA = 0,
    btts = 0;
  for (const c of J) {
    if (c.h > c.a) pH += c.p;
    else if (c.h === c.a) pD += c.p;
    else pA += c.p;
    if (c.h > 0 && c.a > 0) btts += c.p;
  }
  m.set(marketKey('1X2', 'REG'), { HOME: pH, DRAW: pD, AWAY: pA });
  m.set(marketKey('DNB', 'REG'), { HOME: pH / (pH + pA), AWAY: pA / (pH + pA) });
  if (!opts.hockey) m.set(marketKey('BTTS', 'REG'), { YES: btts, NO: 1 - btts });
  if (opts.hockey) {
    // vítěz zápasu vč. prodloužení a nájezdů: remíza se rozpadne podle síly týmů
    const q = full.lamH + full.lamA > 0 ? full.lamH / (full.lamH + full.lamA) : 0.5;
    const w = 0.5 + (q - 0.5) * 0.6;
    m.set(marketKey('ML', 'MATCH'), { HOME: pH + pD * w, AWAY: pA + pD * (1 - w) });
  }
  for (const L of opts.ouLines) {
    let over = 0;
    for (const c of J) if (c.h + c.a > L) over += c.p;
    if (over > 0.03 && over < 0.97) m.set(marketKey('OU', 'REG', L), { OVER: over, UNDER: 1 - over });
  }
  for (const L of opts.ahLines) {
    let home = 0;
    for (const c of J) if (c.h + L > c.a) home += c.p;
    if (home > 0.03 && home < 0.97) m.set(marketKey('AH', 'REG', L), { HOME: home, AWAY: 1 - home });
  }
  if (h1 && opts.periodScope) {
    let a = 0,
      d = 0,
      b = 0;
    for (const c of joint(h1)) {
      if (c.h > c.a) a += c.p;
      else if (c.h === c.a) d += c.p;
      else b += c.p;
    }
    m.set(marketKey('1X2', opts.periodScope), { HOME: a, DRAW: d, AWAY: b });
  }
  return m;
}

// --- basket ---------------------------------------------------------------------------------

function erf(x: number): number {
  // Abramowitz-Stegun 7.1.26
  const s = Math.sign(x);
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
export function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

export interface BasketState {
  /** očekávaný rozdíl (domácí − hosté) za zbytek zápasu */
  muDiff: number;
  sdDiff: number;
  /** očekávaný počet bodů za zbytek zápasu */
  muTotal: number;
  sdTotal: number;
  score: [number, number];
}

export function basketMarkets(s: BasketState, lines: { ou: number[]; ah: number[] }): FairMarkets {
  const m: FairMarkets = new Map();
  const d0 = s.score[0] - s.score[1];
  const t0 = s.score[0] + s.score[1];
  const sdD = Math.max(0.8, s.sdDiff);
  const sdT = Math.max(0.8, s.sdTotal);
  const pHome = 1 - normCdf((0 - (d0 + s.muDiff)) / sdD);
  m.set(marketKey('ML', 'MATCH'), { HOME: pHome, AWAY: 1 - pHome });
  for (const L of lines.ou) {
    const over = 1 - normCdf((L - (t0 + s.muTotal)) / sdT);
    if (over > 0.03 && over < 0.97) m.set(marketKey('OU', 'MATCH', L), { OVER: over, UNDER: 1 - over });
  }
  for (const L of lines.ah) {
    const home = 1 - normCdf((-L - (d0 + s.muDiff)) / sdD);
    if (home > 0.03 && home < 0.97) m.set(marketKey('AH', 'MATCH', L), { HOME: home, AWAY: 1 - home });
  }
  return m;
}

// --- tenis ----------------------------------------------------------------------------------

/** P(domácí vyhraje zápas na 2 vítězné sety) ze stavu setů, když další sety vyhrává s p. */
function winFrom(sh: number, sa: number, p: number): number {
  if (sh >= 2) return 1;
  if (sa >= 2) return 0;
  return p * winFrom(sh + 1, sa, p) + (1 - p) * winFrom(sh, sa + 1, p);
}

export interface TennisState {
  /** P(domácí vyhraje set) pro budoucí sety */
  pSet: number;
  sets: [number, number];
  games: [number, number];
  /** zda se hraje (false = před zápasem) */
  started: boolean;
  totalGamesSoFar: number;
  totalLine: number;
  currentSet: number;
}

export function tennisMarkets(s: TennisState): FairMarkets {
  const m: FairMarkets = new Map();
  const [sh, sa] = s.sets;
  const logit = Math.log(s.pSet / (1 - s.pSet));
  const gd = s.games[0] - s.games[1];
  const progress = Math.min(1, (s.games[0] + s.games[1]) / 12);
  const c = s.started ? 1 / (1 + Math.exp(-(logit + gd * (0.35 + 0.5 * progress)))) : s.pSet;
  const pMatch = c * winFrom(sh + 1, sa, s.pSet) + (1 - c) * winFrom(sh, sa + 1, s.pSet);
  m.set(marketKey('ML', 'MATCH'), { HOME: pMatch, AWAY: 1 - pMatch });
  if (s.currentSet <= 3) {
    const setScope = (`S${s.currentSet}` as 'S1' | 'S2' | 'S3');
    m.set(marketKey('ML', setScope), { HOME: c, AWAY: 1 - c });
  }
  // počet setů 2.5 a handicap setů −1.5
  let p3: number;
  let home20: number;
  if (sh + sa === 0) {
    p3 = c * (1 - s.pSet) + (1 - c) * s.pSet;
    home20 = c * s.pSet;
  } else if (sh === 1 && sa === 0) {
    p3 = 1 - c;
    home20 = c;
  } else if (sh === 0 && sa === 1) {
    p3 = c;
    home20 = 0;
  } else {
    p3 = 1;
    home20 = 0;
  }
  if (p3 > 0.03 && p3 < 0.97) m.set(marketKey('OU_SETS', 'MATCH', 2.5), { OVER: p3, UNDER: 1 - p3 });
  if (home20 > 0.03 && home20 < 0.97) m.set(marketKey('AH_SETS', 'MATCH', -1.5), { HOME: home20, AWAY: 1 - home20 });
  // počet gemů – normální aproximace
  const expSets = 2 + p3;
  const remainingSets = Math.max(0, expSets - (sh + sa) - progress);
  const mu = s.totalGamesSoFar + remainingSets * 9.7;
  const sd = Math.max(1, 3.4 * Math.sqrt(remainingSets + 0.1));
  const over = 1 - normCdf((s.totalLine - mu) / sd);
  if (over > 0.03 && over < 0.97) m.set(marketKey('OU', 'MATCH', s.totalLine), { OVER: over, UNDER: 1 - over });
  return m;
}
