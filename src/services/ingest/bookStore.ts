// Aktuální kurzy jednotlivých sázkovek v orientaci kanonických událostí + výpočet změn (diff).
import type { BookmakerId, FeedScope, RawEvent, SelectionKey } from '../../core/types.js';
import { swapMarketKey, swapSelection } from '../../core/markets.js';
import type { BookEventState, OddsChange } from '../../shared/protocol.js';

/** Jak dlouho po posledních live datech ignorovat stejný zápas z prematch feedu. */
export const LIVE_PRECEDENCE_MS = 60_000;

export interface LinkedEvent {
  eventId: number;
  swapped: boolean;
  raw: RawEvent;
}

export interface ApplyResult {
  changes: OddsChange[];
  states: Record<number, BookEventState>;
  removed: number[];
  seen: number[];
}

export class BookStore {
  private books = new Map<BookmakerId, Map<number, BookEventState>>();

  get(bk: BookmakerId): Map<number, BookEventState> {
    let m = this.books.get(bk);
    if (!m) this.books.set(bk, (m = new Map()));
    return m;
  }

  /** Kurzy ostatních sázkovek pro konsenzus. */
  othersOdds(exclude: BookmakerId, eventId: number, market: string, sel: SelectionKey): number[] {
    const out: number[] = [];
    for (const [bk, m] of this.books) {
      if (bk === exclude) continue;
      const s = m.get(eventId)?.markets[market]?.sels[sel];
      if (s?.open) out.push(s.odds);
    }
    return out;
  }

  apply(bk: BookmakerId, scope: FeedScope, fetchedAt: number, items: LinkedEvent[]): ApplyResult {
    const store = this.get(bk);
    const res: ApplyResult = { changes: [], states: {}, removed: [], seen: [] };
    const present = new Set<number>();
    for (const { eventId, swapped, raw } of items) {
      if (present.has(eventId)) continue; // dvě události sázkovky na jednu kanonickou – bereme první
      const prev = store.get(eventId);
      // zápas je zároveň v live feedu: prematch (polling po desítkách sekund, CDN cache) nesmí přepsat
      // živé kurzy ani je potvrdit jako čerstvé (seen) – live má přednost, dokud chodí
      if (scope === 'prematch' && prev?.scope === 'live' && fetchedAt - prev.seenAt < LIVE_PRECEDENCE_MS) continue;
      present.add(eventId);
      // starší data, než už máme (cache s víc uzly vrací kopie mimo pořadí) – ponechat novější stav
      if (prev && prev.scope === scope && fetchedAt < prev.seenAt) continue;
      res.seen.push(eventId);
      const next: BookEventState = { sourceEventId: raw.sourceId, swapped, scope, seenAt: fetchedAt, url: raw.url, markets: {} };
      let changed = !prev || prev.scope !== scope;
      for (const m of raw.markets) {
        const key = swapped ? swapMarketKey(m.key) : m.key;
        const pm = prev?.markets[key];
        const nm: BookEventState['markets'][string] = { open: m.open, sels: {} };
        for (const s of m.selections) {
          const sel = swapped ? swapSelection(s.key) : s.key;
          const open = m.open && s.open !== false;
          const ps = pm?.sels[sel];
          const same = ps && ps.odds === s.odds && ps.open === open;
          nm.sels[sel] = { odds: s.odds, open, changedAt: same ? ps.changedAt : fetchedAt };
          if (!same) {
            changed = true;
            res.changes.push({ eventId, market: key, sel, odds: s.odds, prev: ps?.odds ?? null, status: open ? 'open' : 'suspended' });
          }
        }
        if (pm) {
          for (const [sel, ps] of Object.entries(pm.sels) as [SelectionKey, { odds: number }][]) {
            if (!nm.sels[sel]) {
              changed = true;
              res.changes.push({ eventId, market: key, sel, odds: null, prev: ps.odds, status: 'removed' });
            }
          }
        }
        next.markets[key] = nm;
      }
      if (prev) {
        for (const [key, pm] of Object.entries(prev.markets)) {
          if (next.markets[key]) continue;
          changed = true;
          for (const [sel, ps] of Object.entries(pm.sels) as [SelectionKey, { odds: number }][])
            res.changes.push({ eventId, market: key, sel, odds: null, prev: ps.odds, status: 'removed' });
        }
      }
      store.set(eventId, next);
      if (changed) res.states[eventId] = next;
    }
    // události tohoto scope, které z nabídky zmizely
    for (const [eventId, st] of store) {
      if (st.scope !== scope || present.has(eventId)) continue;
      store.delete(eventId);
      res.removed.push(eventId);
      for (const [key, pm] of Object.entries(st.markets))
        for (const [sel, ps] of Object.entries(pm.sels) as [SelectionKey, { odds: number }][])
          res.changes.push({ eventId, market: key, sel, odds: null, prev: ps.odds, status: 'removed' });
    }
    return res;
  }
}
