// Simulovaný svět zápasů a kurzů pro 8 sázkovek ("testovací kurzy").
// Jeden svět sdílí všechny sázkovky -> stejné zápasy, různá jména, marže, zpoždění a výpadky.
import type { BookmakerId, FeedScope, GameState, RawEvent, RawMarket, SelectionKey, Sport } from '../../core/types.js';
import { BOOKMAKERS } from '../../core/types.js';
import { REQUIRED_SELECTIONS, parseMarketKey } from '../../core/markets.js';
import { LEAGUES, type League } from './pools.js';
import { basketMarkets, footballMarkets, tennisMarkets, type FairMarkets } from './models.js';

// --- PRNG ------------------------------------------------------------------------------------
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

type StateStyle = 'flag' | 'text' | 'clock';

interface BookProfile {
  overround: number;
  liveOverround: number;
  /** relativní šum implikované pravděpodobnosti */
  noise: number;
  /** zpoždění reakce kurzu v live (ms) */
  liveLag: [number, number];
  preLag: [number, number];
  /** pravděpodobnost, že po gólu suspenduje trhy (ostatní nechají chvíli staré kurzy) */
  suspendProb: number;
  stateStyle: StateStyle;
  coverage: number;
  swapTennis: boolean;
  startOffsetMin: number;
  /** ligy, které sázkovka nevypisuje */
  skipLeagues: string[];
}

const PROFILES: Record<BookmakerId, BookProfile> = {
  tipsport: { overround: 0.055, liveOverround: 0.075, noise: 0.012, liveLag: [300, 1200], preLag: [20e3, 90e3], suspendProb: 0.95, stateStyle: 'flag', coverage: 0.95, swapTennis: false, startOffsetMin: 0, skipLeagues: [] },
  fortuna: { overround: 0.06, liveOverround: 0.08, noise: 0.014, liveLag: [400, 1500], preLag: [30e3, 120e3], suspendProb: 0.9, stateStyle: 'text', coverage: 0.93, swapTennis: false, startOffsetMin: 0, skipLeagues: [] },
  betano: { overround: 0.045, liveOverround: 0.065, noise: 0.012, liveLag: [300, 1000], preLag: [20e3, 60e3], suspendProb: 0.95, stateStyle: 'flag', coverage: 0.92, swapTennis: false, startOffsetMin: 0, skipLeagues: [] },
  chance: { overround: 0.06, liveOverround: 0.085, noise: 0.015, liveLag: [500, 2000], preLag: [40e3, 150e3], suspendProb: 0.85, stateStyle: 'flag', coverage: 0.85, swapTennis: false, startOffsetMin: 0, skipLeagues: ['NHL'] },
  sazka: { overround: 0.065, liveOverround: 0.09, noise: 0.016, liveLag: [700, 2500], preLag: [60e3, 180e3], suspendProb: 0.8, stateStyle: 'text', coverage: 0.85, swapTennis: false, startOffsetMin: 5, skipLeagues: [] },
  merkurxtip: { overround: 0.07, liveOverround: 0.095, noise: 0.02, liveLag: [1000, 4000], preLag: [60e3, 240e3], suspendProb: 0.7, stateStyle: 'clock', coverage: 0.8, swapTennis: false, startOffsetMin: 0, skipLeagues: ['WTA Ostrava'] },
  kingsbet: { overround: 0.065, liveOverround: 0.09, noise: 0.018, liveLag: [800, 3000], preLag: [60e3, 200e3], suspendProb: 0.75, stateStyle: 'text', coverage: 0.8, swapTennis: false, startOffsetMin: 0, skipLeagues: ['Euroliga'] },
  betx: { overround: 0.06, liveOverround: 0.085, noise: 0.02, liveLag: [900, 3500], preLag: [45e3, 200e3], suspendProb: 0.7, stateStyle: 'clock', coverage: 0.8, swapTennis: true, startOffsetMin: 0, skipLeagues: [] },
};

interface Quote {
  odds: Partial<Record<SelectionKey, number>>;
  /** pravděpodobnosti, ze kterých sázkovka naposledy vypsala kurz (plynulé dotahování v live) */
  probs: Partial<Record<SelectionKey, number>>;
  open: boolean;
  nextRefreshAt: number;
  noise: Partial<Record<SelectionKey, number>>;
  /** po gólu se kurz při příští obnově přepíše skokem */
  jump?: boolean;
}

interface BookView {
  listed: boolean;
  sourceId: string;
  home: string;
  away: string;
  swapped: boolean;
  startOffsetMs: number;
  competition: string;
  quotes: Map<string, Quote>;
  suspendedUntil: number;
}

interface Boost {
  bk: BookmakerId;
  market: string;
  sel: SelectionKey;
  factor: number;
  until: number;
}

