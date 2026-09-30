// OpenBet push (wss://ob-push-engage-prod.allwyn.cz/websock, subprotokol "v1.push.openbet.com").
// Textový protokol (z bundlu webu Sazky, anonymní host funguje bez tokenu):
//   connect      "C" + "02" + "P" + len(token,4) + token          → host: "C02P0000"
//   subscribe    "S" + count(4) + channels + "!!!!!!!!!!"          kanál = typ(6) + "="*16 + id(10)
//   unsubscribe  "U" + count(4) + channels
//   ping/pong    "p0001" / "g0001" (web posílá ping každých 15 s)
//   zpráva       "M" + kanál(32) + msgId(10) + user("G" | "U"+10) + subjekt(typ 6 + id 10) + size(12) + JSON
// Kanál SEVENT<id> = událost i se všemi potomky (trhy, výběry, ceny, hodiny, skóre).
// Subjekty: sPRICE (id výběru), sSELCN (výběr), sEVMKT (trh; mkt_code = groupCode), sEVENT/sEVALL (událost),
//           sCLOCK / sSCORE (id události), sMHCAP, sSTATS, sEPPNT, sPTURN (ignorujeme).
// sCLOCK: {period_code, period_index, state R|C|S (běží / odpočet běží / stojí), offset, last_update};
//         period_code "ALL" = hodiny celého zápasu; nová perioda (HALF_TIME…) → REST resync.
import type { ObEvent, ObMarket, ObOutcome, ObPeriod } from './parse.js';
import { eventSport, isMappedMarketCode } from './parse.js';

const pad = (n: number | string, w: number) => String(n).padStart(w, '0');

export const encodeConnect = (token = ''): string => `C02P${pad(token.length, 4)}${token}`;
export const encodeChannel = (type: string, id: string | number): string => `${type}${'='.repeat(16)}${pad(id, 10)}`;
export const encodeSubscribe = (eventIds: (string | number)[]): string =>
  `S${pad(eventIds.length, 4)}${eventIds.map((id) => encodeChannel('SEVENT', id)).join('')}!!!!!!!!!!`;
export const encodeUnsubscribe = (eventIds: (string | number)[]): string =>
  `U${pad(eventIds.length, 4)}${eventIds.map((id) => encodeChannel('SEVENT', id)).join('')}`;
export const encodePing = (id: number): string => `p${pad(id % 10000, 4)}`;

export interface PushMessage {
  channelType: string;
  channelId: string;
  messageId: string;
  subjectType: string;
  subjectId: string;
  body: Record<string, unknown>;
}

/** Dekóduje jednu zprávu "M…"; ostatní (pong "g…") vrací null. */
export function decodeMessage(s: string): PushMessage | null {
  if (s[0] !== 'M' || s.length < 73) return null;
  const channel = s.slice(1, 33);
  const off = s[43] === 'U' ? 10 : 0;
  const subject = s.slice(44 + off, 60 + off);
  const json = s.slice(72 + off);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
  return {
    channelType: channel.slice(0, 6),
    channelId: String(Number(channel.slice(22))),
    messageId: s.slice(33, 43),
    subjectType: subject.slice(0, 6),
    subjectId: String(Number(subject.slice(6))),
    body,
  };
}

/**
 * Desetinný kurz z push těla: potentialPayout WIN, jinak zlomek lp_num/lp_den. Zaokrouhlení dolů na
 * 2 desetinná místa = konvence REST (`prices[].decimal`): kurzový žebříček Sazky je ve zlomcích, které
 * dávají přesně 2 desetinná místa (83/100 → 1.83); liší se jen kurzy pod 1.01 (1/125: push 1.008,
 * REST 1) – ty stejně zahodí validace. Ověřeno na 133 tis. push cenách a 8 tis. REST výběrech.
 */
