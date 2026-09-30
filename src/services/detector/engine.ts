// Detekce arbů a jejich životní cyklus. Čistá logika bez I/O (testovatelná) – I/O dodávají deps.
import { randomUUID } from 'node:crypto';
import type { BookmakerId, EndReason, Mode, SelectionKey } from '../../core/types.js';
import { BOOKMAKERS } from '../../core/types.js';
import { REQUIRED_SELECTIONS, marketLabel, parseMarketKey, selectionLabel } from '../../core/markets.js';
import { arbMargin, computeStakes, effectiveOdds, marginBand } from '../../core/arb.js';
import { pauseRemainingSec } from '../../core/pause.js';
import type { Settings } from '../../core/settings.js';
import type { SegmentFeatures } from '../../core/survival.js';
import type { ArbDTO, ArbEventKind, BookEventState, EventView, OddsDiffMessage, PredictionDTO } from '../../shared/protocol.js';

export interface LegState {
  bookmaker: BookmakerId;
  selection: SelectionKey;
  odds: number;
  effOdds: number;
  changedAt: number;
  seenAt: number;
  swapped: boolean;
  sourceEventId: string;
  url?: string;
}

export interface ActiveArb {
  id: string;
  eventId: number;
  market: string;
  combo: string;
  mode: Mode;
  legs: LegState[];
  margin: number;
  prevMargin: number | null;
  maxMargin: number;
  marginAtDetection: number;
  firstSeen: number;
  lastSeen: number;
  detectedAt: number;
  prediction: PredictionDTO | null;
  muted: boolean;
  risky: boolean;
  isSim: boolean;
  /** snímek události při detekci (herní stav, pauza, čas do výkopu) */
  eventAtDetection: EventView;
  stakes: { stakes: number[]; total: number; minProfit: number; positive: boolean; bankroll: number };
  lastTickAt: number;
  /** kdy se naposledy poslalo potvrzení stáří noh do dashboardu (bez změny kurzu) */
  seenEmitAt?: number;
  endReason?: EndReason;
  endBookmaker?: BookmakerId;
  endedAt?: number;
}

export interface EngineDeps {
  settings(): Settings;
  now(): number;
  predict(f: SegmentFeatures, arb: { mode: Mode; bookmakers: BookmakerId[]; isSim: boolean; marginPct: number }): PredictionDTO | null;
  emit(kind: ArbEventKind, arb: ActiveArb, dto: ArbDTO, dataAt: number): void;
  persistNew(arb: ActiveArb, dto: ArbDTO): void;
  persistTick(arb: ActiveArb): void;
  persistEnd(arb: ActiveArb): void;
}

/** Max souběžných arbů na jeden trh jedné události (různé kombinace sázkovek). */
const MAX_PER_MARKET = 3;
const TICK_MIN_INTERVAL_MS = 200;
const SEEN_EMIT_MS = 2_000;

export class ArbEngine {
  readonly events = new Map<number, EventView>();
  readonly books = new Map<number, Map<BookmakerId, BookEventState>>();
  readonly active = new Map<string, ActiveArb>();
  private byKey = new Map<string, Set<string>>();
  /** live kandidáti odložení kontrolou synchronnosti – přehodnotí se, až dorazí novější data nohou */
  private pendingSync = new Map<number, Set<string>>();
  /** kandidáti čekající na potvrzovací okno (klíč event|trh) */
  private pendingConfirm = new Map<string, { combo: string; since: number; eventId: number; market: string }>();
  stats = { evaluations: 0, created: 0, ended: 0 };

  constructor(private deps: EngineDeps) {}

  // --- vstupy -------------------------------------------------------------------------------

  loadState(events: EventView[], states: [BookmakerId, number, BookEventState][]): void {
    for (const e of events) this.events.set(e.id, e);
    for (const [bk, id, st] of states) this.bookMap(id).set(bk, st);
    for (const id of this.books.keys()) this.evaluateEvent(id, this.deps.now());
  }

  private bookMap(eventId: number): Map<BookmakerId, BookEventState> {
    let m = this.books.get(eventId);
    if (!m) this.books.set(eventId, (m = new Map()));
    return m;
  }