interface SimEvent {
  id: number;
  sport: Sport;
  league: League;
  home: string[];
  away: string[];
  startTime: number;
  status: 'pre' | 'live' | 'finished';
  finishedAt?: number;
  // síla / parametry modelu
  lamH: number;
  lamA: number;
  muDiff: number;
  muTotal: number;
  pSet: number;
  // živý stav
  clockSec: number;
  period: number;
  clockRunning: boolean;
  stopUntil: number;
  breakUntil: number;
  breakKind?: 'ht' | 'period' | 'quarter' | 'set';
  score: [number, number];
  periodScores: [number, number][];
  sets: [number, number];
  games: [number, number];
  points: [number, number];
  setScores: [number, number][];
  nextPointAt: number;
  server: 0 | 1;
  stoppage: number;
  lines: { ou: number[]; ah: number[]; tennisTotal: number };
  fair: FairMarkets;
  fairAt: number;
  books: Map<BookmakerId, BookView>;
  boosts: Boost[];
}

const QUARTER = (e: SimEvent) => (e.league.nba ? 12 * 60 : 10 * 60);
const TICK_MS = 250;

export interface SimOptions {
  seed?: number;
  /** zrychlení herního času (1 = reálný čas) */
  speed?: number;
  /** průměrný počet uměle vyvolaných arbů za minutu */
  arbRate?: number;
  faults?: boolean;
}

export class SimWorld {
  private static instance?: SimWorld;
  static get(opts: SimOptions = {}): SimWorld {
    if (!SimWorld.instance) SimWorld.instance = new SimWorld(opts);
    return SimWorld.instance;
  }

  private rnd: () => number;
  private events = new Map<number, SimEvent>();
  private nextId = 1;
  private timer?: NodeJS.Timeout;
  private lastTick = Date.now();
  readonly speed: number;
  readonly arbRate: number;
  readonly faults: boolean;
  private started = Date.now();

  constructor(opts: SimOptions = {}) {
    this.rnd = mulberry32(opts.seed ?? Number(process.env.SIM_SEED ?? 20260928));
    this.speed = opts.speed ?? Number(process.env.SIM_SPEED ?? 1);
    this.arbRate = opts.arbRate ?? Number(process.env.SIM_ARB_RATE ?? 12);
    this.faults = opts.faults ?? process.env.SIM_FAULTS !== '0';
    this.populate(Date.now());
  }

  start(): void {
    if (this.timer) return;
    this.lastTick = Date.now();
    this.timer = setInterval(() => this.tick(Date.now()), TICK_MS);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  // --- generování -------------------------------------------------------------------------

  private pick<T>(arr: T[]): T {
    return arr[Math.floor(this.rnd() * arr.length)];
  }
  private uniform(a: number, b: number): number {
    return a + (b - a) * this.rnd();
  }
  private gauss(): number {
    const u = Math.max(1e-9, this.rnd());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.rnd());
  }

  private populate(now: number): void {
    const plan: Record<Sport, { pre: number; live: number }> = {
      football: { pre: 18, live: 8 },
      hockey: { pre: 10, live: 5 },
      basketball: { pre: 8, live: 5 },
      tennis: { pre: 10, live: 7 },
    };
    for (const sport of Object.keys(plan) as Sport[]) {
      for (let i = 0; i < plan[sport].live; i++) this.createLiveEvent(sport, now, i);
      for (let i = 0; i < plan[sport].pre; i++) {
        // pár zápasů začne během pár minut, ať je vidět přechod PREMATCH -> LIVE
        const start = i < 2 ? now + this.uniform(2, 8) * 60e3 : now + this.uniform(4, 40) * 3600e3;
        this.createEvent(sport, start, now);
      }
    }
  }

  private createEvent(sport: Sport, startTime: number, now: number): SimEvent | undefined {
    const leagues = LEAGUES.filter((l) => l.sport === sport);
    const league = this.pick(leagues);
    const busy = new Set<string>();
    // tým nemůže hrát dva zápasy v podobném čase (jinak by se zásoba týmů rychle vyčerpala)
    for (const e of this.events.values())
      if (e.league === league && e.status !== 'finished' && Math.abs(e.startTime - startTime) < 4 * 3600e3) busy.add(e.home[0]).add(e.away[0]);
    const free = league.teams.filter((t) => !busy.has(t[0]));
    if (free.length < 2) return undefined;
    const h = this.pick(free);
    const a = this.pick(free.filter((t) => t !== h));
    const e: SimEvent = {
      id: this.nextId++,
      sport,
      league,
      home: h,
      away: a,
      startTime: Math.round(startTime / 60e3) * 60e3,
      status: 'pre',
      lamH: this.uniform(0.9, 2.1),
      lamA: this.uniform(0.6, 1.7),
      muDiff: this.uniform(-9, 11),
      muTotal: league.nba ? this.uniform(214, 236) : this.uniform(150, 172),
      pSet: this.uniform(0.25, 0.78),
      clockSec: 0,
      period: 0,
      clockRunning: false,
      stopUntil: 0,
      breakUntil: 0,
      score: [0, 0],
      periodScores: [],
      sets: [0, 0],
      games: [0, 0],
      points: [0, 0],
      setScores: [],
      nextPointAt: 0,
      server: this.rnd() < 0.5 ? 0 : 1,
      stoppage: 0,
      lines: { ou: [], ah: [], tennisTotal: 21.5 },
      fair: new Map(),
      fairAt: 0,
      books: new Map(),
      boosts: [],
    };
    if (sport === 'hockey') {
      e.lamH = this.uniform(2.4, 3.6);
      e.lamA = this.uniform(2.0, 3.2);
    }
    e.lines = this.linesFor(e);
    for (const bk of BOOKMAKERS) e.books.set(bk, this.makeView(e, bk));
    this.events.set(e.id, e);
    this.recomputeFair(e, now);
    for (const bk of BOOKMAKERS) this.refreshAll(e, bk, now, true);
    return e;
  }

