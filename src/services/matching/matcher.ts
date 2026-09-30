// Párování událostí sázkovek na kanonické události: odkazy -> aliasy -> fuzzy shoda + čas ±15 min.
// Nejisté páry jdou do fronty unmatched_events (ruční potvrzení v dashboardu), do arbů se nepoužijí.
import type { BookmakerId, RawEvent, Sport } from '../../core/types.js';
import { nameSimilarity, participantKey } from '../../core/names.js';
import type { Settings } from '../../core/settings.js';
import { db } from '../../infra/db.js';
import { createLogger } from '../../infra/logger.js';

const log = createLogger('matcher');

export interface CanonEvent {
  id: number;
  sport: Sport;
  competition: string;
  homeId: number;
  awayId: number;
  home: string;
  away: string;
  startTime: number;
  isSim: boolean;
  linkedBooks: Set<BookmakerId>;
}

interface Participant {
  id: number;
  sport: Sport;
  name: string;
  names: Set<string>;
}

export type MatchResult =
  | { status: 'linked'; eventId: number; swapped: boolean; method: 'link' | 'alias' | 'auto' | 'created' | 'manual' }
  | { status: 'pending' };

export interface Candidate {
  event: CanonEvent;
  score: number;
  swapped: boolean;
  home: number;
  away: number;
}

const linkKey = (bk: string, sourceId: string) => `${bk}|${sourceId}`;
/** Mimo toleranci času začátku se páruje jen při téměř jisté shodě obou jmen. */
const WIDE_MIN_NAME = 0.95;
const aliasKey = (bk: string, sport: string, raw: string) => `${bk}|${sport}|${raw}`;

export class Matcher {
  private links = new Map<string, { eventId: number; swapped: boolean }>();
  private pending = new Set<string>();
  private rejected = new Map<string, Set<number>>();
  private events = new Map<number, CanonEvent>();
  private aliases = new Map<string, number>();
  private participants = new Map<number, Participant>();
  private participantsByKey = new Map<string, number>();
  /** odkazy na události, které už neznáme (starší), aby se zbytečně nevytvářely znovu */
  stats = { linked: 0, created: 0, pending: 0, auto: 0 };

  constructor(private settings: () => Settings) {}

  async load(): Promise<void> {
    const pool = db();
    const parts = await pool.query<{ id: number; sport: Sport; name: string }>('SELECT id, sport, name FROM participants');
    for (const p of parts.rows) this.addParticipant(p.id, p.sport, p.name);
    const al = await pool.query<{ bookmaker: string; sport: string; raw_name: string; participant_id: number }>(
      'SELECT bookmaker, sport, raw_name, participant_id FROM participant_aliases',
    );
    for (const a of al.rows) {
      this.aliases.set(aliasKey(a.bookmaker, a.sport, a.raw_name), a.participant_id);
      this.participants.get(a.participant_id)?.names.add(a.raw_name);
    }
    const ev = await pool.query<{
      id: number;
      sport: Sport;
      competition: string | null;
      home_id: number;
      away_id: number;
      start_time: Date;
      is_sim: boolean;
    }>(
      `SELECT e.id, e.sport, c.name AS competition, e.home_id, e.away_id, e.start_time, e.is_sim
       FROM events e LEFT JOIN competitions c ON c.id = e.competition_id
       WHERE e.start_time > now() - interval '8 hours'`,
    );
    for (const e of ev.rows) {
      this.events.set(e.id, {
        id: e.id,
        sport: e.sport,
        competition: e.competition ?? '',
        homeId: e.home_id,
        awayId: e.away_id,
        home: this.participants.get(e.home_id)?.name ?? '?',
        away: this.participants.get(e.away_id)?.name ?? '?',
        startTime: e.start_time.getTime(),
        isSim: e.is_sim,
        linkedBooks: new Set(),
      });
    }
    const lk = await pool.query<{ bookmaker: BookmakerId; source_event_id: string; event_id: number; swapped: boolean }>(
      `SELECT l.bookmaker, l.source_event_id, l.event_id, l.swapped FROM event_links l
       JOIN events e ON e.id = l.event_id WHERE e.start_time > now() - interval '8 hours'`,
    );
    for (const l of lk.rows) {
      this.links.set(linkKey(l.bookmaker, l.source_event_id), { eventId: l.event_id, swapped: l.swapped });
      this.events.get(l.event_id)?.linkedBooks.add(l.bookmaker);
    }
    const un = await pool.query<{ bookmaker: string; source_event_id: string; status: string; candidate_event_id: number | null }>(
      `SELECT bookmaker, source_event_id, status, candidate_event_id FROM unmatched_events
       WHERE status IN ('pending','rejected') AND start_time > now() - interval '8 hours'`,
    );
    for (const u of un.rows) {
      const k = linkKey(u.bookmaker, u.source_event_id);
      if (this.links.has(k)) continue;
      if (u.status === 'pending') this.pending.add(k);
      else if (u.candidate_event_id) this.rejectCandidate(k, u.candidate_event_id);
    }
    log.info('loaded', { participants: this.participants.size, aliases: this.aliases.size, events: this.events.size, links: this.links.size, pending: this.pending.size });
  }