  applyDiff(msg: OddsDiffMessage): void {
    const dataAt = msg.fetchedAt;
    const affected = new Map<string, { eventId: number; market: string }>();
    const touch = (eventId: number, market: string) => affected.set(`${eventId}|${market}`, { eventId, market });

    for (const ev of msg.events) {
      const prev = this.events.get(ev.id);
      this.events.set(ev.id, ev);
      const reason = prev ? transitionReason(prev, ev) : null;
      if (reason) this.endAllForEvent(ev.id, reason, dataAt);
      if (prev && prev.mode !== ev.mode) for (const [k, p] of this.pendingConfirm) if (p.eventId === ev.id) this.pendingConfirm.delete(k);
      if (!prev || prev.mode !== ev.mode) for (const m of this.marketsOf(ev.id)) touch(ev.id, m);
    }

    if (msg.bk) {
      const bk = msg.bk;
      const cfgMode = (id: number) => this.deps.settings().modes[this.events.get(id)?.mode ?? 'PREMATCH'];
      for (const id of msg.removed) {
        const st = this.books.get(id)?.get(bk);
        if (!st) continue;
        this.books.get(id)!.delete(bk);
        for (const m of Object.keys(st.markets)) touch(id, m);
      }
      const changedByEvent = new Map<number, Set<string>>();
      for (const c of msg.changes) {
        let s = changedByEvent.get(c.eventId);
        if (!s) changedByEvent.set(c.eventId, (s = new Set()));
        s.add(c.market);
      }
      for (const [idStr, st] of Object.entries(msg.states)) {
        const id = Number(idStr);
        const map = this.bookMap(id);
        const prev = map.get(bk);
        map.set(bk, st);
        const markets = !prev ? Object.keys(st.markets) : [...(changedByEvent.get(id) ?? [])];
        for (const m of markets) touch(id, m);
      }
      for (const id of msg.seen) {
        const st = this.books.get(id)?.get(bk);
        if (!st) continue;
        const wasStale = dataAt - st.seenAt > cfgMode(id).maxLegAgeMs;
        st.seenAt = Math.max(st.seenAt, dataAt);
        if (wasStale) for (const m of Object.keys(st.markets)) touch(id, m);
        const waiting = this.pendingSync.get(id);
        if (waiting) {
          this.pendingSync.delete(id);
          for (const m of waiting) touch(id, m);
        }
      }
    }
    for (const { eventId, market } of affected.values()) this.evaluate(eventId, market, dataAt, msg.bk ?? undefined);
  }

  /** Periodická kontrola: zastaralé nohy, začátek zápasu u PREMATCH arbů. */
  sweep(): void {
    const now = this.deps.now();
    const settings = this.deps.settings();
    for (const arb of [...this.active.values()]) {
      const ev = this.events.get(arb.eventId);
      if (arb.mode === 'PREMATCH' && ev && ev.startTime <= now) {
        this.end(arb, 'event_started', undefined, ev.startTime);
        continue;
      }
      const maxAge = settings.modes[arb.mode].maxLegAgeMs;
      const bookMap = this.books.get(arb.eventId);
      let stale: LegState | undefined;
      let minSeen = Infinity;
      for (const leg of arb.legs) {
        const seen = bookMap?.get(leg.bookmaker)?.seenAt ?? leg.seenAt;
        minSeen = Math.min(minSeen, seen);
        if (now - seen > maxAge) stale = leg;
      }
      if (stale) this.end(arb, `stale:${stale.bookmaker}`, stale.bookmaker, now);
      else {
        arb.lastSeen = now;
        this.refreshLegsSeen(arb, bookMap, now);
      }
    }
    for (const id of this.pendingSync.keys()) if (!this.books.has(id)) this.pendingSync.delete(id);
    for (const p of [...this.pendingConfirm.values()]) {
      const mode = this.events.get(p.eventId)?.mode ?? 'PREMATCH';
      if (now - p.since >= (settings.modes[mode].confirmMs ?? 0)) this.evaluate(p.eventId, p.market, now);
    }
  }