  private linesFor(e: SimEvent): SimEvent['lines'] {
    switch (e.sport) {
      case 'football':
        return { ou: [1.5, 2.5, 3.5], ah: [-1.5, -0.5, 0.5, 1.5], tennisTotal: 0 };
      case 'hockey':
        return { ou: [4.5, 5.5, 6.5], ah: [-1.5, 1.5], tennisTotal: 0 };
      case 'basketball': {
        const t = Math.round(e.muTotal) + 0.5;
        const d = Math.round(e.muDiff) + 0.5;
        return { ou: [t - 4, t, t + 4], ah: [-d, -d + 4, -d - 4], tennisTotal: 0 };
      }
      case 'tennis':
        return { ou: [], ah: [], tennisTotal: this.pick([20.5, 21.5, 22.5]) };
    }
  }

  private makeView(e: SimEvent, bk: BookmakerId): BookView {
    const p = PROFILES[bk];
    const variant = (names: string[]) => names[1 + (hash(bk + names[0]) % (names.length - 1))];
    const listed = !p.skipLeagues.includes(e.league.names[0]) && hash(`${bk}:${e.id}:${e.home[0]}`) % 1000 < p.coverage * 1000;
    const swapped = e.sport === 'tennis' && p.swapTennis && hash(`${bk}:${e.id}`) % 2 === 0;
    const home = variant(e.home);
    const away = variant(e.away);
    return {
      listed,
      // stabilní ID odvozené od zápasu (jako u skutečných sázkovek) – nekoliduje mezi běhy simulátoru
      sourceId: `${bk.slice(0, 3)}-${hash(`${bk}|${e.home[0]}|${e.away[0]}|${e.startTime}`) % 100_000_000}`,
      home: swapped ? away : home,
      away: swapped ? home : away,
      swapped,
      startOffsetMs: p.startOffsetMin && hash(`${bk}${e.id}`) % 4 === 0 ? p.startOffsetMin * 60e3 : 0,
      competition: e.league.names[hash(bk + e.league.names[0]) % e.league.names.length],
      quotes: new Map(),
      suspendedUntil: 0,
    };
  }

  private createLiveEvent(sport: Sport, now: number, i: number): void {
    const e = this.createEvent(sport, now - 60e3, now);
    if (!e) return;
    e.status = 'live';
    // rozprostřít zápasy v čase, několik těsně před přestávkou
    const nearBreak = i % 3 === 0;
    switch (sport) {
      case 'football': {
        e.period = nearBreak || this.rnd() < 0.5 ? 1 : 2;
        e.clockSec = e.period === 1 ? (nearBreak ? 44 * 60 + this.uniform(0, 50) : this.uniform(5, 40) * 60) : this.uniform(50, 85) * 60;
        e.stoppage = Math.round(this.uniform(1, 4)) * 60;
        if (i === 1) {
          e.period = 1;
          e.clockSec = 45 * 60;
          this.startBreak(e, 'ht', now, this.uniform(0.3, 0.8));
        }
        break;
      }
      case 'hockey': {
        e.period = 1 + Math.floor(this.rnd() * 3);
        const into = nearBreak ? 19 * 60 + this.uniform(0, 50) : this.uniform(2, 17) * 60;
        e.clockSec = (e.period - 1) * 1200 + into;
        if (i === 1) {
          e.period = Math.min(e.period, 2);
          e.clockSec = e.period * 1200;
          this.startBreak(e, 'period', now, this.uniform(0.2, 0.9));
        }
        break;
      }
      case 'basketball': {
        const q = QUARTER(e);
        e.period = 1 + Math.floor(this.rnd() * 4);
        e.clockSec = (e.period - 1) * q + (nearBreak ? q - this.uniform(10, 40) : this.uniform(60, q - 60));
        if (i === 1 && e.period < 4) {
          e.clockSec = e.period * q;
          this.startBreak(e, e.period === 2 ? 'ht' : 'quarter', now, this.uniform(0.2, 0.9));
        }
        break;
      }
      case 'tennis': {
        e.period = 1 + (this.rnd() < 0.4 ? 1 : 0);
        if (e.period === 2) {
          const hw = this.rnd() < e.pSet;
          e.sets = hw ? [1, 0] : [0, 1];
          e.setScores = [hw ? [6, 3] : [4, 6]];
        }
        e.games = [Math.floor(this.uniform(0, 5)), Math.floor(this.uniform(0, 5))];
        if (nearBreak) e.games = [5, Math.floor(this.uniform(2, 5))];
        if (i === 1 && e.period === 1) {
          const hw = this.rnd() < e.pSet;
          e.sets = hw ? [1, 0] : [0, 1];
          e.setScores = [hw ? [6, 4] : [3, 6]];
          e.period = 2;
          e.games = [0, 0];
          this.startBreak(e, 'set', now, this.uniform(0.1, 0.6));
        }
        e.nextPointAt = now + this.pointGap();
        break;
      }
    }
    e.score = this.initialScore(e);
    e.clockRunning = e.breakUntil <= now;
    this.recomputeFair(e, now);
    for (const bk of BOOKMAKERS) this.refreshAll(e, bk, now, true);
  }