  private addParticipant(id: number, sport: Sport, name: string): Participant {
    const p: Participant = { id, sport, name, names: new Set([name]) };
    this.participants.set(id, p);
    this.participantsByKey.set(`${sport}|${participantKey(name, sport)}`, id);
    return p;
  }

  private rejectCandidate(key: string, eventId: number): void {
    let s = this.rejected.get(key);
    if (!s) this.rejected.set(key, (s = new Set()));
    s.add(eventId);
  }

  getEvent(id: number): CanonEvent | undefined {
    return this.events.get(id);
  }

  /** Synchronní dotaz jen do cache (pro konsenzus kontrolu). */
  peekLink(bk: BookmakerId, sourceId: string): { eventId: number; swapped: boolean } | undefined {
    return this.links.get(linkKey(bk, sourceId));
  }

  pendingCount(): number {
    return this.pending.size;
  }

  private chain: Promise<unknown> = Promise.resolve();

  /** Rychlá cesta ze cache; pomalá (DB) se serializuje, aby dvě sázkovky nevytvořily stejnou událost dvakrát. */
  /** Odkazy ověřené v tomto běhu (sport, čas a jména sedí). */
  private verified = new Set<string>();
  /** Čekající páry z minulého běhu se jednou přehodnotí (pravidla párování se mohla zlepšit). */
  private pendingRechecked = new Set<string>();

  /**
   * Uložený odkaz může zastarat – sázkovka recykluje ID nebo se změnil rozpis. Ověří se sport,
   * čas začátku a (jednou za běh) podobnost jmen; nesedící odkaz se zahodí a párování proběhne znovu.
   */
  private linkValid(key: string, link: { eventId: number; swapped: boolean }, ev: RawEvent): boolean {
    const e = this.events.get(link.eventId);
    if (!e || e.sport !== ev.sport || Math.abs(e.startTime - ev.startTime) > 6 * 3600e3) return false;
    if (this.verified.has(key)) return true;
    const c = this.candidates(ev, [e])[0];
    const ok = !!c && c.score >= this.settings().matching.review - 0.1 && c.swapped === link.swapped;
    if (ok) this.verified.add(key);
    return ok;
  }

  private dropLink(bk: BookmakerId, key: string, sourceId: string, eventId: number): void {
    log.warn('stale link dropped', { bk, sourceId, eventId });
    this.links.delete(key);
    this.verified.delete(key);
    this.events.get(eventId)?.linkedBooks.delete(bk);
    void db().query('DELETE FROM event_links WHERE bookmaker = $1 AND source_event_id = $2', [bk, sourceId]).catch(() => {});
  }

  async resolve(bk: BookmakerId, ev: RawEvent, isSim: boolean): Promise<MatchResult> {
    const key = linkKey(bk, ev.sourceId);
    const link = this.links.get(key);
    if (link) {
      if (this.linkValid(key, link, ev)) return { status: 'linked', ...link, method: 'link' };
      this.dropLink(bk, key, ev.sourceId, link.eventId);
    }
    if (this.pending.has(key) && this.pendingRechecked.has(key)) return { status: 'pending' };
    const run = this.chain.catch(() => {}).then(() => this.resolveSlow(bk, ev, isSim));
    this.chain = run;
    return run;
  }

