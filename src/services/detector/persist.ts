// Zápis arbů, jejich ticků a konců do Postgresu – sériová fronta (INSERT vždy před UPDATE).
import type { ActiveArb } from './engine.js';
import type { ArbDTO } from '../../shared/protocol.js';
import { isCensored } from '../../core/types.js';
import { db, insertMany } from '../../infra/db.js';
import { createLogger } from '../../infra/logger.js';

const log = createLogger('persist');
const TZ_PARTS = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Prague', hour: 'numeric', weekday: 'short', hour12: false });
const DOW: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

function pragueHourDow(ts: number): [number, number] {
  const parts = TZ_PARTS.formatToParts(new Date(ts));
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24;
  const d = DOW[parts.find((p) => p.type === 'weekday')?.value ?? 'Mon'] ?? 1;
  return [h, d];
}

export class ArbPersistence {
  private chain: Promise<unknown> = Promise.resolve();
  private ticks: unknown[][] = [];
  private timer?: NodeJS.Timeout;
  errors = 0;

  start(): void {
    this.timer = setInterval(() => this.enqueue(() => this.flushTicks()), 500);
  }

  private enqueue(fn: () => Promise<unknown>): void {
    this.chain = this.chain.then(fn).catch((e) => {
      this.errors++;
      log.error('write failed', { error: (e as Error).message });
    });
  }

  /** Arby, které zůstaly otevřené po pádu/restartu, jsou cenzurované. */
  async markRestart(): Promise<number> {
    const r = await db().query(
      `UPDATE arbs SET end_reason = 'system_restart', censored = true,
         duration_ms = GREATEST(0, (EXTRACT(EPOCH FROM (last_seen - first_seen)) * 1000)::int)
       WHERE end_reason IS NULL`,
    );
    return r.rowCount ?? 0;
  }

  newArb(arb: ActiveArb, dto: ArbDTO): void {
    const ev = arb.eventAtDetection;
    const st = ev.state;
    const [hour, dow] = pragueHourDow(arb.firstSeen);
    const pauseElapsed = ev.pause ? Math.round((arb.firstSeen - ev.pause.startedAt) / 1000) : null;
    const row = [
      arb.id,
      arb.mode,
      ev.sport,
      ev.competition,
      ev.id,
      dto.eventName,
      arb.market,
      dto.marketType,
      arb.market.split('|')[1],
      dto.line,
      JSON.stringify(dto.legs),
      arb.marginAtDetection,
      arb.maxMargin,
      arb.margin,
      new Date(arb.firstSeen),
      new Date(arb.lastSeen),
      st ? JSON.stringify(st) : null,
      st?.score ? `${st.score[0]}:${st.score[1]}` : null,
      st?.period ?? null,
      st?.clockSec !== undefined ? Math.floor(st.clockSec / 60) : null,
      ev.pause?.type ?? null,
      pauseElapsed,
      ev.pause?.expectedSec ?? null,
      arb.mode === 'PREMATCH' ? Math.round((ev.startTime - arb.firstSeen) / 1000) : null,
      arb.stakes.bankroll,
      JSON.stringify({ stakes: arb.stakes.stakes, total: arb.stakes.total, positive: arb.stakes.positive }),
      arb.stakes.minProfit,
      [...new Set(arb.legs.map((l) => l.bookmaker))].sort().join('|'),
      [...new Set(arb.legs.map((l) => l.bookmaker))].sort(),
      hour,
      dow,
      arb.prediction ? JSON.stringify(arb.prediction) : null,
      arb.isSim,
    ];
    this.enqueue(() =>
      insertMany(
        'arbs',
        [
          'id', 'mode', 'sport', 'competition', 'event_id', 'event_name', 'market_key', 'market_type', 'market_scope', 'line',
          'legs', 'margin_at_detection', 'max_margin', 'last_margin', 'first_seen', 'last_seen', 'game_state', 'score', 'period',
          'minute', 'pause_type', 'pause_elapsed_s', 'pause_expected_s', 'time_to_start_s', 'bankroll', 'stakes', 'expected_profit',
          'bookmaker_pair', 'bookmakers', 'hour_of_day', 'day_of_week', 'prediction', 'is_sim',
        ],
        [row],
        'ON CONFLICT (id) DO NOTHING',
      ),
    );
  }

  tick(arb: ActiveArb): void {
    this.ticks.push([new Date(), arb.id, arb.margin, JSON.stringify(arb.legs.map((l) => [l.bookmaker, l.selection, l.odds]))]);
  }

  endArb(arb: ActiveArb): void {
    const endedAt = arb.endedAt ?? Date.now();
    const reason = arb.endReason ?? 'system_restart';
    this.enqueue(async () => {
      await this.flushTicks();
      await db().query(
        `UPDATE arbs SET last_seen = $2, duration_ms = $3, end_reason = $4, end_bookmaker = $5, censored = $6,
           max_margin = $7, last_margin = $8 WHERE id = $1`,
        [arb.id, new Date(endedAt), Math.max(0, Math.round(endedAt - arb.firstSeen)), reason, arb.endBookmaker ?? null, isCensored(reason), arb.maxMargin, arb.margin],
      );
    });
  }

  /** Průběžné last_seen, aby cenzurovaná doba po pádu odpovídala realitě. */
  heartbeat(arbs: ActiveArb[]): void {
    if (!arbs.length) return;
    const ids = arbs.map((a) => a.id);
    const seen = arbs.map((a) => new Date(a.lastSeen));
    const maxm = arbs.map((a) => a.maxMargin);
    this.enqueue(() =>
      db().query(
        `UPDATE arbs a SET last_seen = x.seen, max_margin = x.maxm FROM unnest($1::uuid[], $2::timestamptz[], $3::float8[]) AS x(id, seen, maxm)
         WHERE a.id = x.id AND a.end_reason IS NULL`,
        [ids, seen, maxm],
      ),
    );
  }

  private async flushTicks(): Promise<void> {
    if (!this.ticks.length) return;
    const rows = this.ticks;
    this.ticks = [];
    await insertMany('arb_ticks', ['ts', 'arb_id', 'margin', 'odds'], rows);
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.enqueue(() => this.flushTicks());
    await this.chain;
  }
}