  private initialScore(e: SimEvent): [number, number] {
    if (e.sport === 'tennis') return [e.sets[0], e.sets[1]];
    if (e.sport === 'basketball') {
      const played = e.clockSec / (4 * QUARTER(e));
      const t = e.muTotal * played;
      const d = e.muDiff * played + this.gauss() * 6 * Math.sqrt(played);
      return [Math.max(0, Math.round((t + d) / 2)), Math.max(0, Math.round((t - d) / 2))];
    }
    const full = e.sport === 'football' ? 5400 : 3600;
    const f = Math.min(1, e.clockSec / full);
    const draw = (lam: number) => {
      let k = 0;
      let p = Math.exp(-lam);
      let s = p;
      const u = this.rnd();
      while (u > s && k < 10) {
        k++;
        p = (p * lam) / k;
        s += p;
      }
      return k;
    };
    return [draw(e.lamH * f), draw(e.lamA * f)];
  }

  private pointGap(): number {
    return (this.uniform(22, 45) * 1000) / this.speed;
  }

  private startBreak(e: SimEvent, kind: SimEvent['breakKind'], now: number, alreadyElapsedFrac = 0): void {
    const sec = kind === 'ht' ? 900 : kind === 'period' ? 1020 : kind === 'quarter' ? 120 : 120;
    e.breakKind = kind;
    e.breakUntil = now + (sec * (1 - alreadyElapsedFrac) * 1000) / this.speed;
    e.clockRunning = false;
  }

  // --- simulace ---------------------------------------------------------------------------

  private tick(now: number): void {
    const dt = Math.min(2000, now - this.lastTick);
    this.lastTick = now;
    const gameDt = (dt / 1000) * this.speed;
    for (const e of this.events.values()) {
      if (e.status === 'pre') {
        if (now >= e.startTime) this.kickoff(e, now);
        else if (this.rnd() < dt / 90_000) this.driftPrematch(e, now);
      } else if (e.status === 'live') {
        this.advance(e, now, gameDt);
      } else if (e.finishedAt && now - e.finishedAt > 90_000) {
        this.events.delete(e.id);
      }
      if (e.status !== 'finished') this.updateQuotes(e, now);
    }
    this.maybeInjectArb(now, dt);
    this.replenish(now);
  }

  private kickoff(e: SimEvent, now: number): void {
    e.status = 'live';
    e.period = 1;
    e.clockSec = 0;
    e.clockRunning = true;
    e.stoppage = Math.round(this.uniform(1, 4)) * 60;
    if (e.sport === 'tennis') e.nextPointAt = now + this.pointGap();
    this.recomputeFair(e, now);
  }

  private driftPrematch(e: SimEvent, now: number): void {
    e.lamH *= Math.exp(this.gauss() * 0.03);
    e.lamA *= Math.exp(this.gauss() * 0.03);
    e.muDiff += this.gauss() * 0.4;
    e.pSet = Math.min(0.9, Math.max(0.1, e.pSet + this.gauss() * 0.01));
    this.recomputeFair(e, now);
  }

  private advance(e: SimEvent, now: number, gameDt: number): void {
    if (e.breakUntil > now) {
      e.clockRunning = false;
      return;
    }
    if (e.breakKind) {
      // konec přestávky
      e.breakKind = undefined;
      e.clockRunning = true;
      if (e.sport !== 'tennis') e.period += 1;
      if (e.sport === 'football') e.stoppage = Math.round(this.uniform(2, 5)) * 60;
      this.recomputeFair(e, now);
    }
    const scored = e.sport === 'tennis' ? this.advanceTennis(e, now) : this.advanceClock(e, now, gameDt);
    if (scored) {
      this.recomputeFair(e, now);
      this.onScore(e, now);
    } else if (now - e.fairAt > (e.sport === 'basketball' ? 2_000 : 4_000)) {
      this.recomputeFair(e, now);
    }
  }