  private async resolveSlow(bk: BookmakerId, ev: RawEvent, isSim: boolean): Promise<MatchResult> {
    const key = linkKey(bk, ev.sourceId);
    const link = this.links.get(key);
    if (link) return { status: 'linked', ...link, method: 'link' };
    if (this.pending.has(key)) {
      if (this.pendingRechecked.has(key)) return { status: 'pending' };
      this.pendingRechecked.add(key);
      this.pending.delete(key); // přehodnotit; když to zase nevyjde, enqueue ho vrátí do fronty
    }

    const cfg = this.settings().matching;
    const tol = cfg.startToleranceMin * 60_000;
    const rejected = this.rejected.get(key);
    const pool = [...this.events.values()].filter(
      (e) =>
        e.sport === ev.sport &&
        e.isSim === isSim &&
        !e.linkedBooks.has(bk) &&
        Math.abs(e.startTime - ev.startTime) <= tol &&
        !rejected?.has(e.id),
    );

    // 1) aliasy obou účastníků -> přesná shoda
    const ah = this.aliases.get(aliasKey(bk, ev.sport, ev.home));
    const aa = this.aliases.get(aliasKey(bk, ev.sport, ev.away));
    if (ah && aa) {
      const hit = pool.find((e) => (e.homeId === ah && e.awayId === aa) || (e.homeId === aa && e.awayId === ah));
      if (hit) return this.link(bk, ev, hit, hit.homeId !== ah, 1, 'alias');
    }

    // 2) fuzzy shoda
    const cands = this.candidates(ev, pool);
    const best = cands[0];
    const second = cands[1];
    if (best) {
      const clear = !second || second.score < best.score - 0.05;
      const swapOk = !best.swapped || ev.sport === 'tennis' || best.score >= 0.95;
      if (best.score >= cfg.autoAccept && clear && swapOk) {
        this.stats.auto++;
        return this.link(bk, ev, best.event, best.swapped, best.score, 'auto');
      }
    }

    // 2b) stejná jména, ale jiný čas začátku (tenis: odhad podle pořadí zápasů vs. „ne dříve než“,
    //     posun o hodinu u části sázkovek) → jistá shoda obou jmen v širším okně
    if (!best || best.score < cfg.autoAccept) {
      const wide = (ev.sport === 'tennis' ? 6 : 3) * 3600_000;
      const widePool = [...this.events.values()].filter(
        (e) => e.sport === ev.sport && e.isSim === isSim && !e.linkedBooks.has(bk) && Math.abs(e.startTime - ev.startTime) <= wide && !rejected?.has(e.id),
      );
      const wc = this.candidates(ev, widePool).filter((c) => Math.min(c.home, c.away) >= WIDE_MIN_NAME);
      const w = wc[0];
      if (w && (!wc[1] || wc[1].score < w.score - 0.05) && (!w.swapped || ev.sport === 'tennis')) {
        this.stats.auto++;
        return this.link(bk, ev, w.event, w.swapped, w.score, 'auto');
      }
    }

    if (best && best.score >= cfg.review) {
      await this.enqueue(bk, ev, best);
      return { status: 'pending' };
    }

    // 3) nová kanonická událost
    const created = await this.createEvent(bk, ev, isSim);
    return this.link(bk, ev, created, false, 1, 'created');
  }

  candidates(ev: Pick<RawEvent, 'sport' | 'home' | 'away'> & Partial<Pick<RawEvent, 'startTime'>>, pool: CanonEvent[]): Candidate[] {
    const out: Candidate[] = [];
    for (const e of pool) {
      const H = this.participants.get(e.homeId);
      const A = this.participants.get(e.awayId);
      if (!H || !A) continue;
      const hs = this.bestName(ev.home, H, ev.sport);
      const as = this.bestName(ev.away, A, ev.sport);
      const hsw = this.bestName(ev.home, A, ev.sport);
      const asw = this.bestName(ev.away, H, ev.sport);
      let straight = combine(hs, as);
      let swapped = combine(hsw, asw);
      // jeden tým sedí jistě a čas výkopu téměř přesně -> nejspíš stejný zápas s neznámým aliasem druhého týmu;
      // není to jisté, takže skóre jen do pásma ruční kontroly (fronta unmatched), nikdy auto
      const closeInTime = 'startTime' in ev && Math.abs((ev as RawEvent).startTime - e.startTime) <= 5 * 60_000;
      if (closeInTime) {
        const review = this.settings().matching.review;
        if (Math.max(hs, as) >= 0.9) straight = Math.max(straight, review + 0.02);
        if (Math.max(hsw, asw) >= 0.9 && ev.sport === 'tennis') swapped = Math.max(swapped, review + 0.01);
      }
      const c: Candidate =
        swapped > straight + 0.05 ? { event: e, score: swapped, swapped: true, home: hsw, away: asw } : { event: e, score: straight, swapped: false, home: hs, away: as };
      if (c.score > 0.3) out.push(c);
    }
    return out.sort((a, b) => b.score - a.score);
  }

