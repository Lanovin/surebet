// Detekce přestávek (režim PAUSED): primárně ze stavových polí feedu, fallback z herních hodin.
import type { GameState, PauseInfo, PauseType, Sport } from './types.js';
import { fold } from './names.js';

export interface PauseConfig {
  expectedSec: Record<PauseType, number>;
  fallbackSec: Record<Sport, number>;
}

export interface PauseTracker {
  lastClockSec?: number;
  clockChangedAt?: number;
  scoreKey?: string;
  scoreChangedAt?: number;
  lastPeriod?: number;
  periodChangedAt?: number;
  progressKey?: string;
  progressChangedAt?: number;
  pause?: PauseInfo;
}

/** true = text hlásí přestávku, false = text hlásí běžící hru, null = nevíme. */
export function statusSaysBreak(text: string | undefined): boolean | null {
  if (!text) return null;
  const t = fold(text);
  if (/^\d\s*(st|nd|rd|th)?\s*(polocas|half|tretina|ctvrtina|set|period|quarter|q)\b/.test(t)) return false;
  if (/(^|\s)(ht|halftime|half time|polocas|polocasova|prestavka|pauza|pause|break|intermission|interval)(\s|$)/.test(t))
    return true;
  if (/konec\s+\d?\s*(tretiny|ctvrtiny|setu|polocasu|periody|period|quarter)/.test(t)) return true;
  if (/po\s+\d\s*(tretine|ctvrtine|setu|polocase)/.test(t)) return true;
  if (/(end|after)\s+(of\s+)?(the\s+)?(\d\s*(st|nd|rd|th)?\s+)?(period|quarter|set|half)/.test(t)) return true;
  if (/(^|\s)(p|q|s)\d\s*(end|break)/.test(t)) return true;
  return null;
}

function isNba(competition?: string): boolean {
  return !!competition && /\bnba\b/i.test(competition);
}

export function quarterLengthSec(competition?: string): number {
  return isNba(competition) ? 12 * 60 : 10 * 60;
}

export function pauseTypeFor(sport: Sport, state: GameState | undefined, competition?: string): PauseType {
  switch (sport) {
    case 'football':
      return 'football_ht';
    case 'hockey':
      return 'hockey_intermission';
    case 'tennis':
      return 'tennis_set_break';
    case 'basketball': {
      const txt = state?.statusText ? fold(state.statusText) : '';
      if (/polocas|half/.test(txt)) return 'basketball_ht';
      const q = quarterLengthSec(competition);
      const p =
        state?.period ?? (state?.clockSec !== undefined ? Math.max(1, Math.round(state.clockSec / q)) : undefined);
      return p === 2 ? 'basketball_ht' : 'basketball_quarter';
    }
  }
}

/** Stojí hodiny na hranici periody (konec třetiny/čtvrtiny/poločasu)? */
export function atPeriodBoundary(sport: Sport, state: GameState, competition?: string): boolean {
  if (state.periodRemainingSec !== undefined && state.periodRemainingSec <= 1) return true;
  const c = state.clockSec;
  if (c === undefined) return false;
  switch (sport) {
    case 'football':
      return c >= 45 * 60 - 30 && c <= 60 * 60 && (state.period === undefined || state.period <= 1);
    case 'hockey': {
      const into = c % (20 * 60);
      return c >= 20 * 60 - 5 && c <= 60 * 60 && (into <= 3 || into >= 20 * 60 - 3);
    }
    case 'basketball': {
      const q = quarterLengthSec(competition);
      const into = c % q;
      return c >= q - 5 && c < 4 * q && (into <= 3 || into >= q - 3);
    }
    case 'tennis':
      return false;
  }
}

function makePause(sport: Sport, state: GameState | undefined, competition: string | undefined, now: number, cfg: PauseConfig, source: PauseInfo['source']): PauseInfo {
  const type = pauseTypeFor(sport, state, competition);
  return { type, startedAt: now, expectedSec: cfg.expectedSec[type], source };
}