  /**
   * Nohy se potvrzují i bez změny kurzu (každé stažení = seen); dashboard ukazuje „kurz ověřen před …“,
   * takže čerstvé stáří pošleme nejvýš jednou za SEEN_EMIT_MS.
   */
  private refreshLegsSeen(arb: ActiveArb, bookMap: Map<BookmakerId, BookEventState> | undefined, now: number): void {
    let moved = false;
    for (const leg of arb.legs) {
      const seen = bookMap?.get(leg.bookmaker)?.seenAt;
      if (seen !== undefined && seen > leg.seenAt) {
        leg.seenAt = seen;
        moved = true;
      }
    }
    if (!moved || now - (arb.seenEmitAt ?? arb.detectedAt) < SEEN_EMIT_MS) return;
    arb.seenEmitAt = now;
    this.deps.emit('update', arb, this.toDTO(arb), Math.min(...arb.legs.map((l) => l.seenAt)));
  }

  /** Změna nastavení: nové prahy, poplatky, povolené sázkovky. */
  reevaluateAll(reason: 'threshold_changed' = 'threshold_changed'): void {
    const now = this.deps.now();
    for (const arb of [...this.active.values()]) {
      const cfg = this.deps.settings();
      if (arb.margin < cfg.modes[arb.mode].minMarginPct || !arb.legs.every((l) => cfg.bookmakers[l.bookmaker]?.enabled !== false))
        this.end(arb, reason, undefined, now);
    }
    for (const id of this.books.keys()) this.evaluateEvent(id, now);
  }

  /** Ingest se restartoval – starý stav neplatí. */
  reset(): void {
    this.shutdown();
    this.events.clear();
    this.books.clear();
    this.byKey.clear();
    this.pendingSync.clear();
    this.pendingConfirm.clear();
  }

  unlinkEvent(eventId: number): void {
    this.endAllForEvent(eventId, 'unlinked', this.deps.now());
  }

  // --- detekce ------------------------------------------------------------------------------

  private marketsOf(eventId: number): string[] {
    const s = new Set<string>();
    for (const st of this.books.get(eventId)?.values() ?? []) for (const m of Object.keys(st.markets)) s.add(m);
    return [...s];
  }

  private evaluateEvent(eventId: number, dataAt: number): void {
    for (const m of this.marketsOf(eventId)) this.evaluate(eventId, m, dataAt);
  }

  private endAllForEvent(eventId: number, reason: EndReason, at: number): void {
    for (const arb of [...this.active.values()]) if (arb.eventId === eventId) this.end(arb, reason, undefined, at);
  }

  private isOutlier(eventId: number, market: string, sel: SelectionKey, bk: BookmakerId, odds: number): boolean {
    const cfg = this.deps.settings().consensus;
    const others: number[] = [];
    for (const [b, st] of this.books.get(eventId) ?? []) {
      if (b === bk) continue;
      const s = st.markets[market]?.sels[sel];
      if (s?.open) others.push(1 / s.odds);
    }
    if (others.length < cfg.minBooks) return false;
    others.sort((a, b) => a - b);
    const med = others.length % 2 ? others[others.length >> 1] : (others[others.length / 2 - 1] + others[others.length / 2]) / 2;
    return Math.abs(1 / odds - med) / med > cfg.maxDeviationPct / 100;
  }

  evaluate(eventId: number, market: string, dataAt: number, changedBk?: BookmakerId): void {
    this.stats.evaluations++;
    const now = this.deps.now();
    const key = `${eventId}|${market}`;
    const ev = this.events.get(eventId);
    const bookMap = this.books.get(eventId);
    const settings = this.deps.settings();
    const mode: Mode = ev?.mode ?? 'PREMATCH';
    const cfg = settings.modes[mode];

    // 1) existující arby na tomto trhu
    const existing = [...(this.byKey.get(key) ?? [])].map((id) => this.active.get(id)!).filter(Boolean);
    for (const arb of existing) this.recheck(arb, dataAt, changedBk);

    // 2) nový kandidát; v live/přestávce se ukáže až po potvrzovacím okně (confirmMs) – arb, který
    //    zmizí dřív, je jen rozdílná rychlost reakce sázkovek na gól/bod a vsadit se nedá
    const found = ev && !ev.finished && bookMap && !(mode === 'PREMATCH' && ev.startTime <= now) ? this.candidate(eventId, market, mode, bookMap) : null;
    const pending = this.pendingConfirm.get(key);
    if (!found) {
      this.pendingConfirm.delete(key);
      return;
    }
    const confirmMs = cfg.confirmMs ?? 0;
    let since = now;
    if (confirmMs > 0) {
      if (!pending || pending.combo !== found.combo) {
        this.pendingConfirm.set(key, { combo: found.combo, since: now, eventId, market });
        return;
      }
      if (now - pending.since < confirmMs) return;
      since = pending.since;
    }
    this.pendingConfirm.delete(key);
    this.create(ev!, market, found.combo, found.best, found.margin, dataAt, since);
  }

