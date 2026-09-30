// Fortuna – live stav udržovaný z REST snapshotu + websocket zpráv (bez I/O, testovatelné).
import type { Sport } from '../../core/types.js';
import {
  PRIMARY_SPORTS,
  SPORTS_MAP,
  isMappedMarketType,
  isSkipped,
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
  /** Všechny trhy jednoho zápasu (odebírá stránka zápasu) – vč. suspendovaných výběrů (odds 1, SUSPENDED). */
  detail: (fixtureId: string) => `${DETAIL_PREFIX}${fixtureId}`,
};
const DETAIL_PREFIX = '/topic/offer/cs/market.';

/** Po jaké době se plný scoreboard (hodiny) přestane používat (běžící / zastavené hodiny). */
const CLOCK_MAX_AGE_MS = 120_000;
const FROZEN_CLOCK_MAX_AGE_MS = 30 * 60_000;
/** Jak dlouho si store pamatuje aplikované WS zprávy (pro přehrání po REST snapshotu). */
export const JOURNAL_MS = 30_000;

export class FortunaLiveStore {
  private fixtures = new Map<string, FtnFixture>();
  private tournaments = new Map<string, FtnTournament>();
  private categories = new Map<string, FtnCategory>();
  private markets = new Map<string, Map<string, FtnMarket>>();
  private owner = new Map<string, string>();
  private minis = new Map<string, FtnMiniScoreboard>();
  private clocks = new Map<string, { sb: FtnScoreboard; at: number }>();
  /**
   * Plné sady trhů zápasů s odběrem market.{id} (REST detail + zprávy), jen namapovatelné typy.
   * Overview obsahuje jen plně otevřené hlavní trhy (suspendovaný trh prostě zmizí); detail má všechny
   * linie a suspendaci po výběrech – když je načtený, má pro daný zápas přednost.
   */
  private details = new Map<string, Map<string, FtnMarket>>();
  /** Poslední zpráva overview-markets / market.{id} (nebo načtení detailu) per zápas – hlídání tichého odběru. */
  private overviewMsgAt = new Map<string, number>();
  private detailMsgAt = new Map<string, number>();
  /** Poslední WS zprávy (v pořadí příchodu) – po snapshotu se přehrají ty novější než snapshot. */
  private journal: { destination: string; msg: FtnWsMessage; at: number }[] = [];
  /** Zvyšuje se při každé změně (pro throttling emitů). */
  version = 0;
  snapshotAt = 0;
  lastMessageAt = 0;

  get warm(): boolean {
    return this.snapshotAt > 0;
  }

  /**
   * Nahradí stav REST snapshotem (hodiny ze scoreboardů si ponechá). REST odpovědi zachycují stav
   * z okamžiku požadavku, ale dorazí o stovky ms později (výpis zápasů je navíc z CDN až 5 s starý)
   * – WS zprávy z mezidobí by snapshot přepsal starším stavem (vzkříšený suspendovaný trh, starý
   * kurz až do další změny). Proto se po načtení přehrají zprávy přijaté od `replaySince`
   * (začátek stahování snapshotu minus stáří CDN). Přehrání v pořadí je idempotentní: každý trh
   * skončí ve stavu své poslední zprávy, trhy bez zprávy zůstanou ze snapshotu.
   */
  loadSnapshot(b: FortunaBundle, now = Date.now(), replaySince?: number): void {
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
    if (replaySince !== undefined) for (const j of this.journal) if (j.at >= replaySince) this.applyOne(j.destination, j.msg, j.at);
    for (const id of this.details.keys()) if (!this.fixtures.has(id)) this.details.delete(id);
    this.snapshotAt = now;
    this.version++;
  }

  /**
   * Nahradí plnou sadu trhů zápasu REST detailem a přehraje zprávy market.{id} přijaté od
   * `replaySince` (topic musí být odebíraný už před stažením detailu).
   */
  loadDetail(fixtureId: string, markets: FtnMarket[], now = Date.now(), replaySince?: number): void {
    const map = new Map<string, FtnMarket>();
    for (const m of markets) if (m.kind === 'LIVE' && isMappedMarketType(m.marketTypeId ?? '')) map.set(m.id, { ...m, fixtureId });
    this.details.set(fixtureId, map);
    this.detailMsgAt.set(fixtureId, now);
    const dest = TOPIC.detail(fixtureId);
    if (replaySince !== undefined) for (const j of this.journal) if (j.at >= replaySince && j.destination === dest) this.applyOne(j.destination, j.msg, j.at);
    if (!this.fixtures.has(fixtureId)) this.details.delete(fixtureId);
    this.version++;
  }

  /** Zahodí plné sady trhů (po výpadku spojení chybí zprávy – do nového načtení platí overview). */
  dropDetail(fixtureId?: string): void {
    if (fixtureId === undefined) this.details.clear();
    else this.details.delete(fixtureId);
    this.version++;
  }

  /**
   * Detail, jehož topic mlčí: overview-markets doručil zprávu o zápasu (overview trhy jsou podmnožinou
   * detailu, takže stejnou změnu musí nést i market.{id}), ale market.{id} od té doby nic – do `graceMs`
   * se nedoručilo. Takový detail se zahodí (platí overview) a vrátí se k novému načtení.
   */
  dropSilentDetails(now = Date.now(), graceMs = 3_000, toleranceMs = 1_000): string[] {
    const out: string[] = [];
    for (const fid of this.details.keys()) {
      const ov = this.overviewMsgAt.get(fid) ?? 0;
      const dt = this.detailMsgAt.get(fid) ?? 0;
      if (ov - dt > toleranceMs && now - ov >= graceMs) out.push(fid);
    }
    for (const fid of out) this.details.delete(fid);
    if (out.length) this.version++;
    return out;
  }

