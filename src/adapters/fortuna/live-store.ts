// Fortuna – live stav udržovaný z REST snapshotu + websocket zpráv (bez I/O, testovatelné).
import type { Sport } from '../../core/types.js';
import {
  SPORTS_MAP,
  mergeMini,
  sportOfFixture,
  type FortunaBundle,
  type FtnCategory,
  type FtnFixture,
  type FtnMarket,
  type FtnMatchesPage,
  type FtnMiniScoreboard,
  type FtnScoreboard,
  type FtnTournament,
} from './parse.js';

/** Tělo STOMP MESSAGE na /topic/offer/... */
export interface FtnWsMessage {
  id?: string;
  data?: unknown;
  operation?: string; // UPDATE | DELETE (| CREATE)
  type?: string; // FIXTURE | MARKET | TOURNAMENT | SPORT
  created?: number;
}

export const TOPIC = {
  fixtures: '/topic/offer/cs/fixtures',
  tournaments: '/topic/offer/cs/tournaments',
  miniscoreboard: '/topic/offer/v2/cs/miniscoreboard',
  markets: (sportId: string) => `/topic/offer/cs/sport/${sportId}/overview-markets`,
  scoreboard: (fixtureId: string) => `/topic/offer/v2/cs/scoreboard.${fixtureId}`,
};

/** Po jaké době se plný scoreboard (hodiny) přestane používat (běžící / zastavené hodiny). */
const CLOCK_MAX_AGE_MS = 120_000;
const FROZEN_CLOCK_MAX_AGE_MS = 30 * 60_000;

export class FortunaLiveStore {
  private fixtures = new Map<string, FtnFixture>();
  private tournaments = new Map<string, FtnTournament>();
  private categories = new Map<string, FtnCategory>();
  private markets = new Map<string, Map<string, FtnMarket>>();
  private owner = new Map<string, string>();
  private minis = new Map<string, FtnMiniScoreboard>();
  private clocks = new Map<string, { sb: FtnScoreboard; at: number }>();
  /** Zvyšuje se při každé změně (pro throttling emitů). */
  version = 0;
  snapshotAt = 0;
  lastMessageAt = 0;

  get warm(): boolean {
    return this.snapshotAt > 0;
  }

  /** Nahradí stav REST snapshotem (hodiny ze scoreboardů si ponechá). */
  loadSnapshot(b: FortunaBundle, now = Date.now()): void {
    this.fixtures.clear();
    this.markets.clear();
    this.owner.clear();
    for (const p of b.pages) {
      for (const t of p.tournaments ?? []) this.tournaments.set(t.id, t);
      for (const c of p.categories ?? []) this.categories.set(c.id, c);
      for (const f of p.fixtures ?? []) if (f.kind === 'LIVE') this.fixtures.set(f.id, f);
    }
    for (const [fid, list] of Object.entries(b.markets)) for (const m of list) this.putMarket({ ...m, fixtureId: m.fixtureId ?? fid });
    const prevMinis = new Map(this.minis);
    this.minis.clear();
    for (const s of b.scoreboards ?? []) this.minis.set(s.fixtureId, mergeMini(prevMinis.get(s.fixtureId), s));
    for (const id of this.clocks.keys()) if (!this.fixtures.has(id)) this.clocks.delete(id);
    this.snapshotAt = now;
    this.version++;
  }

  private putMarket(m: FtnMarket): void {
    if (!m.fixtureId) return;
    let map = this.markets.get(m.fixtureId);
    if (!map) this.markets.set(m.fixtureId, (map = new Map()));
    map.set(m.id, m);
    this.owner.set(m.id, m.fixtureId);
  }

  private dropMarket(id: string): boolean {
    const fid = this.owner.get(id);
    if (!fid) return false;
    this.owner.delete(id);
    return this.markets.get(fid)?.delete(id) ?? false;
  }

  private dropFixture(id: string): boolean {
    const had = this.fixtures.delete(id);
    for (const mid of this.markets.get(id)?.keys() ?? []) this.owner.delete(mid);
    this.markets.delete(id);
    this.minis.delete(id);
    this.clocks.delete(id);
    return had;
  }