  /** Nejlepší kurzy na každý výsledek → kandidát na nový arb (nebo null). */
  private candidate(eventId: number, market: string, mode: Mode, bookMap: Map<BookmakerId, BookEventState>): { best: LegState[]; margin: number; combo: string } | null {
    const now = this.deps.now();
    const key = `${eventId}|${market}`;
    const settings = this.deps.settings();
    const cfg = settings.modes[mode];
    // nejlepší kurz na každý výsledek
    const type = parseMarketKey(market).type;
    const sels = REQUIRED_SELECTIONS[type];
    const alive = [...(this.byKey.get(key) ?? [])].map((id) => this.active.get(id)!).filter(Boolean);
    const sticky = new Set(alive.flatMap((a) => a.legs.map((l) => `${l.selection}:${l.bookmaker}`)));
    const best: LegState[] = [];
    for (const sel of sels) {
      let b: LegState | undefined;
      for (const bk of BOOKMAKERS) {
        const st = bookMap.get(bk);
        if (!st || settings.bookmakers[bk]?.enabled === false) continue;
        const m = st.markets[market];
        const s = m?.sels[sel];
        if (!m || !s || !m.open || !s.open) continue;
        // nový arb jen z nohou, kterým zbývá aspoň 20 % limitu stáří (jinak hned zanikne jako stale)
        if (now - st.seenAt > cfg.maxLegAgeMs * 0.8) continue;
        if (this.isOutlier(eventId, market, sel, bk, s.odds)) continue;
        const eff = effectiveOdds(s.odds, settings.bookmakers[bk]?.feePct ?? 0);
        const better = !b || eff > b.effOdds || (eff === b.effOdds && sticky.has(`${sel}:${bk}`));
        if (better)
          b = { bookmaker: bk, selection: sel, odds: s.odds, effOdds: eff, changedAt: s.changedAt, seenAt: st.seenAt, swapped: st.swapped, sourceEventId: st.sourceEventId, url: st.url };
      }
      if (!b) return null;
      best.push(b);
    }
    if (new Set(best.map((l) => l.bookmaker)).size < 2) return null;
    const margin = arbMargin(best.map((l) => l.effOdds)) * 100;
    if (margin < cfg.minMarginPct) return null;
    // live: každá noha musí být potvrzená daty novějšími než poslední změna kurzu ostatních noh.
    // Jinak jde jen o fázi pollingu (jedna sázkovka už na gól/bod zareagovala, druhou jsme ještě
    // nestáhli) – takový "arb" zmizí s dalším stažením. Přehodnotí se, až dorazí čerstvá data.
    if (mode !== 'PREMATCH' && !legsInSync(best)) {
      let s = this.pendingSync.get(eventId);
      if (!s) this.pendingSync.set(eventId, (s = new Set()));
      s.add(market);
      return null;
    }
    const combo = best.map((l) => `${l.selection}:${l.bookmaker}`).join(',');
    if (alive.some((a) => a.combo === combo)) return null;
    if (alive.length >= MAX_PER_MARKET) return null;
    if (alive.some((a) => a.margin >= margin - 0.05)) return null; // jiná kombinace s podobnou marží už běží
    return { best, margin, combo };
  }