  hasDetail(fixtureId: string): boolean {
    return this.details.has(fixtureId);
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
    this.details.delete(id);
    this.overviewMsgAt.delete(id);
    this.detailMsgAt.delete(id);
    return had;
  }

  /** Aplikuje jednu WS zprávu (a zapamatuje si ji pro přehrání po snapshotu); vrací true, když se stav změnil. */
  apply(destination: string, msg: FtnWsMessage, now = Date.now()): boolean {
    this.lastMessageAt = now;
    this.journal.push({ destination, msg, at: now });
    let drop = 0;
    while (drop < this.journal.length && this.journal[drop].at < now - JOURNAL_MS) drop++;
    if (drop) this.journal.splice(0, drop);
    return this.applyOne(destination, msg, now);
  }

  private applyOne(destination: string, msg: FtnWsMessage, now: number): boolean {
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
    } else if (destination.startsWith(DETAIL_PREFIX)) {
      const fid = destination.slice(DETAIL_PREFIX.length);
      const map = this.details.get(fid);
      if (!map) return false; // detail ještě není načtený – zprávu přehraje loadDetail() z journalu
      this.detailMsgAt.set(fid, now);
      const m = msg.data as FtnMarket | undefined;
      const id = m?.id ?? msg.id;
      if (!id) return false;
      if (del || !m) changed = map.delete(id);
      else if (m.kind === 'LIVE' && isMappedMarketType(m.marketTypeId ?? '')) {
        map.set(id, { ...m, fixtureId: fid });
        changed = true;
      } else changed = map.delete(id);
      changed = changed && this.fixtures.has(fid);
    } else if (destination.endsWith('/overview-markets')) {
      const m = msg.data as FtnMarket | undefined;
      const id = m?.id ?? msg.id;
      if (!id) return false;
      if (del || !m) changed = this.dropMarket(id);
      else if (m.kind === 'LIVE' && m.fixtureId) {
        this.putMarket(m);
        changed = this.fixtures.has(m.fixtureId);
        // změna kurzů, kterou detail zápasu (zatím) nemá -> market.{id} ji musí do chvíle doručit
        const d = this.details.get(m.fixtureId)?.get(id);
        if (d && outcomesSig(d) !== outcomesSig(m) && (this.overviewMsgAt.get(m.fixtureId) ?? 0) <= (this.detailMsgAt.get(m.fixtureId) ?? 0))
          this.overviewMsgAt.set(m.fixtureId, now);
      }
    }
    if (changed) this.version++;
    return changed;
  }

  liveFixtureIds(sports: Sport[]): string[] {
    return [...this.fixtures.values()].filter((f) => sports.includes(sportOfFixture(f) as Sport)).map((f) => f.id);
  }

  /**
   * Zápasy, u kterých má smysl odebírat plnou sadu trhů: naše sporty, bez e-sportů, s trhy. Hlavní
   * sporty (`primary`) první – limit odběrů je obsadí přednostně (stolní tenis má v noci desítky
   * zápasů) –, v rámci skupiny podle začátku.
   */
  detailCandidates(sports: Sport[], primary: Sport[] = PRIMARY_SPORTS): string[] {
    const tier = (f: FtnFixture) => (primary.includes(sportOfFixture(f) as Sport) ? 0 : 1);
    return [...this.fixtures.values()]
      .filter((f) => sports.includes(sportOfFixture(f) as Sport) && f.hasMarkets !== false)
      .filter((f) => !isSkipped(f, this.tournaments.get(f.tournamentId), this.categories.get(f.categoryId)))
      .sort((a, b) => tier(a) - tier(b) || a.startDatetime - b.startDatetime)
      .map((f) => f.id);
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
    for (const [fid, map] of this.details) if (this.fixtures.has(fid)) markets[fid] = [...map.values()];
    const clocks: Record<string, FtnScoreboard> = {};
    for (const [fid, { sb, at }] of this.clocks) {
      const age = now - at;
      // zmrazené hodiny (přestávka) vydrží déle; fotbal timerRunning nemá – jeho eventTime stárne jako běžící
      if (age > (sb.timerRunning === false ? FROZEN_CLOCK_MAX_AGE_MS : CLOCK_MAX_AGE_MS) || !this.fixtures.has(fid)) continue;
      const run = sb.timerRunning === true ? Math.max(0, Math.floor(age / 1000)) : 0;
      const c: FtnScoreboard = { ...sb };
      if (typeof sb.eventTime === 'number') c.eventTime = sb.eventTime + run;
      if (typeof sb.remainingTimeInPeriod === 'number') c.remainingTimeInPeriod = Math.max(0, sb.remainingTimeInPeriod - run);
      clocks[fid] = c;
    }
    return { scope: 'live', pages: [page], markets, scoreboards: [...this.minis.values()], clocks };
  }
}

function outcomesSig(m: FtnMarket): string {
  return m.outcomes.map((o) => `${o.id}=${o.odds}/${o.displayType ?? ''}`).sort().join(',');
}

/** Sporty, pro které se vyplatí odebírat plný scoreboard (přesné hodiny). */
export const CLOCK_SPORTS: Sport[] = ['football', 'hockey', 'basketball', 'handball', 'american_football'];
export const SPORT_IDS = Object.fromEntries(Object.entries(SPORTS_MAP).map(([s, v]) => [s, v.id])) as Record<Sport, string>;