  /** Posune hodiny a vrátí true, když padl gól/koš. */
  private advanceClock(e: SimEvent, now: number, gameDt: number): boolean {
    // přerušení hry: hokej a basket mají časté zastavení hodin
    if (e.sport !== 'football') {
      if (e.stopUntil > now) {
        e.clockRunning = false;
        return false;
      }
      const stopRate = e.sport === 'hockey' ? 1 / 40 : 1 / 25;
      if (this.rnd() < stopRate * gameDt) {
        e.stopUntil = now + (this.uniform(8, 35) * 1000) / this.speed;
        e.clockRunning = false;
        return false;
      }
    }
    e.clockRunning = true;
    const before = e.clockSec;
    e.clockSec += gameDt;
    let scored = false;
    if (e.sport === 'football') {
      if (this.rnd() < (e.lamH / 5400) * gameDt) (e.score[0]++, (scored = true));
      if (this.rnd() < (e.lamA / 5400) * gameDt) (e.score[1]++, (scored = true));
      const halfEnd = 45 * 60 + e.stoppage;
      if (e.period === 1 && e.clockSec >= halfEnd) {
        e.clockSec = halfEnd;
        e.periodScores.push([...e.score]);
        this.startBreak(e, 'ht', now);
        e.clockSec = 45 * 60; // mnoho feedů po poločase ukazuje 45:00
      } else if (e.period === 2 && e.clockSec >= 90 * 60 + e.stoppage) {
        this.finish(e, now);
      } else if (e.period === 2 && before < 45 * 60) e.clockSec = Math.max(e.clockSec, 45 * 60);
    } else if (e.sport === 'hockey') {
      if (this.rnd() < (e.lamH / 3600) * gameDt) (e.score[0]++, (scored = true));
      if (this.rnd() < (e.lamA / 3600) * gameDt) (e.score[1]++, (scored = true));
      const end = e.period * 1200;
      if (e.clockSec >= end) {
        e.clockSec = end;
        e.periodScores.push([...e.score]);
        if (e.period >= 3) {
          if (e.score[0] === e.score[1]) e.score[this.rnd() < 0.5 ? 0 : 1]++; // prodloužení/nájezdy zjednodušeně
          this.finish(e, now);
        } else this.startBreak(e, 'period', now);
      }
    } else {
      const q = QUARTER(e);
      const ptsPerSec = e.muTotal / (4 * q);
      const homeShare = 0.5 + e.muDiff / (2 * e.muTotal);
      if (this.rnd() < (ptsPerSec / 2.1) * gameDt) {
        const pts = this.rnd() < 0.3 ? 3 : this.rnd() < 0.15 ? 1 : 2;
        e.score[this.rnd() < homeShare ? 0 : 1] += pts;
        scored = now - e.fairAt > 1500; // přepočet po koši, ale nejvýš jednou za 1,5 s
      }
      const end = e.period * q;
      if (e.clockSec >= end) {
        e.clockSec = end;
        e.periodScores.push([...e.score]);
        if (e.period >= 4) {
          if (e.score[0] === e.score[1]) e.score[this.rnd() < homeShare ? 0 : 1] += 2;
          this.finish(e, now);
        } else this.startBreak(e, e.period === 2 ? 'ht' : 'quarter', now);
      }
    }
    return scored;
  }

  private advanceTennis(e: SimEvent, now: number): boolean {
    if (now < e.nextPointAt) return false;
    e.nextPointAt = now + this.pointGap();
    const pPoint = 0.5 + (e.pSet - 0.5) * 0.3 + (e.server === 0 ? 0.12 : -0.12);
    const w = this.rnd() < pPoint ? 0 : 1;
    e.points[w]++;
    const [a, b] = e.points;
    const tiebreak = e.games[0] === 6 && e.games[1] === 6;
    const need = tiebreak ? 7 : 4;
    if ((a >= need || b >= need) && Math.abs(a - b) >= 2) {
      e.games[w]++;
      e.points = [0, 0];
      e.server = e.server === 0 ? 1 : 0;
      const [g0, g1] = e.games;
      const setWon = (g0 >= 6 || g1 >= 6) && (Math.abs(g0 - g1) >= 2 || g0 === 7 || g1 === 7);
      if (setWon) {
        e.setScores.push([g0, g1]);
        e.sets[g0 > g1 ? 0 : 1]++;
        e.score = [...e.sets] as [number, number];
        e.games = [0, 0];
        if (e.sets[0] === 2 || e.sets[1] === 2) this.finish(e, now);
        else {
          e.period += 1;
          this.startBreak(e, 'set', now);
        }
      }
      return true; // gem = pohyb kurzů
    }
    return false;
  }