  private recheck(arb: ActiveArb, dataAt: number, changedBk?: BookmakerId): void {
    const bookMap = this.books.get(arb.eventId);
    const settings = this.deps.settings();
    const cfg = settings.modes[arb.mode];
    const now = this.deps.now();
    let changed = false;
    let worst: { bk: BookmakerId; delta: number } | undefined;
    const legs: LegState[] = [];
    for (const leg of arb.legs) {
      const st = bookMap?.get(leg.bookmaker);
      const m = st?.markets[arb.market];
      const s = m?.sels[leg.selection];
      if (!st || !m || !s || !m.open || !s.open) {
        this.end(arb, 'suspended', leg.bookmaker, dataAt);
        return;
      }
      if (now - st.seenAt > cfg.maxLegAgeMs) {
        this.end(arb, `stale:${leg.bookmaker}`, leg.bookmaker, st.seenAt);
        return;
      }
      const eff = effectiveOdds(s.odds, settings.bookmakers[leg.bookmaker]?.feePct ?? 0);
      if (s.odds !== leg.odds) {
        changed = true;
        const delta = 1 / s.odds - 1 / leg.odds; // růst implikované pravděpodobnosti = zhoršení
        if (!worst || delta > worst.delta) worst = { bk: leg.bookmaker, delta };
      }
      legs.push({ ...leg, odds: s.odds, effOdds: eff, changedAt: s.changedAt, seenAt: st.seenAt });
    }
    const margin = arbMargin(legs.map((l) => l.effOdds)) * 100;
    if (margin < cfg.minMarginPct) {
      const bk = worst?.bk ?? changedBk;
      if (bk) this.end(arb, `leg_odds_changed:${bk}`, bk, dataAt);
      else this.end(arb, 'threshold_changed', undefined, dataAt);
      return;
    }
    arb.lastSeen = Math.max(arb.lastSeen, now);
    for (let i = 0; i < legs.length; i++) arb.legs[i].seenAt = legs[i].seenAt;
    if (!changed) return;
    arb.prevMargin = arb.margin;
    arb.legs = legs;
    arb.margin = margin;
    arb.maxMargin = Math.max(arb.maxMargin, margin);
    arb.stakes = this.stakesFor(legs);
    if (now - arb.lastTickAt >= TICK_MIN_INTERVAL_MS) {
      arb.lastTickAt = now;
      this.deps.persistTick(arb);
    }
    this.deps.emit('update', arb, this.toDTO(arb), dataAt);
  }

  private stakesFor(legs: LegState[]): ActiveArb['stakes'] {
    const s = this.deps.settings();
    const plan = computeStakes(legs.map((l) => l.effOdds), s.bankroll, s.roundingUnit);
    return plan
      ? { stakes: plan.stakes, total: plan.total, minProfit: plan.minProfit, positive: plan.positive, bankroll: s.bankroll }
      : { stakes: legs.map(() => 0), total: 0, minProfit: 0, positive: false, bankroll: s.bankroll };
  }

  private create(ev: EventView, market: string, combo: string, legs: LegState[], margin: number, dataAt: number, since?: number): void {
    const now = this.deps.now();
    const type = parseMarketKey(market).type;
    const bookmakers = [...new Set(legs.map((l) => l.bookmaker))].sort();
    const prediction = this.deps.predict(
      { mode: ev.mode, sport: ev.sport, marketType: type, pair: bookmakers.join('|'), marginBand: marginBand(margin) },
      { mode: ev.mode, bookmakers, isSim: ev.isSim, marginPct: margin },
    );
    const settings = this.deps.settings();
    const muted = settings.alerts.muteLowSurvival && prediction?.pNeeded != null && prediction.pNeeded < settings.alerts.minSurvivalProb;
    const remaining = ev.pause ? pauseRemainingSec(ev.pause, now) : null;
    const risky = ev.mode === 'PAUSED' && remaining !== null && prediction?.medianMs != null && prediction.medianMs / 1000 > remaining;
    const arb: ActiveArb = {
      id: randomUUID(),
      eventId: ev.id,
      market,
      combo,
      mode: ev.mode,
      legs,
      margin,
      prevMargin: null,
      maxMargin: margin,
      marginAtDetection: margin,
      // životnost se měří v čase detekce – razítka dat různých sázkovek nejsou srovnatelná (CDN cache);
      // v live od prvního okamžiku kandidáta (potvrzovací okno se do životnosti počítá)
      firstSeen: since ?? now,
      lastSeen: now,
      detectedAt: now,
      prediction,
      muted,
      risky,
      isSim: ev.isSim,
      eventAtDetection: structuredClone(ev),
      stakes: this.stakesFor(legs),
      lastTickAt: now,
    };
    this.active.set(arb.id, arb);
    const key = `${ev.id}|${market}`;
    let set = this.byKey.get(key);
    if (!set) this.byKey.set(key, (set = new Set()));
    set.add(arb.id);
    this.stats.created++;
    const dto = this.toDTO(arb);
    this.deps.persistNew(arb, dto);
    this.deps.persistTick(arb);
    this.deps.emit('new', arb, dto, dataAt);
  }