/**
 * Aktualizuje tracker o nový herní stav a vrátí aktuální přestávku (nebo undefined).
 * `marketOpen` = aspoň jeden trh události je otevřený.
 */
export function updatePause(
  tr: PauseTracker,
  input: { sport: Sport; competition?: string; state?: GameState; marketOpen: boolean; now: number },
  cfg: PauseConfig,
): PauseInfo | undefined {
  const { sport, state, now, competition } = input;
  if (!state || state.finished) {
    tr.pause = undefined;
    return undefined;
  }
  // --- sledování pohybu hodin, skóre a period
  if (state.clockSec !== undefined && state.clockSec !== tr.lastClockSec) {
    tr.lastClockSec = state.clockSec;
    tr.clockChangedAt = now;
  }
  const scoreKey = JSON.stringify([state.score, state.games]);
  if (scoreKey !== tr.scoreKey) {
    tr.scoreKey = scoreKey;
    tr.scoreChangedAt = now;
  }
  if (state.period !== undefined && state.period !== tr.lastPeriod) {
    tr.lastPeriod = state.period;
    tr.periodChangedAt = now;
  }
  const progressKey = JSON.stringify([state.games, state.points, state.periodScores?.length]);
  if (progressKey !== tr.progressKey) {
    tr.progressKey = progressKey;
    tr.progressChangedAt = now;
  }

  // --- 1) primárně stavová pole feedu
  const textBreak = statusSaysBreak(state.statusText);
  const feedBreak = state.breakFlag === true || textBreak === true;
  const feedPlaying = state.breakFlag === false || textBreak === false || state.clockRunning === true;
  if (feedBreak) {
    if (!tr.pause) tr.pause = makePause(sport, state, competition, now, cfg, 'feed');
    return tr.pause;
  }
  if (tr.pause?.source === 'feed') {
    tr.pause = undefined;
    return undefined;
  }

  // --- 2) fallback: čas stojí > X s, trh otevřený, skóre beze změny
  const fbMs = cfg.fallbackSec[sport] * 1000;
  if (tr.pause?.source === 'clock_fallback') {
    const clockMoved = (tr.clockChangedAt ?? 0) > tr.pause.startedAt;
    const progressed = sport === 'tennis' && (tr.progressChangedAt ?? 0) > tr.pause.startedAt;
    if (clockMoved || progressed || feedPlaying || (tr.scoreChangedAt ?? 0) > tr.pause.startedAt) {
      tr.pause = undefined;
      return undefined;
    }
    return tr.pause;
  }
  if (!input.marketOpen || feedPlaying) return undefined;
  if (sport === 'tennis') {
    // nový set začal (perioda se zvýšila), gemy 0:0 a nic se neděje > X s
    const freshSet = tr.periodChangedAt !== undefined && (state.games?.[0] ?? 0) + (state.games?.[1] ?? 0) === 0;
    const idleSince = Math.max(tr.periodChangedAt ?? 0, tr.progressChangedAt ?? 0);
    if (freshSet && (state.period ?? 1) > 1 && now - idleSince >= fbMs && now - (tr.periodChangedAt ?? now) < 10 * 60_000) {
      tr.pause = { ...makePause(sport, state, competition, now, cfg, 'clock_fallback'), startedAt: tr.periodChangedAt ?? now };
    }
    return tr.pause;
  }
  if (tr.clockChangedAt === undefined) return undefined;
  const stoppedMs = now - tr.clockChangedAt;
  const scoreStable = (tr.scoreChangedAt ?? 0) <= tr.clockChangedAt;
  if (stoppedMs >= fbMs && scoreStable && atPeriodBoundary(sport, state, competition)) {
    tr.pause = { ...makePause(sport, state, competition, now, cfg, 'clock_fallback'), startedAt: tr.clockChangedAt };
  }
  return tr.pause;
}

export function pauseRemainingSec(p: PauseInfo, now: number): number {
  return Math.max(0, p.expectedSec - (now - p.startedAt) / 1000);
}
