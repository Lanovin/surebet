// Predikce životnosti arbu: fáze 1 = empirické Kaplan–Meier segmenty, fáze 2 = exportovaný Cox model.
import type { BookmakerId, Mode } from '../../core/types.js';
import { isCensored } from '../../core/types.js';
import { marginBand } from '../../core/arb.js';
import type { Settings } from '../../core/settings.js';
import { buildSegmentModel, predict, survivalProb, type SegmentFeatures, type SegmentModel } from '../../core/survival.js';
import { coxPredict, type CoxPayload } from '../../core/cox.js';
import type { PredictionDTO } from '../../shared/protocol.js';
import { db } from '../../infra/db.js';
import { createLogger } from '../../infra/logger.js';

const log = createLogger('predictor');
export const MIN_SEGMENT_SAMPLES = 30;

export class Predictor {
  private models: Record<'sim' | 'real', SegmentModel | null> = { sim: null, real: null };
  private cox: Record<'sim' | 'real', CoxPayload | null> = { sim: null, real: null };
  private measuredReactionMs: number | null = null;
  private measuredAcceptance = new Map<string, number>();

  constructor(private settings: () => Settings) {}

  async refresh(): Promise<void> {
    for (const kind of ['sim', 'real'] as const) {
      const r = await db().query<{ mode: string; sport: string; market_type: string; bookmaker_pair: string; margin_at_detection: number; duration_ms: number; end_reason: string }>(
        `SELECT mode, sport, market_type, bookmaker_pair, margin_at_detection, duration_ms, end_reason
         FROM arbs WHERE end_reason IS NOT NULL AND duration_ms IS NOT NULL AND is_sim = $1
           AND first_seen > now() - interval '90 days'
         ORDER BY first_seen DESC LIMIT 200000`,
        [kind === 'sim'],
      );
      this.models[kind] = r.rows.length
        ? buildSegmentModel(
            r.rows.map((x) => ({
              mode: x.mode,
              sport: x.sport,
              marketType: x.market_type,
              pair: x.bookmaker_pair,
              marginBand: marginBand(x.margin_at_detection),
              durationMs: x.duration_ms,
              event: !isCensored(x.end_reason),
            })),
            MIN_SEGMENT_SAMPLES,
          )
        : null;
      const m = await db().query<{ payload: CoxPayload }>(
        `SELECT payload FROM survival_models WHERE active AND kind = $1 ORDER BY created_at DESC LIMIT 1`,
        [kind === 'sim' ? 'cox_sim' : 'cox'],
      );
      this.cox[kind] = m.rows[0]?.payload ?? null;
    }
    // naměřená reakční doba (od detekce po kliknutí "Vsadil") a zpoždění přijetí sázky
    const ra = await db().query<{ med: number | null; n: number }>(
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY reaction_ms) AS med, count(*)::int AS n
       FROM (SELECT reaction_ms FROM user_actions WHERE action = 'placed' AND reaction_ms IS NOT NULL ORDER BY ts DESC LIMIT 200) x`,
    );
    this.measuredReactionMs = ra.rows[0] && ra.rows[0].n >= 5 ? ra.rows[0].med : null;
    const acc = await db().query<{ bookmaker: string; live: boolean; med: number; n: number }>(
      `SELECT bookmaker, (details->>'live')::boolean AS live,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY (details->>'acceptanceMs')::numeric) AS med, count(*)::int AS n
       FROM user_actions WHERE action = 'placed' AND details ? 'acceptanceMs' AND bookmaker IS NOT NULL
       GROUP BY 1, 2`,
    );
    this.measuredAcceptance.clear();
    for (const a of acc.rows) if (a.n >= 3) this.measuredAcceptance.set(`${a.bookmaker}|${a.live ? 'live' : 'prematch'}`, a.med);
    log.debug('refreshed', { sim: this.models.sim?.segments.size ?? 0, real: this.models.real?.segments.size ?? 0 });
  }

  reactionMs(): number {
    const s = this.settings();
    return s.useMeasuredReaction && this.measuredReactionMs !== null ? this.measuredReactionMs : s.reactionTimeMs;
  }

  acceptanceMs(bk: BookmakerId, mode: Mode): number {
    const scope = mode === 'PREMATCH' ? 'prematch' : 'live';
    return this.measuredAcceptance.get(`${bk}|${scope}`) ?? this.settings().bookmakers[bk].acceptanceDelayMs[scope];
  }

  info(): { reactionMs: number; measuredReactionMs: number | null; acceptance: Record<string, number> } {
    return { reactionMs: this.reactionMs(), measuredReactionMs: this.measuredReactionMs, acceptance: Object.fromEntries(this.measuredAcceptance) };
  }

  predict(f: SegmentFeatures, arb: { mode: Mode; bookmakers: BookmakerId[]; isSim: boolean; marginPct: number }): PredictionDTO | null {
    const kind = arb.isSim ? 'sim' : 'real';
    const neededMs = this.reactionMs() + Math.max(0, ...arb.bookmakers.map((b) => this.acceptanceMs(b, arb.mode)));
    const cox = this.cox[kind];
    if (cox) {
      const p = coxPredict(cox, { ...f, margin: arb.marginPct }, neededMs);
      if (p) return { ...p, neededMs, source: 'model' };
    }
    const model = this.models[kind];
    if (!model) return null;
    const p = predict(model, f);
    if (!p) return null;
    return {
      medianMs: p.medianMs,
      p25Ms: p.p25Ms,
      p75Ms: p.p75Ms,
      pOver: p.pOver,
      n: p.n,
      nEvents: p.nEvents,
      segment: p.segment,
      level: p.level,
      neededMs,
      pNeeded: survivalProb(model, f, neededMs),
      source: 'km',
    };
  }

  model(kind: 'sim' | 'real'): SegmentModel | null {
    return this.models[kind];
  }
}