  end(arb: ActiveArb, reason: EndReason, bk: BookmakerId | undefined, at: number): void {
    if (!this.active.has(arb.id)) return;
    arb.endReason = reason;
    arb.endBookmaker = bk;
    // zánik = okamžik, kdy ho detektor zjistil (at = čas dat, jen pro informaci)
    void at;
    arb.endedAt = Math.max(arb.firstSeen, this.deps.now());
    this.active.delete(arb.id);
    this.byKey.get(`${arb.eventId}|${arb.market}`)?.delete(arb.id);
    this.stats.ended++;
    this.deps.persistEnd(arb);
    this.deps.emit('end', arb, this.toDTO(arb), at);
  }

  /** Ukončení všech aktivních arbů (vypnutí služby) – cenzurováno jako system_restart. */
  shutdown(): void {
    const now = this.deps.now();
    for (const arb of [...this.active.values()]) this.end(arb, 'system_restart', undefined, now);
  }

  toDTO(arb: ActiveArb): ArbDTO {
    const ev = this.events.get(arb.eventId) ?? arb.eventAtDetection;
    const now = this.deps.now();
    const p = parseMarketKey(arb.market);
    const plan = arb.stakes;
    return {
      id: arb.id,
      mode: arb.mode,
      sport: ev.sport,
      competition: ev.competition,
      eventId: ev.id,
      eventName: `${ev.home} – ${ev.away}`,
      home: ev.home,
      away: ev.away,
      startTime: ev.startTime,
      market: arb.market,
      marketLabel: marketLabel(arb.market, ev.sport),
      marketType: p.type,
      line: p.line ?? null,
      legs: arb.legs.map((l, i) => ({
        bookmaker: l.bookmaker,
        selection: l.selection,
        selectionLabel: selectionLabel(l.selection, p.type),
        odds: l.odds,
        effOdds: l.effOdds,
        stake: plan.stakes[i] ?? 0,
        payout: Math.round((plan.stakes[i] ?? 0) * l.effOdds * 100) / 100,
        changedAt: l.changedAt,
        seenAt: l.seenAt,
        swapped: l.swapped,
        sourceEventId: l.sourceEventId,
        url: l.url,
      })),
      margin: round3(arb.margin),
      prevMargin: arb.prevMargin === null ? null : round3(arb.prevMargin),
      maxMargin: round3(arb.maxMargin),
      marginAtDetection: round3(arb.marginAtDetection),
      firstSeen: arb.firstSeen,
      lastSeen: arb.endedAt ?? arb.lastSeen,
      bankroll: plan.bankroll,
      totalStake: plan.total,
      minProfit: plan.minProfit,
      positive: plan.positive,
      prediction: arb.prediction,
      muted: arb.muted,
      risky: arb.risky,
      pause: ev.pause ? { ...ev.pause, remainingSec: Math.round(pauseRemainingSec(ev.pause, now)) } : undefined,
      state: ev.state,
      timeToStartSec: ev.startTime > now ? Math.round((ev.startTime - now) / 1000) : null,
      isSim: arb.isSim,
      endReason: arb.endReason,
      endedAt: arb.endedAt,
    };
  }
}

/** Data všech noh jsou novější než poslední změna kurzu kterékoli nohy (changedAt ≤ seenAt vždy platí). */
export function legsInSync(legs: Pick<LegState, 'changedAt' | 'seenAt'>[]): boolean {
  const lastChange = Math.max(...legs.map((l) => l.changedAt));
  return legs.every((l) => l.seenAt >= lastChange);
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/** Důvod ukončení arbů při změně stavu události. */
export function transitionReason(prev: EventView, next: EventView): EndReason | null {
  if (next.finished && !prev.finished) return 'event_finished';
  if (prev.mode === next.mode) return null;
  if (prev.mode === 'PREMATCH') return 'event_started';
  if (prev.mode === 'PAUSED' && next.mode === 'LIVE') return 'pause_ended';
  if (prev.mode === 'LIVE' && next.mode === 'PAUSED') return 'pause_started';
  if (next.mode === 'PREMATCH') return 'event_finished';
  return null;
}
