import { z } from 'zod';
import { BOOKMAKERS, MODES, SPORTS } from './types.js';
import type { BookmakerId, Mode } from './types.js';
import { MODE_DEFAULTS, PAUSE_EXPECTED_SEC, PAUSE_FALLBACK_SEC } from '../../config/modes.js';
import { BOOKMAKER_INFO } from '../../config/bookmakers.js';

const modeSchema = z.object({
  pollMinMs: z.number().int().min(200).max(600_000),
  pollMaxMs: z.number().int().min(200).max(600_000),
  minMarginPct: z.number().min(0).max(50),
  maxLegAgeMs: z.number().int().min(500).max(3_600_000),
  preferPush: z.boolean(),
  /** Arb se ukáže až po tolika ms trvání (live: odfiltruje rozdíly v rychlosti reakce sázkovek). */
  confirmMs: z.number().int().min(0).max(60_000),
});

const bookmakerSchema = z.object({
  enabled: z.boolean(),
  /** Poplatek z vkladu v % (manipulační poplatek) – snižuje efektivní kurz. */
  feePct: z.number().min(0).max(20),
  acceptanceDelayMs: z.object({ prematch: z.number().int().min(0).max(120_000), live: z.number().int().min(0).max(120_000) }),
});

export const settingsSchema = z.object({
  modes: z.object({ PREMATCH: modeSchema, PAUSED: modeSchema, LIVE: modeSchema }),
  bankroll: z.number().min(10).max(100_000_000),
  /** Zaokrouhlení vkladů (Kč). */
  roundingUnit: z.number().int().min(1).max(1000),
  alerts: z.object({
    sound: z.boolean(),
    notifications: z.boolean(),
    /** Práh marže (%) pro zvuk a notifikaci. */
    minMarginPct: z.number().min(0).max(50),
    /** Ztlumit arby s nízkou pravděpodobností, že vydrží reakční dobu + zpoždění přijetí. */
    muteLowSurvival: z.boolean(),
    minSurvivalProb: z.number().min(0).max(1),
  }),
  /** Moje reakční doba (ms) – od zobrazení arbu po podání první sázky. */
  reactionTimeMs: z.number().int().min(0).max(300_000),
  /** Použít reakční dobu naměřenou z user_actions (pokud je dost dat). */
  useMeasuredReaction: z.boolean(),
  bookmakers: z.record(z.enum(BOOKMAKERS), bookmakerSchema),
  pause: z.object({
    expectedSec: z.object({
      football_ht: z.number().min(0),
      basketball_ht: z.number().min(0),
      basketball_quarter: z.number().min(0),
      hockey_intermission: z.number().min(0),
      tennis_set_break: z.number().min(0),
      handball_ht: z.number().min(0),
      volleyball_set_break: z.number().min(0),
      american_football_ht: z.number().min(0),
      american_football_quarter: z.number().min(0),
      other_break: z.number().min(0),
    }),
    fallbackSec: z.record(z.enum(SPORTS), z.number().min(5).max(600)),
  }),
  matching: z.object({
    /** Skóre ≥ autoAccept → automatické spárování. */
    autoAccept: z.number().min(0.5).max(1),
    /** Skóre ≥ review → fronta k ručnímu potvrzení. */
    review: z.number().min(0.3).max(1),
    startToleranceMin: z.number().min(0).max(180),
  }),
  /** Kurz, jehož implikovaná pravděpodobnost se liší od konsenzu o víc než X %, je podezřelý. */
  consensus: z.object({ maxDeviationPct: z.number().min(1).max(200), minBooks: z.number().int().min(2).max(8) }),
});

export type Settings = z.infer<typeof settingsSchema>;
export type ModeSettings = z.infer<typeof modeSchema>;

export function defaultSettings(): Settings {
  const modes = Object.fromEntries(MODES.map((m) => [m, { ...MODE_DEFAULTS[m] }])) as Record<Mode, ModeSettings>;
  const bookmakers = Object.fromEntries(
    BOOKMAKERS.map((b) => [b, { enabled: true, feePct: 0, acceptanceDelayMs: { ...BOOKMAKER_INFO[b].acceptanceDelayMs } }]),
  ) as Record<BookmakerId, z.infer<typeof bookmakerSchema>>;
  return {
    modes,
    bankroll: 10_000,
    roundingUnit: 1,
    alerts: { sound: true, notifications: true, minMarginPct: 1.0, muteLowSurvival: true, minSurvivalProb: 0.5 },
    reactionTimeMs: 8_000,
    useMeasuredReaction: true,
    bookmakers,
    pause: { expectedSec: { ...PAUSE_EXPECTED_SEC }, fallbackSec: { ...PAUSE_FALLBACK_SEC } },
    matching: { autoAccept: 0.86, review: 0.6, startToleranceMin: 15 },
    consensus: { maxDeviationPct: 35, minBooks: 3 },
  };
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
export type SettingsPatch = DeepPartial<Settings>;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isObj(base) || !isObj(patch)) return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

/** Uložené nastavení (může být neúplné/starší) → úplné a validní nastavení. */
export function resolveSettings(stored: unknown): Settings {
  const merged = deepMerge(defaultSettings(), stored ?? {});
  const parsed = settingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : defaultSettings();
}