  private finish(e: SimEvent, now: number): void {
    e.status = 'finished';
    e.finishedAt = now;
    e.clockRunning = false;
  }

  private onScore(e: SimEvent, now: number): void {
    // většina sázkovek po gólu suspenduje trhy; líné nechají chvíli staré kurzy (=> krátké live arby)
    for (const bk of BOOKMAKERS) {
      const p = PROFILES[bk];
      const v = e.books.get(bk)!;
      const big = e.sport === 'football' || e.sport === 'hockey';
      if (big && this.rnd() < p.suspendProb) v.suspendedUntil = now + (this.uniform(6, 25) * 1000) / this.speed;
      for (const q of v.quotes.values()) {
        q.nextRefreshAt = now + this.uniform(p.liveLag[0], p.liveLag[1]) * (big ? 1 : 0.6);
        if (big) q.jump = true;
      }
    }
  }

  private recomputeFair(e: SimEvent, now: number): void {
    e.fairAt = now;
    if (e.sport === 'football' || e.sport === 'hockey') {
      const full = e.sport === 'football' ? 5400 : 3600;
      const played = e.status === 'pre' ? 0 : Math.min(1, e.clockSec / full);
      const rem = 1 - played;
      const state = { lamH: e.lamH * rem, lamA: e.lamA * rem, score: e.score };
      const periodLen = e.sport === 'football' ? 2700 : 1200;
      const inFirst = e.status === 'pre' || (e.period <= 1 && !e.breakKind && e.clockSec < periodLen);
      const remFirst = Math.max(0, (periodLen - (e.status === 'pre' ? 0 : e.clockSec)) / full);
      const first = inFirst ? { lamH: e.lamH * remFirst, lamA: e.lamA * remFirst, score: e.status === 'pre' ? ([0, 0] as [number, number]) : e.score } : undefined;
      e.fair = footballMarkets(state, first, {
        ouLines: e.lines.ou,
        ahLines: e.lines.ah,
        hockey: e.sport === 'hockey',
        periodScope: e.sport === 'football' ? 'H1' : 'P1',
      });
    } else if (e.sport === 'basketball') {
      const total = 4 * QUARTER(e);
      const rem = e.status === 'pre' ? 1 : Math.max(0.01, 1 - e.clockSec / total);
      e.fair = basketMarkets(
        { muDiff: e.muDiff * rem, sdDiff: 12.5 * Math.sqrt(rem), muTotal: e.muTotal * rem, sdTotal: 16 * Math.sqrt(rem), score: e.score },
        { ou: e.lines.ou, ah: e.lines.ah },
      );
    } else {
      e.fair = tennisMarkets({
        pSet: e.pSet,
        sets: e.sets,
        games: e.games,
        started: e.status === 'live',
        totalGamesSoFar: e.setScores.reduce((s, x) => s + x[0] + x[1], 0) + e.games[0] + e.games[1],
        totalLine: e.lines.tennisTotal,
        currentSet: e.sets[0] + e.sets[1] + 1,
      });
    }
  }

  private roundOdds(o: number): number {
    const x = Math.min(1000, Math.max(1.01, o));
    if (x < 3) return Math.round(x * 100) / 100;
    if (x < 10) return Math.round(x * 20) / 20;
    if (x < 30) return Math.round(x * 2) / 2;
    return Math.round(x);
  }

  private quoteFor(e: SimEvent, bk: BookmakerId, key: string, probs: Partial<Record<SelectionKey, number>>, prev?: Quote): Quote {
    const p = PROFILES[bk];
    const live = e.status === 'live';
    const over = live ? p.liveOverround : p.overround;
    const noise = prev?.noise ?? {};
    const odds: Partial<Record<SelectionKey, number>> = {};
    const quoted: Partial<Record<SelectionKey, number>> = {};
    // v live sázkovka kurz dotahuje k férové hodnotě plynule; skok jen po gólu (jump)
    const alpha = live && prev && !prev.jump ? 0.35 : 1;
    for (const [sel, fair] of Object.entries(probs) as [SelectionKey, number][]) {
      const before = prev?.probs[sel];
      const prob = before === undefined ? fair : before + alpha * (fair - before);
      quoted[sel] = prob;
      // pomalu se měnící šum sázkovky (někdo favorita podceňuje, někdo přeceňuje)
      if (noise[sel] === undefined) noise[sel] = this.gauss() * p.noise;
      else if (this.rnd() < 0.08) noise[sel] = noise[sel]! * 0.8 + this.gauss() * p.noise * 0.6;
      const implied = Math.max(0.001, prob * (1 + over) * (1 + noise[sel]!));
      odds[sel] = this.roundOdds(1 / implied);
    }
    const lag = live ? p.liveLag : p.preLag;
    return { odds, probs: quoted, open: true, noise, nextRefreshAt: Date.now() + this.uniform(lag[0], lag[1]) };
  }