export function pushDecimal(b: Record<string, unknown>): number | undefined {
  const pp = b.potentialPayout as { winPlaceOverrideRef?: string; value?: string }[] | undefined;
  const win = pp?.find((p) => p.winPlaceOverrideRef === 'WIN')?.value;
  let v = win !== undefined ? Number(win) : NaN;
  if (!(Number.isFinite(v) && v > 1)) {
    const num = Number(b.lp_num);
    const den = Number(b.lp_den);
    v = Number.isFinite(num) && Number.isFinite(den) && den > 0 && b.lp_num !== '' ? 1 + num / den : NaN;
  }
  if (!Number.isFinite(v) || v <= 1) return undefined;
  return Math.floor(v * 100 + 1e-6) / 100;
}

const statusOf = (s: unknown) => (s === 'A' ? 'ACTIVE' : s === 'S' ? 'SUSPENDED' : undefined);

export interface ApplyResult {
  /** Stav se změnil (je co emitovat). */
  changed: boolean;
  /** Zpráva odkazuje na něco, co ve snapshotu nemáme → je potřeba znovu stáhnout detail události. */
  resync?: string;
}

export interface ApplyContext {
  /**
   * ID trhů, které nemapujeme (groupCode bez pravidla, z sEVMKT) – ceny/výběry k nim nevyžadují
   * REST resync. Bez toho je "dirty" skoro každý zápas (nové linie gemů/bodů každých pár sekund).
   */
  ignored?: Set<string>;
}

/**
 * Trh je u nás suspendovaný, ale chodí mu ceny/výběry → mohl být znovuotevřen bez sEVMKT st=A
 * (30. 9. pozorováno: "Oba dají gól" suspendovaný po gólu, ostatní trhy dostaly st=A, tenhle ne,
 * ceny chodily dál a REST ho měl ACTIVE) → ověřit REST detailem (resync je dávkovaný á ≥ 2 s).
 */
function silentReopen(ev: ObEvent, m: ObMarket, evId: string): { resync?: string } {
  if (m.status !== 'SUSPENDED' && m.active !== false) return {};
  const sport = eventSport(ev);
  return sport && isMappedMarketCode(sport, m.groupCode) ? { resync: evId } : {};
}

function findMarket(ev: ObEvent, id: string): ObMarket | undefined {
  return ev.markets?.find((m) => String(m.id) === id);
}
function findOutcome(m: ObMarket | undefined, id: string): ObOutcome | undefined {
  return m?.outcomes.find((o) => String(o.id) === id);
}

/**
 * Aplikuje push zprávu na snapshot událostí (mutuje).
 * `active` (REST: efektivní stav vč. rodiče – suspendovaný trh má active=false i u výběrů) se
 * udržuje spolu se `status`, jinak by trh suspendovaný v REST snapshotu zůstal po push
 * znovuotevření navždy zavřený (a naopak parser by viděl nekonzistentní stav).
 */
