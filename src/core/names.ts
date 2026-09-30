// Normalizace a fuzzy porovnání jmen týmů/hráčů napříč sázkovkami.
import type { Sport } from './types.js';
import { isIndividualSport } from './types.js';
import { NAME_SYNONYMS, TEAM_CODES } from '../../config/aliases.js';

/** Odstraní diakritiku, převede na malá písmena, interpunkci na mezery. */
export function fold(s: string): string {
  return s
    .replace(/\b([A-Za-z])\.\s?([A-Za-z])\.(?=\s|$)/g, '$1$2') // "L.A." -> "LA"
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l')
    .replace(/ø/g, 'o')
    .replace(/æ/g, 'ae')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .replace(/[’'`´]/g, '')
    .replace(/[^a-z0-9/]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Tokeny, které nic neříkají o identitě klubu (FC, SK, AC …). */
const NOISE = new Set([
  'fc', 'fk', 'sk', 'afc', 'cf', 'sc', 'ac', 'as', 'ss', 'sv', 'tj', 'bk', 'hc', 'hk', 'bc', 'kk', 'club', 'calcio',
  'cd', 'ud', 'rc', 'rcd', 'sd', 'cs', 'nk', 'hnk', 'ofk', 'pfc', 'ks', 'gks', 'mks', 'bsc', 'vfb', 'vfl', 'tsv',
  'tsg', 'fsv', 'spvgg', 'ssc', 'us', 'asd', 'ca', 'se', 'ec', 'if', 'ik', 'bk', 'ff', 'fbk', 'aik', 'sl', 'cfc',
  'ssd', 'usd', 'ifk', 'jk', 'fotbal', 'football', 'futbol', 'a', 's', 'de', 'the', 'and', 'a s', 'mfk', 'sfc',
  'bv', 'kv', 'kvc', 'krc', 'royal', 'hockey', 'basket', 'basketball', 'team',
  // házená, volejbal
  'hsg', 'sg', 'tus', 'hbc', 'vk', 'vc', 'volley', 'volleyball', 'handball', 'hazena',
]);

/** Značky, které tým odlišují a musí se shodovat (U21 ≠ A-tým, ženy ≠ muži, B-tým ≠ A-tým). */
const TAG_PATTERNS: [RegExp, string][] = [
  [/\bu ?(15|16|17|18|19|20|21|22|23)\b/g, 'u$1'],
  [/\b(women|woman|zeny|z|w|wom|fem|feminino|femenino|dames|frauen|damen|zen|ladies)\b/g, 'women'],
  [/\b(ii|b|reserves?|res|juniors?|jun|2)\b$/g, 'reserve'],
  [/\b(youth|mladez|dorost|dorostenci)\b/g, 'youth'],
];

/** Jednotlivci: jednopísmenné "z"/"w" jsou iniciály křestního jména, ne značka žen. */
const TENNIS_WOMEN = /\b(women|woman|zeny|wom|fem|feminino|femenino|dames|frauen|damen|zen|ladies)\b/g;

export interface NormName {
  /** Normalizovaný řetězec bez šumu a značek. */
  core: string;
  tokens: string[];
  /** tokeny před aplikací synonym (pro zkratky typu "Sev." ~ "Severní") */
  rawTokens: string[];
  tags: string[];
}

/** Fonetický klíč tokenu – sjednotí přepisy (Chelyabinsk ~ Čeljabinsk, Izhevsk ~ Iževsk, Yokohama ~ Jokohama). */
export function phon(t: string): string {
  return t
    .replace(/ph/g, 'f')
    .replace(/th/g, 't')
    .replace(/sch/g, 's')
    .replace(/sh/g, 's')
    .replace(/zh/g, 'z')
    .replace(/kh/g, 'k') // Akhmat ~ Achmat, Savinykh ~ Savinych
    .replace(/ch/g, 'c') // Chelyabinsk ~ Čeljabinsk, Sochi ~ Soči
    .replace(/ts/g, 'c') // Novopolotsk ~ Novopolock
    .replace(/ck/g, 'k')
    .replace(/qu/g, 'kv')
    .replace(/x/g, 'ks')
    .replace(/w/g, 'v')
    .replace(/c(?![eiy])/g, 'k')
    .replace(/y(?=[aeiou])/g, 'j')
    .replace(/y/g, 'i')
    .replace(/h/g, 'g') // české "h" za ruské "г": Kurhan ~ Kurgan, Homel ~ Gomel
    .replace(/([aeiou])j(?=[^aeiou]|$)/g, '$1i') // Kuvajt ~ Kuwait, Kajrat ~ Kairat
    .replace(/ie$/, 'ia') // Namibie ~ Namibia
    .replace(/(.)\1+/g, '$1');
}

export function normalizeName(raw: string, sport: Sport): NormName {
  // kódy týmů NBA/NHL psané velkými písmeny ("PHX Suns", "SA Spurs")
  const codes = sport === 'basketball' || sport === 'hockey' ? TEAM_CODES[sport] : undefined;
  if (codes) raw = raw.split(/\s+/).map((tok) => (/^[A-Z]{2,3}$/.test(tok) && codes[tok] ? codes[tok] : tok)).join(' ');
  let s = fold(raw);
  // jednotlivci (tenis, šipky, snooker, MMA …): jména hráčů, žádné značky týmů
  const individual = isIndividualSport(sport);
  // "(ž)" "(W)" apod. v závorkách se po fold() stanou samostatným tokenem – řeší TAG_PATTERNS
  const tags = new Set<string>();
  for (const [re, tag] of TAG_PATTERNS) {
    // u tenisu by koncové "B." (iniciála) vypadalo jako B-tým a "Bergs Z." / "Kwon W." jako ženy
    if (individual && tag === 'reserve') continue;
    const pattern = individual && tag === 'women' ? TENNIS_WOMEN : re;
    s = s.replace(pattern, (...m) => {
      tags.add(tag.includes('$1') ? tag.replace('$1', m[1]) : tag);
      return ' ';
    });
  }
  let rawTokens = s.split(' ').filter(Boolean);
  let tokens = rawTokens
    .map((t) => NAME_SYNONYMS[t] ?? t)
    .flatMap((t) => t.split(' '))
    .filter(Boolean);
  const clean = (ts: string[]) => {
    if (individual) {
      // české přechýlení: "Sabalenková" ~ "Sabalenka", "Krejčíková" ~ "Krejcikova"
      return ts.map((t) => (t.length > 5 && t.endsWith('ova') ? t.slice(0, -3) : t));
    }
    const cleaned = ts.filter((t) => !NOISE.has(t) && !/^\d{4}$/.test(t));
    return cleaned.length ? cleaned : ts;
  };
  tokens = clean(tokens);
  rawTokens = clean(rawTokens);
  return { core: tokens.join(' '), tokens, rawTokens, tags: [...tags].sort() };
}

/** Klíč pro unikátnost účastníka v DB. */
export function participantKey(raw: string, sport: Sport): string {
  const n = normalizeName(raw, sport);
  return [n.core, ...n.tags].join('#');
}

// --- podobnost -------------------------------------------------------------------------------

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const t = ` ${s} `;
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Sørensen–Dice nad bigramy (0..1). */
export function dice(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  let total = 0;
  for (const [g, c] of A) {
    inter += Math.min(c, B.get(g) ?? 0);
    total += c;
  }
  for (const c of B.values()) total += c;
  return (2 * inter) / total;
}

/** Jaro–Winkler (0..1) – odolný vůči přesmyčkám ("Scunthrope" ~ "Scunthorpe"). */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  const la = a.length;
  const lb = b.length;
  if (!la || !lb) return 0;
  const range = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const ma = new Array<boolean>(la).fill(false);
  const mb = new Array<boolean>(lb).fill(false);
  let m = 0;
  for (let i = 0; i < la; i++) {
    for (let j = Math.max(0, i - range); j < Math.min(lb, i + range + 1); j++) {
      if (mb[j] || a[i] !== b[j]) continue;
      ma[i] = mb[j] = true;
      m++;
      break;
    }
  }
  if (!m) return 0;
  let t = 0;
  let k = 0;
  for (let i = 0; i < la; i++) {
    if (!ma[i]) continue;
    while (!mb[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  const jaro = (m / la + m / lb + (m - t / 2) / m) / 3;
  let p = 0;
  while (p < Math.min(4, la, lb) && a[p] === b[p]) p++;
  return jaro + p * 0.1 * (1 - jaro);
}

/** Shoda dvou tokenů: přesná, zkratka ("dyn" ~ "dynamo", "m" ~ "manchester"), jiný přepis, nebo překlep. */
function tokenMatch(a: string, b: string): number {
  if (a === b) return 1;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  const ps = phon(s);
  const pl = phon(l);
  const prefix = (x: string, y: string) => y.startsWith(x);
  if (s.length === 1) return l.startsWith(s) ? 0.8 : 0; // iniciála ("U." ~ "Universidad")
  if (s.length === 2 && l.length >= 4 && prefix(s, l)) return 0.8; // "ml." ~ "mlada", "kr." ~ "kralove"
  if (s.length >= 3 && (prefix(s, l) || prefix(ps, pl))) return 0.9; // zkratka ("din." ~ "dynamo")
  if (s.length >= 4) {
    if (ps === pl) return 0.95; // jiný přepis téhož jména
    const d = Math.max(dice(a, b), dice(ps, pl));
    if (d >= 0.8) return d;
    const jw = jaroWinkler(a, b);
    if (s.length >= 6 && jw >= 0.93) return Math.min(0.94, jw - 0.05); // překlep / přesmyčka
  }
  return 0;
}

/** "QPR" ~ "Queens Park Rangers", "RW" ~ "Rot Weiss": akronym nahradí odpovídající tokeny druhé strany. */
function mergeAcronyms(A: string[], B: string[]): string[] {
  let out = B;
  for (const t of A) {
    if (t.length < 2 || t.length > 4 || out.includes(t)) continue;
    for (let i = 0; i + t.length <= out.length; i++) {
      const initials = out.slice(i, i + t.length).map((x) => x[0]).join('');
      if (initials === t && out.slice(i, i + t.length).every((x) => x.length > 1)) {
        out = [...out.slice(0, i), t, ...out.slice(i + t.length)];
        break;
      }
    }
  }
  return out;
}

/** Porovná množiny tokenů – vážený průnik (overlap coefficient + Dice). */
function tokenSetScore(A0: string[], B0: string[]): number {
  if (!A0.length || !B0.length) return 0;
  const B = mergeAcronyms(A0, B0);
  const A = mergeAcronyms(B, A0);
  const used = new Set<number>();
  let sum = 0;
  let longMatched = 0;
  for (const a of A) {
    let best = 0;
    let bi = -1;
    B.forEach((b, i) => {
      if (used.has(i)) return;
      const m = tokenMatch(a, b);
      if (m > best) {
        best = m;
        bi = i;
      }
    });
    if (bi >= 0 && best > 0) {
      used.add(bi);
      sum += best;
      if (a.length > 1 && B[bi].length > 1) longMatched++;
    }
  }
  if (!longMatched) return 0; // jen iniciály nestačí
  const overlap = sum / Math.min(A.length, B.length);
  const diceTok = (2 * sum) / (A.length + B.length);
  const score = 0.6 * overlap + 0.4 * diceTok;
  // celé kratší jméno je obsažené v delším ("Liberec" ⊂ "Bílí Tygři Liberec") a nese výrazný token
  const contained = used.size === Math.min(A.length, B.length) && overlap >= 0.85;
  const distinctive = [...used].some((i) => B[i].length >= 4);
  return contained && distinctive ? Math.max(score, Math.min(0.9, overlap + 0.03)) : score;
}

/**
 * Tenis: jméno hráče ve tvarech "Novak Djokovic", "Djokovic N.", "Djokovic, Novak", "N. Djokovic".
 * Porovnává se hlavně příjmení; křestní jméno/iniciála jen potvrzuje. Čtyřhra "A/B" po dvojicích.
 */
function tennisScore(a: string, b: string): number {
  const pa = a.split('/').map((x) => x.trim()).filter(Boolean);
  const pb = b.split('/').map((x) => x.trim()).filter(Boolean);
  if (pa.length !== pb.length) return 0;
  if (pa.length > 1) {
    const straight = pa.reduce((acc, x, i) => acc + playerScore(x, pb[i]), 0) / pa.length;
    const crossed = pa.length === 2 ? (playerScore(pa[0], pb[1]) + playerScore(pa[1], pb[0])) / 2 : 0;
    return Math.max(straight, crossed);
  }
  return playerScore(a, b);
}

function playerScore(a: string, b: string): number {
  const A = a.split(' ').filter(Boolean);
  const B = b.split(' ').filter(Boolean);
  if (!A.length || !B.length) return 0;
  // všechny dvojice tokenů: dlouhé ~ příjmení (tokenMatch), krátké ~ iniciála/zkratka křestního jména
  const cand: { i: number; j: number; m: number; long: boolean }[] = [];
  A.forEach((x, i) =>
    B.forEach((y, j) => {
      const long = x.length > 1 && y.length > 1;
      const m = long ? (x === y ? 1 : tokenMatch(x, y) >= 0.85 ? 0.9 : firstNameMatch(x, y)) : firstNameMatch(x, y);
      if (m > 0) cand.push({ i, j, m, long: long && m >= 0.9 });
    }),
  );
  cand.sort((p, q) => q.m - p.m || Number(q.long) - Number(p.long));
  const ua = new Set<number>();
  const ub = new Set<number>();
  const picks: typeof cand = [];
  for (const c of cand) {
    if (ua.has(c.i) || ub.has(c.j)) continue;
    ua.add(c.i);
    ub.add(c.j);
    picks.push(c);
  }
  const surname = picks.find((p) => p.long);
  if (!surname) return dice(A.join(''), B.join('')) >= 0.9 ? 0.85 : 0;
  const others = picks.filter((p) => p !== surname);
  const restA = A.filter((_, i) => !ua.has(i));
  const restB = B.filter((_, j) => !ub.has(j));
  if (others.length) return surname.m * (0.9 + (0.1 * others.reduce((s, p) => s + p.m, 0)) / others.length);
  if (!restA.length || !restB.length) return surname.m * 0.93;
  // iniciály víceslovného jména: "P.H." ~ "Pierre-Hugues"
  const ia = restA.map((t) => t[0]).join('');
  const ib = restB.map((t) => t[0]).join('');
  if ((restA.length === 1 && restA[0] === ib) || (restB.length === 1 && restB[0] === ia)) return surname.m * 0.97;
  return surname.m * 0.55; // jiné křestní jméno – možná sourozenec
}

/** Křestní jméno vs. zkratka ("ka" ~ "karolina", "n" ~ "novak"). */
function firstNameMatch(a: string, b: string): number {
  if (a === b) return 1;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (l.startsWith(s)) return s.length === 1 ? 0.75 : 0.85;
  return s.length >= 4 && dice(a, b) >= 0.8 ? 0.8 : 0;
}

/** Podobnost dvou jmen účastníků (0..1). Neshoda značek (U21, ženy, B) = 0. */
export function nameSimilarity(rawA: string, rawB: string, sport: Sport): number {
  const a = normalizeName(rawA, sport);
  const b = normalizeName(rawB, sport);
  if (a.tags.join() !== b.tags.join()) return 0;
  if (a.core === b.core) return 1;
  if (isIndividualSport(sport)) return tennisScore(a.core, b.core);
  const tok = Math.max(
    tokenSetScore(a.tokens, b.tokens),
    tokenSetScore(a.rawTokens, b.rawTokens),
    tokenSetScore(a.tokens, b.rawTokens),
    tokenSetScore(a.rawTokens, b.tokens),
  );
  const chr = dice(a.core.replace(/ /g, ''), b.core.replace(/ /g, ''));
  return Math.max(tok, chr * 0.95);
}

export interface PairScore {
  score: number;
  swapped: boolean;
  home: number;
  away: number;
}

/** Skóre shody dvojice účastníků, v obou orientacích (prohozené pořadí). */
export function pairSimilarity(
  a: { home: string; away: string },
  b: { home: string; away: string },
  sport: Sport,
): PairScore {
  const combine = (h: number, w: number) => (h && w ? 0.7 * Math.min(h, w) + 0.3 * ((h + w) / 2) : 0);
  const h = nameSimilarity(a.home, b.home, sport);
  const w = nameSimilarity(a.away, b.away, sport);
  const straight = combine(h, w);
  const hs = nameSimilarity(a.home, b.away, sport);
  const ws = nameSimilarity(a.away, b.home, sport);
  const swapped = combine(hs, ws);
  return swapped > straight + 0.05
    ? { score: swapped, swapped: true, home: hs, away: ws }
    : { score: straight, swapped: false, home: h, away: w };
}