  private refreshAll(e: SimEvent, bk: BookmakerId, now: number, force = false): void {
    const v = e.books.get(bk)!;
    for (const [key, probs] of e.fair) {
      const prev = v.quotes.get(key);
      if (force || !prev || now >= prev.nextRefreshAt) v.quotes.set(key, this.quoteFor(e, bk, key, probs, prev));
    }
    for (const key of [...v.quotes.keys()]) if (!e.fair.has(key)) v.quotes.delete(key);
  }

  private updateQuotes(e: SimEvent, now: number): void {
    for (const bk of BOOKMAKERS) this.refreshAll(e, bk, now);
    e.boosts = e.boosts.filter((b) => b.until > now);
  }

  /** Uměle vyvolaný arb: jedna sázkovka "zaspí" nebo přestřelí kurz na jednom výběru. */
  private maybeInjectArb(now: number, dt: number): void {
    if (this.rnd() > (this.arbRate / 60_000) * dt) return;
    const candidates = [...this.events.values()].filter((e) => e.status !== 'finished' && e.fair.size);
    if (!candidates.length) return;
    // preferuj rovnoměrně režimy
    const r = this.rnd();
    const pool =
      r < 0.4
        ? candidates.filter((e) => e.status === 'pre')
        : r < 0.7
          ? candidates.filter((e) => e.status === 'live' && e.breakUntil > now)
          : candidates.filter((e) => e.status === 'live' && e.breakUntil <= now);
    const e = this.pick(pool.length ? pool : candidates);
    const key = this.pick([...e.fair.keys()]);
    const sels = REQUIRED_SELECTIONS[parseMarketKey(key).type];
    const sel = this.pick(sels);
    const listed = BOOKMAKERS.filter((b) => e.books.get(b)!.listed && e.books.get(b)!.quotes.get(key)?.odds[sel]);
    if (listed.length < 2) return;
    const bk = this.pick(listed);
    // nejlepší kurzy ostatních výběrů
    let invOthers = 0;
    for (const s of sels) {
      if (s === sel) continue;
      let best = 0;
      for (const b of listed) best = Math.max(best, this.boostedOdds(e, b, key, s, now) ?? 0);
      if (!best) return;
      invOthers += 1 / best;
    }
    const live = e.status === 'live';
    const paused = live && e.breakUntil > now;
    const target = paused ? this.uniform(1.0, 4.5) : live ? this.uniform(1.4, 7) : this.uniform(0.5, 3.5);
    const needInv = 1 / (1 + target / 100) - invOthers;
    if (needInv <= 0.02) return;
    const base = e.books.get(bk)!.quotes.get(key)!.odds[sel]!;
    const factor = 1 / needInv / base;
    if (factor < 1 || factor > 1.6) return;
    const medianMs = paused ? 25_000 : live ? 7_000 : 90_000;
    const dur = Math.min(20 * 60e3, medianMs * Math.exp(this.gauss() * 0.9));
    e.boosts.push({ bk, market: key, sel, factor, until: now + dur / this.speed });
  }

  private boostedOdds(e: SimEvent, bk: BookmakerId, key: string, sel: SelectionKey, now: number): number | undefined {
    const o = e.books.get(bk)!.quotes.get(key)?.odds[sel];
    if (!o) return undefined;
    const b = e.boosts.find((x) => x.bk === bk && x.market === key && x.sel === sel && x.until > now);
    return b ? this.roundOdds(o * b.factor) : o;
  }

  private replenish(now: number): void {
    const counts: Record<Sport, number> = { football: 0, hockey: 0, basketball: 0, tennis: 0 };
    for (const e of this.events.values()) if (e.status === 'pre') counts[e.sport]++;
    const target: Record<Sport, number> = { football: 18, hockey: 10, basketball: 8, tennis: 10 };
    for (const s of Object.keys(target) as Sport[])
      if (counts[s] < target[s] && this.rnd() < 0.02) this.createEvent(s, now + this.uniform(0.1, 30) * 3600e3, now);
    // a průběžně pár zápasů těsně před začátkem
    if (this.rnd() < 0.0015) this.createEvent(this.pick(['football', 'hockey', 'basketball', 'tennis'] as Sport[]), now + this.uniform(3, 10) * 60e3, now);
  }

  // --- výstup pro strategie ---------------------------------------------------------------