export function applyMessage(events: Map<string, ObEvent>, msg: PushMessage, ctx: ApplyContext = {}): ApplyResult {
  const b = msg.body;
  const evId = String(b.ev_id ?? msg.channelId);
  const ev = events.get(evId);
  if (!ev) return { changed: false };
  const unknownMarket = (mktId: string): ApplyResult => (ctx.ignored?.has(mktId) ? { changed: false } : { changed: false, resync: evId });
  switch (msg.subjectType) {
    case 'sPRICE': {
      const mktId = String(b.ev_mkt_id);
      const m = findMarket(ev, mktId);
      if (!m) return unknownMarket(mktId);
      const o = findOutcome(m, msg.subjectId);
      if (!o) return { changed: false, resync: evId };
      const d = pushDecimal(b);
      if (d === undefined) return { changed: false };
      o.prices = [{ ...(o.prices?.[0] ?? {}), decimal: d }];
      return { changed: true, ...silentReopen(ev, m, evId) };
    }
    case 'sSELCN': {
      const mktId = String(b.ev_mkt_id);
      const m = findMarket(ev, mktId);
      if (!m) return b.displayed === 'N' ? { changed: false } : unknownMarket(mktId);
      const o = findOutcome(m, msg.subjectId);
      // skrytý výběr, který REST neposlal (REST vrací jen zobrazené výběry) → nic k aktualizaci
      if (!o) return b.displayed === 'N' ? { changed: false } : { changed: false, resync: evId };
      const st = statusOf(b.status);
      if (st) o.status = st;
      o.active = o.status !== 'SUSPENDED' && m.active !== false;
      if (b.displayed === 'Y' || b.displayed === 'N') o.displayed = b.displayed === 'Y';
      const d = pushDecimal(b);
      if (d !== undefined) o.prices = [{ ...(o.prices?.[0] ?? {}), decimal: d }];
      return { changed: true, ...silentReopen(ev, m, evId) };
    }
    case 'sEVMKT': {
      const m = findMarket(ev, msg.subjectId);
      if (!m) {
        if (b.displayed === 'N') return { changed: false };
        const sport = eventSport(ev);
        if (sport && typeof b.mkt_code === 'string' && !isMappedMarketCode(sport, b.mkt_code)) {
          ctx.ignored?.add(msg.subjectId);
          return { changed: false };
        }
        return { changed: false, resync: evId };
      }
      const st = statusOf(b.status);
      if (st) m.status = st;
      if (st || b.bet_in_run === 'Y' || b.bet_in_run === 'N') {
        m.active = m.status !== 'SUSPENDED' && b.bet_in_run !== 'N';
        for (const o of m.outcomes) o.active = m.active && o.status !== 'SUSPENDED';
      }
      if (b.displayed === 'Y' || b.displayed === 'N') m.displayed = b.displayed === 'Y';
      const names = b.names as Record<string, string> | undefined;
      if (names?.cs && names.cs !== m.name) {
        // změna názvu = posun linie (výběry by měly starou linii s novými cenami) → do resyncu skrýt
        m.name = names.cs;
        m.displayed = false;
        return { changed: true, resync: evId };
      }
      return { changed: true };
    }
    case 'sCLOCK': {
      const periods = ev.commentary?.periods ?? [];
      const code = String(b.period_code ?? '');
      const idx = b.period_index == null ? null : Number(b.period_index);
      const p: ObPeriod | undefined = periods.find((x) => x.type === code && (idx == null || x.periodIndex == null || x.periodIndex === idx));
      if (!p) {
        // "ALL" = hodiny celého zápasu, tenis: hodiny gemu (vnořené periody) – ignorujeme
        if (code === 'ALL' || code === 'GAME' || code === 'POINT') return { changed: false };
        return { changed: false, resync: evId }; // nová perioda (např. začal 2. poločas)
      }
      p.clock = {
        offset: Number(b.offset ?? p.clock?.offset ?? 0),
        lastUpdate: typeof b.last_update === 'string' ? new Date(Date.parse(b.last_update.replace(/\+0000$/, 'Z'))).toISOString() : p.clock?.lastUpdate,
        // R = běží, C = odpočet běží (basket/hokej), S = stojí
        state: b.state === 'R' ? 'RUNNING' : b.state === 'C' ? 'COUNTING_DOWN' : b.state === 'S' ? 'STOPPED' : p.clock?.state,
      };
      return { changed: true };
    }
    case 'sEVENT': {
      // formát těla neověřen (za 40 min živého provozu nepřišla ani jedna) → REST detail; status
      // "S" ale aplikujeme hned (suspendovaná událost nesmí do resyncu vypadat otevřeně)
      const st = statusOf(b.status);
      if (st) {
        ev.status = st;
        ev.active = st === 'ACTIVE';
      }
      return { changed: !!st, resync: evId };
    }
    case 'sSCORE':
    case 'sEVALL':
      // formát těla nemáme ověřený → spolehlivější je dotáhnout detail události přes REST
      return { changed: false, resync: evId };
    default:
      return { changed: false };
  }
}
