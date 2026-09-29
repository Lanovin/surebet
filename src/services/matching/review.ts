// Ruční potvrzení / zamítnutí nejistého páru (volá gateway). Potvrzení uloží odkaz i aliasy.
import { db } from '../../infra/db.js';

export interface UnmatchedRow {
  id: number;
  bookmaker: string;
  source_event_id: string;
  sport: string;
  competition: string | null;
  raw_home: string;
  raw_away: string;
  start_time: Date;
  candidate_event_id: number | null;
  candidate_label: string | null;
  candidate_start: Date | null;
  score: number | null;
  swapped: boolean;
  reasons: Record<string, unknown> | null;
  status: string;
  created_at: Date;
}

export async function listUnmatched(status = 'pending', limit = 200): Promise<UnmatchedRow[]> {
  const r = await db().query<UnmatchedRow>(
    `SELECT * FROM unmatched_events WHERE status = $1 ORDER BY start_time ASC LIMIT $2`,
    [status, limit],
  );
  return r.rows;
}

export async function confirmUnmatched(id: number, opts: { eventId?: number; swapped?: boolean } = {}): Promise<UnmatchedRow> {
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    const r = await client.query<UnmatchedRow>('SELECT * FROM unmatched_events WHERE id = $1 FOR UPDATE', [id]);
    const u = r.rows[0];
    if (!u) throw new Error('unmatched not found');
    const eventId = opts.eventId ?? u.candidate_event_id;
    if (!eventId) throw new Error('no candidate event');
    const swapped = opts.swapped ?? u.swapped;
    const ev = await client.query<{ home_id: number; away_id: number }>('SELECT home_id, away_id FROM events WHERE id = $1', [eventId]);
    if (!ev.rows[0]) throw new Error('candidate event no longer exists');
    const { home_id, away_id } = ev.rows[0];
    await client.query(
      `INSERT INTO event_links (bookmaker, source_event_id, event_id, swapped, confidence, method)
       VALUES ($1,$2,$3,$4,1,'manual') ON CONFLICT (bookmaker, source_event_id)
       DO UPDATE SET event_id = EXCLUDED.event_id, swapped = EXCLUDED.swapped, method = 'manual', confidence = 1`,
      [u.bookmaker, u.source_event_id, eventId, swapped],
    );
    const alias = `INSERT INTO participant_aliases (bookmaker, sport, raw_name, participant_id, source) VALUES ($1,$2,$3,$4,'manual')
      ON CONFLICT (bookmaker, sport, raw_name) DO UPDATE SET participant_id = EXCLUDED.participant_id, source = 'manual'`;
    await client.query(alias, [u.bookmaker, u.sport, u.raw_home, swapped ? away_id : home_id]);
    await client.query(alias, [u.bookmaker, u.sport, u.raw_away, swapped ? home_id : away_id]);
    await client.query(`UPDATE unmatched_events SET status = 'confirmed', resolved_at = now(), candidate_event_id = $2 WHERE id = $1`, [id, eventId]);
    await client.query('COMMIT');
    return { ...u, status: 'confirmed', candidate_event_id: eventId };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function rejectUnmatched(id: number): Promise<UnmatchedRow> {
  const r = await db().query<UnmatchedRow>(
    `UPDATE unmatched_events SET status = 'rejected', resolved_at = now() WHERE id = $1 RETURNING *`,
    [id],
  );
  if (!r.rows[0]) throw new Error('unmatched not found');
  return r.rows[0];
}

export async function expireUnmatched(): Promise<number> {
  const r = await db().query(
    `UPDATE unmatched_events SET status = 'expired', resolved_at = now() WHERE status = 'pending' AND start_time < now() - interval '4 hours'`,
  );
  return r.rowCount ?? 0;
}