  private bestName(raw: string, p: Participant, sport: Sport): number {
    let best = 0;
    for (const n of p.names) {
      best = Math.max(best, nameSimilarity(raw, n, sport));
      if (best === 1) break;
    }
    return best;
  }

  private async link(
    bk: BookmakerId,
    ev: RawEvent,
    target: CanonEvent,
    swapped: boolean,
    confidence: number,
    method: 'alias' | 'auto' | 'created' | 'manual',
  ): Promise<MatchResult> {
    const key = linkKey(bk, ev.sourceId);
    await db().query(
      `INSERT INTO event_links (bookmaker, source_event_id, event_id, swapped, confidence, method)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (bookmaker, source_event_id) DO UPDATE
       SET event_id = EXCLUDED.event_id, swapped = EXCLUDED.swapped, confidence = EXCLUDED.confidence, method = EXCLUDED.method`,
      [bk, ev.sourceId, target.id, swapped, confidence, method],
    );
    // aliasy pro příště
    const homePid = swapped ? target.awayId : target.homeId;
    const awayPid = swapped ? target.homeId : target.awayId;
    await this.saveAlias(bk, ev.sport, ev.home, homePid, 'auto');
    await this.saveAlias(bk, ev.sport, ev.away, awayPid, 'auto');
    this.links.set(key, { eventId: target.id, swapped });
    this.verified.add(key);
    if (this.pendingRechecked.has(key) && method !== 'manual') {
      // dříve nejistý pár se teď spároval automaticky -> uklidit frontu
      await db().query(
        `UPDATE unmatched_events SET status = 'confirmed', resolved_at = now() WHERE bookmaker = $1 AND source_event_id = $2 AND status = 'pending'`,
        [bk, ev.sourceId],
      );
    }
    target.linkedBooks.add(bk);
    this.stats.linked++;
    if (method === 'created') this.stats.created++;
    return { status: 'linked', eventId: target.id, swapped, method };
  }

  private async saveAlias(bk: BookmakerId, sport: Sport, raw: string, pid: number, source: 'auto' | 'manual'): Promise<void> {
    const k = aliasKey(bk, sport, raw);
    if (this.aliases.get(k) === pid) return;
    await db().query(
      `INSERT INTO participant_aliases (bookmaker, sport, raw_name, participant_id, source) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (bookmaker, sport, raw_name) DO UPDATE SET participant_id = EXCLUDED.participant_id,
       source = CASE WHEN participant_aliases.source = 'manual' THEN 'manual' ELSE EXCLUDED.source END`,
      [bk, sport, raw, pid, source],
    );
    this.aliases.set(k, pid);
    this.participants.get(pid)?.names.add(raw);
  }

  private async participantFor(bk: BookmakerId, sport: Sport, raw: string): Promise<number> {
    const alias = this.aliases.get(aliasKey(bk, sport, raw));
    if (alias) return alias;
    const nk = participantKey(raw, sport);
    const existing = this.participantsByKey.get(`${sport}|${nk}`);
    if (existing) return existing;
    const r = await db().query<{ id: number }>(
      `INSERT INTO participants (sport, name, norm_key, kind) VALUES ($1,$2,$3,$4)
       ON CONFLICT (sport, norm_key) DO UPDATE SET name = participants.name RETURNING id`,
      [sport, raw, nk, sport === 'tennis' ? (raw.includes('/') ? 'pair' : 'player') : 'team'],
    );
    const id = r.rows[0].id;
    if (!this.participants.has(id)) this.addParticipant(id, sport, raw);
    return id;
  }

  private async competitionFor(sport: Sport, name: string, country?: string): Promise<number | null> {
    if (!name) return null;
    const nk = participantKey(`${country ?? ''} ${name}`, 'tennis');
    const r = await db().query<{ id: number }>(
      `INSERT INTO competitions (sport, name, country, norm_key) VALUES ($1,$2,$3,$4)
       ON CONFLICT (sport, norm_key) DO UPDATE SET name = competitions.name RETURNING id`,
      [sport, name, country ?? null, nk],
    );
    return r.rows[0].id;
  }