  /** Aplikuje jednu WS zprávu; vrací true, když se stav změnil. */
  apply(destination: string, msg: FtnWsMessage, now = Date.now()): boolean {
    this.lastMessageAt = now;
    const del = msg.operation === 'DELETE';
    let changed = false;
    if (destination === TOPIC.fixtures) {
      const f = msg.data as FtnFixture | undefined;
      const id = f?.id ?? msg.id;
      if (!id) return false;
      if (del || !f) changed = this.dropFixture(id);
      else if (!sportOfFixture(f)) return false;
      else if (f.kind === 'LIVE') {
        this.fixtures.set(id, f);
        changed = true;
      } else changed = this.dropFixture(id); // zápas už není live
    } else if (destination === TOPIC.tournaments) {
      const t = msg.data as FtnTournament | undefined;
      if (t?.id && !del) this.tournaments.set(t.id, t);
      return false; // jen doplnění názvů
    } else if (destination === TOPIC.miniscoreboard) {
      const s = msg.data as FtnMiniScoreboard | undefined;
      const id = s?.fixtureId ?? msg.id;
      if (!id) return false;
      if (del || !s) changed = this.minis.delete(id);
      else if (this.fixtures.has(id) || this.minis.has(id)) {
        this.minis.set(id, mergeMini(this.minis.get(id), s));
        changed = true;
      }
    } else if (destination.startsWith('/topic/offer/v2/cs/scoreboard.')) {
      const s = msg.data as FtnScoreboard | undefined;
      const id = s?.fixtureId ?? msg.id;
      if (!id || !s) return false;
      const at = Math.min(now, msg.created ?? now);
      const prev = this.clocks.get(id);
      let sb = s;
      if (prev && s.eventTime === undefined && s.remainingTimeInPeriod === undefined) {
        // přestávka: feed pošle scoreboard bez hodin -> zmrazíme poslední známý čas
        const run = prev.sb.timerRunning === true ? Math.max(0, Math.floor((at - prev.at) / 1000)) : 0;
        sb = { ...s, timerRunning: false };
        if (typeof prev.sb.eventTime === 'number') sb.eventTime = prev.sb.eventTime + run;
        if (typeof prev.sb.remainingTimeInPeriod === 'number') sb.remainingTimeInPeriod = Math.max(0, prev.sb.remainingTimeInPeriod - run);
      }
      this.clocks.set(id, { sb, at });
      changed = this.fixtures.has(id);
    } else if (destination.endsWith('/overview-markets')) {
      const m = msg.data as FtnMarket | undefined;
      const id = m?.id ?? msg.id;
      if (!id) return false;
      if (del || !m) changed = this.dropMarket(id);
      else if (m.kind === 'LIVE' && m.fixtureId) {
        this.putMarket(m);
        changed = this.fixtures.has(m.fixtureId);
      }
    }
    if (changed) this.version++;
    return changed;
  }

  liveFixtureIds(sports: Sport[]): string[] {
    return [...this.fixtures.values()].filter((f) => sports.includes(sportOfFixture(f) as Sport)).map((f) => f.id);
  }

  /** Aktuální stav jako bundle pro parse.buildEvents(); hodiny extrapolované, když běží. */
  bundle(now = Date.now()): FortunaBundle {
    const page: FtnMatchesPage = {
      fixtures: [...this.fixtures.values()],
      tournaments: [...this.tournaments.values()],
      categories: [...this.categories.values()],
    };
    const markets: Record<string, FtnMarket[]> = {};
    for (const [fid, map] of this.markets) if (this.fixtures.has(fid)) markets[fid] = [...map.values()];
    const clocks: Record<string, FtnScoreboard> = {};
    for (const [fid, { sb, at }] of this.clocks) {
      const age = now - at;
      if (age > (sb.timerRunning === true ? CLOCK_MAX_AGE_MS : FROZEN_CLOCK_MAX_AGE_MS) || !this.fixtures.has(fid)) continue;
      const run = sb.timerRunning === true ? Math.max(0, Math.floor(age / 1000)) : 0;
      const c: FtnScoreboard = { ...sb };
      if (typeof sb.eventTime === 'number') c.eventTime = sb.eventTime + run;
      if (typeof sb.remainingTimeInPeriod === 'number') c.remainingTimeInPeriod = Math.max(0, sb.remainingTimeInPeriod - run);
      clocks[fid] = c;
    }
    return { scope: 'live', pages: [page], markets, scoreboards: [...this.minis.values()], clocks };
  }
}

/** Sporty, pro které se vyplatí odebírat plný scoreboard (přesné hodiny). */
export const CLOCK_SPORTS: Sport[] = ['football', 'hockey', 'basketball'];
export const SPORT_IDS = Object.fromEntries(Object.entries(SPORTS_MAP).map(([s, v]) => [s, v.id])) as Record<Sport, string>;