  /** Chyba, kterou má strategie simulovat (výpadky kvůli ukázce circuit breakeru). */
  fault(bk: BookmakerId, level: number, now = Date.now()): string | null {
    if (!this.faults) return null;
    if (this.rnd() < 0.004) return 'simulated network error';
    // Fortuna level 2: pravidelný výpadek 4 min z každých 30 min
    if (bk === 'fortuna' && level === 2) {
      const cycle = ((now - this.started) / 60e3) % 30;
      if (cycle >= 12 && cycle < 16) return 'HTTP 503 (simulated outage)';
    }
    return null;
  }

  snapshot(bk: BookmakerId, scope: FeedScope, now = Date.now()): RawEvent[] {
    const out: RawEvent[] = [];
    const style = PROFILES[bk].stateStyle;
    for (const e of this.events.values()) {
      const v = e.books.get(bk)!;
      if (!v.listed) continue;
      const live = e.status === 'live' || (e.status === 'finished' && now - (e.finishedAt ?? 0) < 20_000);
      if ((scope === 'live') !== live) continue;
      if (scope === 'prematch' && e.startTime <= now) continue;
      const suspended = e.status === 'finished' || v.suspendedUntil > now;
      const markets: RawMarket[] = [];
      for (const [key, q] of v.quotes) {
        const sels = (Object.keys(q.odds) as SelectionKey[]).map((sel) => {
          let s = sel;
          if (v.swapped) s = sel === 'HOME' ? 'AWAY' : sel === 'AWAY' ? 'HOME' : sel;
          return { key: s, odds: this.boostedOdds(e, bk, key, sel, now)! };
        });
        let mk = key;
        if (v.swapped) {
          const p = parseMarketKey(key);
          if ((p.type === 'AH' || p.type === 'AH_SETS') && p.line !== undefined) mk = `${p.type}|${p.scope}|${-p.line}`;
        }
        markets.push({ key: mk, open: !suspended, selections: sels });
      }
      out.push({
        sourceId: v.sourceId,
        sport: e.sport,
        competition: v.competition,
        country: e.league.country,
        home: v.home,
        away: v.away,
        startTime: e.startTime + v.startOffsetMs,
        live,
        state: live ? this.stateFor(e, style, v.swapped, now) : undefined,
        markets,
      });
    }
    return out;
  }

  private stateFor(e: SimEvent, style: StateStyle, swapped: boolean, now: number): GameState {
    const sw = <T>(p: [T, T]): [T, T] => (swapped ? [p[1], p[0]] : p);
    const inBreak = e.breakUntil > now;
    const finished = e.status === 'finished';
    const st: GameState = { score: sw([...e.score] as [number, number]), period: Math.max(1, e.period) };
    if (e.periodScores.length) st.periodScores = e.periodScores.map((p) => sw([...p] as [number, number]));
    if (e.sport === 'tennis') {
      st.games = sw([...e.games] as [number, number]);
      st.points = this.tennisPoints(e, swapped);
      st.periodScores = e.setScores.map((p) => sw([...p] as [number, number]));
    } else st.clockSec = Math.floor(e.clockSec);
    if (finished) st.finished = true;
    if (style === 'clock') return st; // jen hodiny a skóre -> fallback detekce
    const text = this.statusText(e, inBreak, finished);
    st.statusText = text;
    if (style === 'flag') {
      st.breakFlag = inBreak;
      if (e.sport !== 'tennis') st.clockRunning = e.clockRunning && !inBreak;
    }
    return st;
  }

  private tennisPoints(e: SimEvent, swapped: boolean): string {
    const tb = e.games[0] === 6 && e.games[1] === 6;
    const lab = ['0', '15', '30', '40'];
    let [a, b] = e.points;
    if (swapped) [a, b] = [b, a];
    if (tb) return `${a}-${b}`;
    if (a >= 3 && b >= 3) return a === b ? '40-40' : a > b ? 'A-40' : '40-A';
    return `${lab[Math.min(3, a)]}-${lab[Math.min(3, b)]}`;
  }

  private statusText(e: SimEvent, inBreak: boolean, finished: boolean): string {
    if (finished) return 'Konec';
    switch (e.sport) {
      case 'football':
        return inBreak ? 'Poločas' : `${e.period}. poločas`;
      case 'hockey':
        return inBreak ? `Konec ${e.period}. třetiny` : `${e.period}. třetina`;
      case 'basketball':
        return inBreak ? (e.breakKind === 'ht' ? 'Poločas' : 'Přestávka') : `${e.period}. čtvrtina`;
      case 'tennis':
        return inBreak ? 'Přestávka' : `${e.period}. set`;
    }
  }

  /** Pro testy/diagnostiku. */
  stats(): { events: number; live: number; paused: number; boosts: number } {
    const now = Date.now();
    let live = 0,
      paused = 0,
      boosts = 0;
    for (const e of this.events.values()) {
      if (e.status === 'live') live++;
      if (e.status === 'live' && e.breakUntil > now) paused++;
      boosts += e.boosts.length;
    }
    return { events: this.events.size, live, paused, boosts };
  }
}