  private async createEvent(bk: BookmakerId, ev: RawEvent, isSim: boolean): Promise<CanonEvent> {
    const homeId = await this.participantFor(bk, ev.sport, ev.home);
    let awayId = await this.participantFor(bk, ev.sport, ev.away);
    if (awayId === homeId) {
      // dvě různá jména se znormalizovala stejně (např. "Real Madrid" v basketu vs fotbale se nemíchá, ale pro jistotu)
      const r = await db().query<{ id: number }>(
        `INSERT INTO participants (sport, name, norm_key) VALUES ($1,$2,$3) RETURNING id`,
        [ev.sport, ev.away, `${participantKey(ev.away, ev.sport)}#${Date.now()}`],
      );
      awayId = r.rows[0].id;
      this.addParticipant(awayId, ev.sport, ev.away);
    }
    const compId = await this.competitionFor(ev.sport, ev.competition, ev.country);
    const r = await db().query<{ id: number }>(
      `INSERT INTO events (sport, competition_id, home_id, away_id, start_time, is_sim) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [ev.sport, compId, homeId, awayId, new Date(ev.startTime), isSim],
    );
    const e: CanonEvent = {
      id: r.rows[0].id,
      sport: ev.sport,
      competition: ev.competition,
      homeId,
      awayId,
      home: this.participants.get(homeId)?.name ?? ev.home,
      away: this.participants.get(awayId)?.name ?? ev.away,
      startTime: ev.startTime,
      isSim,
      linkedBooks: new Set(),
    };
    this.events.set(e.id, e);
    return e;
  }

  private async enqueue(bk: BookmakerId, ev: RawEvent, c: Candidate): Promise<void> {
    const key = linkKey(bk, ev.sourceId);
    this.pending.add(key);
    this.pendingRechecked.add(key);
    this.stats.pending++;
    await db().query(
      `INSERT INTO unmatched_events (bookmaker, source_event_id, sport, competition, raw_home, raw_away, start_time,
         candidate_event_id, candidate_label, candidate_start, score, swapped, reasons)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (bookmaker, source_event_id) DO UPDATE SET status = 'pending', candidate_event_id = EXCLUDED.candidate_event_id,
         candidate_label = EXCLUDED.candidate_label, score = EXCLUDED.score, swapped = EXCLUDED.swapped, reasons = EXCLUDED.reasons`,
      [
        bk,
        ev.sourceId,
        ev.sport,
        ev.competition,
        ev.home,
        ev.away,
        new Date(ev.startTime),
        c.event.id,
        `${c.event.home} – ${c.event.away}`,
        new Date(c.event.startTime),
        c.score,
        c.swapped,
        JSON.stringify({ home: round(c.home), away: round(c.away), deltaMin: Math.round((ev.startTime - c.event.startTime) / 60_000) }),
      ],
    );
  }

  /** Reakce na ruční rozhodnutí v dashboardu (DB už upravila gateway). */
  async onResolved(bookmaker: BookmakerId, sourceId: string, action: 'confirmed' | 'rejected', candidateId?: number): Promise<void> {
    const key = linkKey(bookmaker, sourceId);
    this.pending.delete(key);
    if (action === 'rejected' && candidateId) this.rejectCandidate(key, candidateId);
    if (action === 'confirmed') {
      const r = await db().query<{ event_id: number; swapped: boolean }>(
        'SELECT event_id, swapped FROM event_links WHERE bookmaker = $1 AND source_event_id = $2',
        [bookmaker, sourceId],
      );
      const l = r.rows[0];
      if (l) {
        this.links.set(key, { eventId: l.event_id, swapped: l.swapped });
        this.events.get(l.event_id)?.linkedBooks.add(bookmaker);
      }
      const al = await db().query<{ sport: string; raw_name: string; participant_id: number }>(
        `SELECT sport, raw_name, participant_id FROM participant_aliases WHERE bookmaker = $1`,
        [bookmaker],
      );
      for (const a of al.rows) {
        this.aliases.set(aliasKey(bookmaker, a.sport, a.raw_name), a.participant_id);
        this.participants.get(a.participant_id)?.names.add(a.raw_name);
      }
    }
  }

  /** Odebere z cache staré události (start > 8 h zpátky). */
  prune(now = Date.now()): void {
    for (const [id, e] of this.events) if (e.startTime < now - 8 * 3600e3) this.events.delete(id);
  }
}

function combine(h: number, a: number): number {
  return h && a ? 0.7 * Math.min(h, a) + 0.3 * ((h + a) / 2) : 0;
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}
