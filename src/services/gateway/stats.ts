// Agregace pro stránku Statistiky.
import { db } from '../../infra/db.js';
import { isCensored } from '../../core/types.js';
import { downsampleCurve, kaplanMeier, summarize } from '../../core/survival.js';

export interface StatsQuery {
  sim: boolean;
  days: number;
}

const HIST_BINS = [0, 1, 2, 5, 10, 20, 30, 60, 120, 300, 600, 1800, Infinity];

export async function computeStats(q: StatsQuery) {
  const pool = db();
  const where = `is_sim = $1 AND first_seen > now() - ($2 || ' days')::interval`;
  const params = [q.sim, String(q.days)];

  const group = async (col: string) =>
    (
      await pool.query(
        `SELECT ${col} AS key, count(*)::int AS n, round(avg(margin_at_detection)::numeric, 3)::float AS avg_margin,
                round(max(max_margin)::numeric, 3)::float AS max_margin,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE end_reason IS NOT NULL) AS median_ms
         FROM arbs WHERE ${where} GROUP BY 1 ORDER BY n DESC LIMIT 40`,
        params,
      )
    ).rows;

  const [bySport, byMode, byMarket, byPair, byHour] = await Promise.all([
    group('sport'),
    group('mode'),
    group('market_type'),
    group('bookmaker_pair'),
    group('hour_of_day'),
  ]);

  const rows = (
    await pool.query<{ mode: string; sport: string; duration_ms: number; end_reason: string }>(
      `SELECT mode, sport, duration_ms, end_reason FROM arbs WHERE ${where} AND end_reason IS NOT NULL AND duration_ms IS NOT NULL LIMIT 200000`,
      params,
    )
  ).rows;

  // histogram životnosti (ukončené vs cenzurované)
  const hist = HIST_BINS.slice(0, -1).map((lo, i) => ({ lo, hi: HIST_BINS[i + 1], ended: 0, censored: 0 }));
  for (const r of rows) {
    const s = r.duration_ms / 1000;
    const b = hist.find((h) => s >= h.lo && s < h.hi);
    if (b) isCensored(r.end_reason) ? b.censored++ : b.ended++;
  }

  // Kaplan–Meier po režimech a sportech
  const km = (filter: (r: (typeof rows)[number]) => boolean) => {
    const obs = rows.filter(filter).map((r) => ({ durationMs: r.duration_ms, event: !isCensored(r.end_reason) }));
    if (obs.length < 3) return null;
    const c = kaplanMeier(obs);
    return { summary: summarize(c), curve: downsampleCurve(c, 150) };
  };
  const kmByMode = Object.fromEntries(['PREMATCH', 'PAUSED', 'LIVE'].map((m) => [m, km((r) => r.mode === m)]));
  const kmBySport = Object.fromEntries(['football', 'tennis', 'basketball', 'hockey'].map((s) => [s, km((r) => r.sport === s)]));

  const endReasons = (
    await pool.query(
      `SELECT split_part(end_reason, ':', 1) AS key, count(*)::int AS n FROM arbs WHERE ${where} AND end_reason IS NOT NULL GROUP BY 1 ORDER BY n DESC`,
      params,
    )
  ).rows;

  // skutečná úspěšnost a slippage z user_actions
  const actions = (
    await pool.query(
      `SELECT ua.action AS key, count(*)::int AS n, round(avg(ua.reaction_ms))::int AS avg_reaction_ms
       FROM user_actions ua JOIN arbs a ON a.id = ua.arb_id WHERE a.is_sim = $1 AND ua.ts > now() - ($2 || ' days')::interval
       GROUP BY 1`,
      params,
    )
  ).rows as { key: string; n: number; avg_reaction_ms: number }[];
  const total = actions.reduce((s, a) => s + a.n, 0);
  const placed = actions.find((a) => a.key === 'placed')?.n ?? 0;

  const slippage = (
    await pool.query(
      `SELECT ua.bookmaker, count(*)::int AS n,
              round(avg((ua.actual_odds - (leg->>'odds')::numeric) / (leg->>'odds')::numeric * 100), 3)::float AS avg_slippage_pct
       FROM user_actions ua JOIN arbs a ON a.id = ua.arb_id
       CROSS JOIN LATERAL jsonb_array_elements(a.legs) leg
       WHERE a.is_sim = $1 AND ua.actual_odds IS NOT NULL AND ua.bookmaker = leg->>'bookmaker'
         AND ua.ts > now() - ($2 || ' days')::interval
       GROUP BY 1 ORDER BY 2 DESC`,
      params,
    )
  ).rows;

  const rejections = (
    await pool.query(
      `SELECT ua.bookmaker AS key, count(*)::int AS n FROM user_actions ua JOIN arbs a ON a.id = ua.arb_id
       WHERE a.is_sim = $1 AND ua.action = 'rejected' AND ua.ts > now() - ($2 || ' days')::interval GROUP BY 1 ORDER BY n DESC`,
      params,
    )
  ).rows;

  // zisk v čase: vsazené arby × marže při kliknutí (očekávaný garantovaný zisk)
  const profit = (
    await pool.query(
      `SELECT to_char(date_trunc('day', ua.ts AT TIME ZONE 'Europe/Prague'), 'YYYY-MM-DD') AS day, count(*)::int AS n,
              round(sum(ua.stake)::numeric, 0)::float AS staked,
              round(sum(ua.stake * COALESCE(ua.margin_at_click, a.margin_at_detection) / (100 + COALESCE(ua.margin_at_click, a.margin_at_detection)))::numeric, 2)::float AS profit
       FROM user_actions ua JOIN arbs a ON a.id = ua.arb_id
       WHERE ua.action = 'placed' AND a.is_sim = $1 AND ua.stake IS NOT NULL AND ua.ts > now() - ($2 || ' days')::interval
       GROUP BY 1 ORDER BY 1`,
      params,
    )
  ).rows;
  let cum = 0;
  const profitSeries = profit.map((p: { day: string; n: number; staked: number; profit: number }) => ({
    day: String(p.day),
    n: p.n,
    staked: p.staked,
    profit: p.profit,
    cumulative: Math.round((cum += p.profit) * 100) / 100,
  }));

  const totals = (
    await pool.query(
      `SELECT count(*)::int AS arbs, count(*) FILTER (WHERE end_reason IS NULL)::int AS active,
              count(*) FILTER (WHERE censored)::int AS censored, round(avg(margin_at_detection)::numeric, 3)::float AS avg_margin
       FROM arbs WHERE ${where}`,
      params,
    )
  ).rows[0];

  return {
    totals,
    bySport,
    byMode,
    byMarket,
    byPair,
    byHour,
    endReasons,
    histogram: hist.map((h) => ({ ...h, hi: Number.isFinite(h.hi) ? h.hi : null })),
    kmByMode,
    kmBySport,
    actions: { total, placed, successRate: total ? placed / total : null, byAction: actions, slippage, rejections },
    profit: profitSeries,
  };
}
