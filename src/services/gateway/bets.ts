// Přehled sázek (/api/bets): vsazené arby z user_actions s nohami (kde, na co, kolik, kurz),
// očekávaným jistým ziskem a skutečným výsledkem po vyhodnocení.
import { z } from 'zod';
import { BOOKMAKERS } from '../../core/types.js';
import { db } from '../../infra/db.js';

export const betLegSchema = z.object({
  bookmaker: z.enum(BOOKMAKERS),
  /** co se vsadilo, např. „Více než 2.5 gólů“ */
  title: z.string().max(200).optional(),
  stake: z.number().min(0).optional(),
  actualOdds: z.number().min(1).optional(),
});
export type BetLeg = z.infer<typeof betLegSchema>;

export const settleSchema = z.union([
  z.object({ result: z.literal('won'), winningLeg: z.number().int().min(0) }),
  z.object({ result: z.literal('void') }),
  z.object({ result: z.literal('manual'), profit: z.number() }),
  z.object({ result: z.null() }),
]);

export interface BetDTO {
  id: number;
  ts: number;
  arbId: string | null;
  eventName: string;
  marketKey: string | null;
  sport: string | null;
  mode: string | null;
  isSim: boolean;
  stake: number;
  margin: number | null;
  legs: BetLeg[];
  /** jistý zisk podle vkladů a kurzů nohou (min. přes výsledky); bez nohou z marže */
  expectedProfit: number | null;
  result: 'won' | 'void' | 'manual' | null;
  winningLeg: number | null;
  profit: number | null;
  settledAt: number | null;
  note: string | null;
}

interface Row {
  id: string;
  ts: Date;
  arb_id: string | null;
  stake: string | null;
  margin_at_click: number | null;
  note: string | null;
  details: { legs?: BetLeg[]; eventName?: string; marketKey?: string; sport?: string } | null;
  result: BetDTO['result'];
  winning_leg: number | null;
  profit: string | null;
  settled_at: Date | null;
  event_name: string | null;
  market_key: string | null;
  sport: string | null;
  mode: string | null;
  is_sim: boolean | null;
}

/** Zisk, když vyhraje noha i: její výplata minus celkový vklad. */
export function legProfit(legs: BetLeg[], i: number, total: number): number | null {
  const l = legs[i];
  if (!l || l.stake === undefined || l.actualOdds === undefined) return null;
  return Math.round((l.stake * l.actualOdds - total) * 100) / 100;
}

function toDTO(r: Row): BetDTO {
  const legs = r.details?.legs ?? [];
  const stake = r.stake !== null ? Number(r.stake) : legs.reduce((s, l) => s + (l.stake ?? 0), 0);
  const per = legs.map((_, i) => legProfit(legs, i, stake));
  const margin = r.margin_at_click;
  const expected = legs.length >= 2 && per.every((p) => p !== null) ? Math.min(...(per as number[])) : margin !== null && stake ? Math.round(((stake * margin) / (100 + margin)) * 100) / 100 : null;
  return {
    id: Number(r.id),
    ts: r.ts.getTime(),
    arbId: r.arb_id,
    eventName: r.event_name ?? r.details?.eventName ?? 'Ruční sázka',
    marketKey: r.market_key ?? r.details?.marketKey ?? null,
    sport: r.sport ?? r.details?.sport ?? null,
    mode: r.mode,
    isSim: r.is_sim ?? false,
    stake,
    margin,
    legs,
    expectedProfit: expected,
    result: r.result,
    winningLeg: r.winning_leg,
    profit: r.profit !== null ? Number(r.profit) : null,
    settledAt: r.settled_at ? r.settled_at.getTime() : null,
    note: r.note,
  };
}

const SELECT = `SELECT ua.id, ua.ts, ua.arb_id, ua.stake, ua.margin_at_click, ua.note, ua.details, ua.result, ua.winning_leg, ua.profit, ua.settled_at,
                       a.event_name, a.market_key, a.sport, a.mode, a.is_sim
                FROM user_actions ua LEFT JOIN arbs a ON a.id = ua.arb_id`;

export async function listBets(days: number): Promise<BetDTO[]> {
  const r = await db().query<Row>(`${SELECT} WHERE ua.action = 'placed' AND ua.ts > now() - ($1 || ' days')::interval ORDER BY ua.ts DESC LIMIT 2000`, [String(days)]);
  return r.rows.map(toDTO);
}

export async function getBet(id: number): Promise<BetDTO | null> {
  const r = await db().query<Row>(`${SELECT} WHERE ua.id = $1 AND ua.action = 'placed'`, [id]);
  return r.rows[0] ? toDTO(r.rows[0]) : null;
}

/** Vyhodnotí sázku: vyhrála noha i (zisk z jejího vkladu × kurz), vráceno (0), nebo ručně zadaný zisk. */
export async function settleBet(id: number, body: unknown): Promise<BetDTO | null> {
  const s = settleSchema.parse(body);
  const bet = await getBet(id);
  if (!bet) return null;
  let profit: number | null = null;
  let leg: number | null = null;
  if (s.result === 'won') {
    leg = s.winningLeg;
    profit = legProfit(bet.legs, leg, bet.stake);
    if (profit === null) throw new Error('noha nemá vklad a kurz – zadej zisk ručně');
  } else if (s.result === 'void') profit = 0;
  else if (s.result === 'manual') profit = s.profit;
  await db().query(`UPDATE user_actions SET result = $2, winning_leg = $3, profit = $4, settled_at = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END WHERE id = $1`, [
    id,
    s.result,
    leg,
    profit,
  ]);
  return getBet(id);
}

export async function deleteBet(id: number): Promise<boolean> {
  const r = await db().query(`DELETE FROM user_actions WHERE id = $1 AND action = 'placed'`, [id]);
  return (r.rowCount ?? 0) > 0;
}
