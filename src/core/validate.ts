import { z } from 'zod';
import { BOOKMAKERS, SELECTION_KEYS, SPORTS } from './types.js';
import type { RawEvent, RawOdds } from './types.js';
import { isValidMarketKey, parseMarketKey, REQUIRED_SELECTIONS } from './markets.js';

export const ODDS_MIN = 1.01;
export const ODDS_MAX = 1000;

const gameStateSchema = z
  .object({
    statusText: z.string().optional(),
    period: z.number().int().min(0).max(20).optional(),
    breakFlag: z.boolean().optional(),
    clockSec: z.number().min(0).max(4 * 3600).optional(),
    periodRemainingSec: z.number().min(0).max(3600).optional(),
    clockRunning: z.boolean().optional(),
    score: z.tuple([z.number().int().min(0), z.number().int().min(0)]).optional(),
    periodScores: z.array(z.tuple([z.number().int().min(0), z.number().int().min(0)])).optional(),
    games: z.tuple([z.number().int().min(0), z.number().int().min(0)]).optional(),
    points: z.string().optional(),
    finished: z.boolean().optional(),
  })
  .strict();

const selectionSchema = z.object({
  key: z.enum(SELECTION_KEYS),
  odds: z.number().finite(),
  open: z.boolean().optional(),
  rawName: z.string().optional(),
});

const marketSchema = z.object({
  key: z.string().refine(isValidMarketKey, { message: 'invalid canonical market key' }),
  open: z.boolean(),
  selections: z.array(selectionSchema).min(1),
  sourceId: z.string().optional(),
  rawName: z.string().optional(),
});

const eventSchema = z.object({
  sourceId: z.string().min(1),
  sport: z.enum(SPORTS),
  competition: z.string(),
  country: z.string().optional(),
  home: z.string().min(1),
  away: z.string().min(1),
  startTime: z.number().int().positive(),
  live: z.boolean(),
  state: gameStateSchema.optional(),
  markets: z.array(marketSchema),
  url: z.string().optional(),
});

export const rawOddsSchema = z.object({
  bookmaker: z.enum(BOOKMAKERS),
  strategy: z.string(),
  scope: z.enum(['prematch', 'live']),
  fetchedAt: z.number().int().positive(),
  events: z.array(eventSchema),
});

export interface ValidationLimits {
  minEvents: number;
  maxAgeMs: number;
  /** Max podíl zahozených kurzů, než se celá odpověď prohlásí za rozbitou. */
  maxDroppedRatio?: number;
  now?: number;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  /** Vyčištěná data (zahozené neplatné kurzy/trhy). */
  data?: RawOdds;
  stats: { events: number; markets: number; odds: number; droppedOdds: number; droppedMarkets: number };
}

/** Strukturální (zod) + sanity validace odpovědi strategie. */
export function validateRawOdds(input: unknown, limits: ValidationLimits): ValidationResult {
  const stats = { events: 0, markets: 0, odds: 0, droppedOdds: 0, droppedMarkets: 0 };
  const errors: string[] = [];
  const warnings: string[] = [];
  const parsed = rawOddsSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`);
    return { ok: false, errors: [`schema: ${issues.join('; ')}`], warnings, stats };
  }
  const raw = parsed.data as RawOdds;
  const now = limits.now ?? Date.now();
  const age = now - raw.fetchedAt;
  if (age > limits.maxAgeMs) errors.push(`data too old: ${Math.round(age / 1000)}s > ${Math.round(limits.maxAgeMs / 1000)}s`);
  if (raw.fetchedAt > now + 5000) errors.push('fetchedAt is in the future');

  const seen = new Set<string>();
  const events: RawEvent[] = [];
  for (const ev of raw.events) {
    if (seen.has(ev.sourceId)) {
      warnings.push(`duplicate event ${ev.sourceId}`);
      continue;
    }
    seen.add(ev.sourceId);
    const markets = [];
    const seenMarkets = new Set<string>();
    for (const m of ev.markets) {
      if (seenMarkets.has(m.key)) {
        stats.droppedMarkets++;
        continue;
      }
      seenMarkets.add(m.key);
      const { type, line } = parseMarketKey(m.key);
      // čtvrtinové linie (±0.25, 2.75 …) jsou dělené sázky (půl vkladu na každou sousední linii) –
      // arb se počítá jako dvoucestný trh s plnou výhrou/prohrou, takže je nepodporujeme
      if (line !== undefined && Math.abs(line * 2 - Math.round(line * 2)) > 1e-9) {
        stats.droppedMarkets++;
        continue;
      }
      const allowed = new Set(REQUIRED_SELECTIONS[type]);
      const sels = [];
      const seenSel = new Set<string>();
      for (const s of m.selections) {
        stats.odds++;
        if (!allowed.has(s.key) || seenSel.has(s.key) || !(s.odds >= ODDS_MIN && s.odds <= ODDS_MAX)) {
          stats.droppedOdds++;
          continue;
        }
        seenSel.add(s.key);
        sels.push(s);
      }
      if (!sels.length) {
        stats.droppedMarkets++;
        continue;
      }
      markets.push({ ...m, selections: sels });
    }
    stats.markets += markets.length;
    events.push({ ...ev, markets });
  }
  stats.events = events.length;
  if (events.length < limits.minEvents) errors.push(`too few events: ${events.length} < ${limits.minEvents}`);
  const ratio = stats.odds ? stats.droppedOdds / stats.odds : 0;
  if (ratio > (limits.maxDroppedRatio ?? 0.2)) errors.push(`too many invalid odds: ${(ratio * 100).toFixed(0)} %`);
  else if (stats.droppedOdds) warnings.push(`dropped ${stats.droppedOdds} invalid odds`);
  return { ok: errors.length === 0, errors, warnings, data: { ...raw, events }, stats };
}
