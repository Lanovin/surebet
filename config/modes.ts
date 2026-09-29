// Výchozí konfigurace tří režimů. Za běhu se dá přepsat z dashboardu (Nastavení) – hodnoty se
// ukládají do tabulky `settings` a služby je načtou bez restartu (Redis kanál settings:changed).
import type { Mode, PauseType, Sport } from '../src/core/types.js';

export interface ModeConfig {
  /** Interval sběru – náhodně v rozsahu [pollMinMs, pollMaxMs] (jitter proti rate limitům). */
  pollMinMs: number;
  pollMaxMs: number;
  /** Minimální marže arbu v procentech. */
  minMarginPct: number;
  /** Max stáří nohy (od posledního potvrzení kurzu) – starší nohy se do arbu nepočítají. */
  maxLegAgeMs: number;
  /** Preferovat websocket (push) strategie, pokud je adaptér má. */
  preferPush: boolean;
}

export const MODE_DEFAULTS: Record<Mode, ModeConfig> = {
  PREMATCH: { pollMinMs: 30_000, pollMaxMs: 60_000, minMarginPct: 0.5, maxLegAgeMs: 300_000, preferPush: false },
  PAUSED: { pollMinMs: 3_000, pollMaxMs: 5_000, minMarginPct: 1.0, maxLegAgeMs: 15_000, preferPush: false },
  LIVE: { pollMinMs: 700, pollMaxMs: 1_000, minMarginPct: 1.5, maxLegAgeMs: 5_000, preferPush: true },
};

/** Očekávaná délka přestávek (s). */
export const PAUSE_EXPECTED_SEC: Record<PauseType, number> = {
  football_ht: 15 * 60,
  basketball_ht: 15 * 60,
  hockey_intermission: 17 * 60,
  tennis_set_break: 120,
  basketball_quarter: 120,
};

/**
 * Fallback detekce PAUSED: herní čas stojí déle než X s, trh je otevřený a skóre se nemění.
 * U hokeje a basketu se navíc vyžaduje, aby hodiny stály na konci periody (jinak by každá
 * přerušená hra vypadala jako přestávka). Tenis nemá hodiny – bere se konec setu.
 */
export const PAUSE_FALLBACK_SEC: Record<Sport, number> = {
  football: 45,
  hockey: 45,
  basketball: 45,
  tennis: 30,
};

/** Délky period (s) pro určení „konce periody“ ve fallbacku. */
export const PERIOD_LENGTH_SEC: Record<Sport, number | null> = {
  football: 45 * 60,
  hockey: 20 * 60,
  basketball: 10 * 60, // FIBA; NBA 12 min – rozpoznává se podle soutěže
  tennis: null,
};

export const MODE_COLORS: Record<Mode, string> = {
  PREMATCH: 'sky',
  PAUSED: 'amber',
  LIVE: 'rose',
};
