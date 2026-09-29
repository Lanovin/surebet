// Režim kanonické události (PREMATCH / LIVE / PAUSED) ze stavů hlášených sázkovkami.
import type { BookmakerId, GameState, PauseInfo, RawEvent } from '../../core/types.js';
import { updatePause, statusSaysBreak, type PauseTracker } from '../../core/pause.js';
import type { Settings } from '../../core/settings.js';
import type { EventView } from '../../shared/protocol.js';
import type { CanonEvent } from '../matching/matcher.js';

const FRESH_MS = 20_000;

interface BookReport {
  live: boolean;
  state?: GameState;
  seenAt: number;
  marketOpen: boolean;
  tracker: PauseTracker;
  pause?: PauseInfo;
  /** sázkovka dává explicitní stav (flag / text), ne jen hodiny */
  authoritative: boolean;
}

interface Tracked {
  canon: CanonEvent;
  reports: Map<BookmakerId, BookReport>;
  view: EventView;
  lastPublished?: string;
  lastPublishedAt: number;
  dirty: boolean;
}

export class EventTracker {
  private events = new Map<number, Tracked>();

  constructor(private settings: () => Settings) {}

  get(id: number): EventView | undefined {
    return this.events.get(id)?.view;
  }

  all(): EventView[] {
    return [...this.events.values()].map((t) => t.view);
  }

  report(canon: CanonEvent, bk: BookmakerId, raw: RawEvent, swapped: boolean, now: number): void {
    let t = this.events.get(canon.id);
    if (!t) {
      t = {
        canon,
        reports: new Map(),
        view: {
          id: canon.id,
          sport: canon.sport,
          competition: canon.competition || raw.competition,
          home: canon.home,
          away: canon.away,
          startTime: canon.startTime,
          mode: 'PREMATCH',
          live: false,
          finished: false,
          books: [],
          isSim: canon.isSim,
          updatedAt: now,
        },
        lastPublishedAt: 0,
        dirty: true,
      };
      this.events.set(canon.id, t);
    }
    let r = t.reports.get(bk);
    if (!r) t.reports.set(bk, (r = { live: false, seenAt: 0, marketOpen: false, tracker: {}, authoritative: false }));
    r.live = raw.live;
    r.seenAt = now;
    r.state = raw.state ? (swapped ? swapState(raw.state) : raw.state) : undefined;
    r.marketOpen = raw.markets.some((m) => m.open);
    r.authoritative = !!r.state && (r.state.breakFlag !== undefined || statusSaysBreak(r.state.statusText) !== null);
    const cfg = this.settings().pause;
    r.pause = r.live ? updatePause(r.tracker, { sport: canon.sport, competition: t.view.competition, state: r.state, marketOpen: r.marketOpen, now }, cfg) : undefined;
    this.recompute(t, now);
  }

  /** Časově řízené přepočty (fallback pauzy, zastarání). Vrací změněné pohledy. */
  tick(now: number): void {
    for (const [id, t] of this.events) {
      const fresh = [...t.reports.values()].some((r) => now - r.seenAt < FRESH_MS);
      if (!fresh && now - t.view.updatedAt > 30 * 60_000) {
        this.events.delete(id);
        continue;
      }
      this.recompute(t, now);
    }
  }

  private recompute(t: Tracked, now: number): void {
    const fresh = [...t.reports.entries()].filter(([, r]) => now - r.seenAt < FRESH_MS);
    const liveReports = fresh.filter(([, r]) => r.live);
    const v = t.view;
    v.books = [...t.reports.keys()];
    const wasLive = v.live;
    v.live = liveReports.length > 0 || (wasLive && !v.finished && fresh.length === 0);
    v.finished = liveReports.some(([, r]) => r.state?.finished);
    // primární stav: autoritativní (flag/text) sázkovka s nejčerstvějšími daty, jinak kdokoli s hodinami
    const withState = liveReports.filter(([, r]) => r.state);
    withState.sort((a, b) => Number(b[1].authoritative) - Number(a[1].authoritative) || b[1].seenAt - a[1].seenAt);
    const primary = withState[0];
    v.state = primary?.[1].state;
    v.stateFrom = primary?.[0];
    // přestávka: rozhodují autoritativní sázkovky většinou; když žádná není, fallback z hodin
    const auth = withState.filter(([, r]) => r.authoritative);
    let pause: PauseInfo | undefined;
    if (auth.length) {
      const paused = auth.filter(([, r]) => r.pause);
      if (paused.length * 2 > auth.length) pause = earliest(paused.map(([, r]) => r.pause!));
    } else {
      const paused = withState.filter(([, r]) => r.pause);
      if (paused.length) pause = earliest(paused.map(([, r]) => r.pause!));
    }
    // přestávka drží původní začátek, ať se "uplynulý čas" nerestartuje
    if (pause && v.pause && v.pause.type === pause.type) pause = v.pause;
    v.pause = v.live && !v.finished ? pause : undefined;
    v.mode = !v.live ? 'PREMATCH' : v.pause ? 'PAUSED' : 'LIVE';
    v.updatedAt = now;
    const sig = JSON.stringify([v.mode, v.finished, v.pause?.type, v.pause?.startedAt, v.state?.score, v.state?.period, v.state?.games, v.books.length]);
    if (sig !== t.lastPublished) t.dirty = true;
    else if (v.live && now - t.lastPublishedAt > 5_000) t.dirty = true; // hodiny/body stačí posílat po 5 s
  }

  /** Vrátí pohledy, které je potřeba publikovat, a označí je jako odeslané. */
  drainChanged(now: number): EventView[] {
    const out: EventView[] = [];
    for (const t of this.events.values()) {
      if (!t.dirty) continue;
      t.dirty = false;
      t.lastPublishedAt = now;
      t.lastPublished = JSON.stringify([t.view.mode, t.view.finished, t.view.pause?.type, t.view.pause?.startedAt, t.view.state?.score, t.view.state?.period, t.view.state?.games, t.view.books.length]);
      out.push({ ...t.view });
    }
    return out;
  }

  /** Poptávka po live datech pro danou sázkovku (určuje interval live pollingu). */
  liveDemand(bk: BookmakerId, now = Date.now()): 'LIVE' | 'PAUSED' | 'IDLE' {
    let paused = false;
    for (const t of this.events.values()) {
      const r = t.reports.get(bk);
      if (!r || !r.live || now - r.seenAt > FRESH_MS || t.view.finished) continue;
      if (t.view.mode === 'LIVE') return 'LIVE';
      if (t.view.mode === 'PAUSED') paused = true;
    }
    return paused ? 'PAUSED' : 'IDLE';
  }
}

function earliest(ps: PauseInfo[]): PauseInfo {
  return ps.reduce((a, b) => (b.startedAt < a.startedAt ? b : a));
}

function swapState(s: GameState): GameState {
  const sw = (p?: [number, number]): [number, number] | undefined => (p ? [p[1], p[0]] : undefined);
  return {
    ...s,
    score: sw(s.score),
    games: sw(s.games),
    periodScores: s.periodScores?.map((p) => [p[1], p[0]] as [number, number]),
    points: s.points?.includes('-') ? s.points.split('-').reverse().join('-') : s.points,
  };
}
