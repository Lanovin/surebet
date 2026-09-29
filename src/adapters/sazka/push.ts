// OpenBet push (wss://ob-push-engage-prod.allwyn.cz/websock, subprotokol "v1.push.openbet.com").
// Textový protokol (z bundlu webu Sazky, anonymní host funguje bez tokenu):
//   connect      "C" + "02" + "P" + len(token,4) + token          → host: "C02P0000"
//   subscribe    "S" + count(4) + channels + "!!!!!!!!!!"          kanál = typ(6) + "="*16 + id(10)
//   unsubscribe  "U" + count(4) + channels
//   ping/pong    "p0001" / "g0001" (web posílá ping každých 15 s)
//   zpráva       "M" + kanál(32) + msgId(10) + user("G" | "U"+10) + subjekt(typ 6 + id 10) + size(12) + JSON
// Kanál SEVENT<id> = událost i se všemi potomky (trhy, výběry, ceny, hodiny, skóre).
// Subjekty: sPRICE (id výběru), sSELCN (výběr), sEVMKT (trh), sEVENT/sEVALL (událost),
//           sCLOCK / sSCORE (id události), sMHCAP, sSTATS, sEPPNT, sPTURN (ignorujeme).
// sCLOCK: {period_code, period_index, state R|C|S (běží / odpočet běží / stojí), offset, last_update};
//         period_code "ALL" = hodiny celého zápasu; nová perioda (HALF_TIME…) → REST resync.
import type { ObEvent, ObMarket, ObOutcome, ObPeriod } from './parse.js';

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

/** Desetinný kurz z push těla: potentialPayout WIN, jinak zlomek lp_num/lp_den. */
export function pushDecimal(b: Record<string, unknown>): number | undefined {
  const pp = b.potentialPayout as { winPlaceOverrideRef?: string; value?: string }[] | undefined;
  const win = pp?.find((p) => p.winPlaceOverrideRef === 'WIN')?.value;
  const v = win !== undefined ? Number(win) : NaN;
  if (Number.isFinite(v) && v > 1) return v;
  const num = Number(b.lp_num);
  const den = Number(b.lp_den);
  if (Number.isFinite(num) && Number.isFinite(den) && den > 0 && b.lp_num !== '') return Math.round((1 + num / den) * 1000) / 1000;
  return undefined;
}

const statusOf = (s: unknown) => (s === 'A' ? 'ACTIVE' : s === 'S' ? 'SUSPENDED' : undefined);

export interface ApplyResult {
  /** Stav se změnil (je co emitovat). */
  changed: boolean;
  /** Zpráva odkazuje na něco, co ve snapshotu nemáme → je potřeba znovu stáhnout detail události. */
  resync?: string;
}

function findMarket(ev: ObEvent, id: string): ObMarket | undefined {
  return ev.markets?.find((m) => String(m.id) === id);
}
function findOutcome(m: ObMarket | undefined, id: string): ObOutcome | undefined {
  return m?.outcomes.find((o) => String(o.id) === id);
}

/** Aplikuje push zprávu na snapshot událostí (mutuje). */
export function applyMessage(events: Map<string, ObEvent>, msg: PushMessage): ApplyResult {
  const b = msg.body;
  const evId = String(b.ev_id ?? msg.channelId);
  const ev = events.get(evId);
  if (!ev) return { changed: false };
  switch (msg.subjectType) {
    case 'sPRICE': {
      const o = findOutcome(findMarket(ev, String(b.ev_mkt_id)), msg.subjectId);
      const d = pushDecimal(b);
      if (!o) return { changed: false, resync: evId };
      if (d === undefined) return { changed: false };
      o.prices = [{ ...(o.prices?.[0] ?? {}), decimal: d }];
      return { changed: true };
    }
    case 'sSELCN': {
      const o = findOutcome(findMarket(ev, String(b.ev_mkt_id)), msg.subjectId);
      if (!o) return { changed: false, resync: evId };
      const st = statusOf(b.status);
      if (st) o.status = st;
      if (b.displayed === 'Y' || b.displayed === 'N') o.displayed = b.displayed === 'Y';
      const d = pushDecimal(b);
      if (d !== undefined) o.prices = [{ ...(o.prices?.[0] ?? {}), decimal: d }];
      return { changed: true };
    }
    case 'sEVMKT': {
      const m = findMarket(ev, msg.subjectId);
      if (!m) return b.displayed === 'N' ? { changed: false } : { changed: false, resync: evId };
      const st = statusOf(b.status);
      if (st) m.status = st;
      if (b.displayed === 'Y' || b.displayed === 'N') m.displayed = b.displayed === 'Y';
      const names = b.names as Record<string, string> | undefined;
      if (names?.cs && names.cs !== m.name) {
        // změna názvu = typicky posun linie → bezpečnější znovu načíst celý trh
        m.name = names.cs;
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
    case 'sSCORE':
    case 'sEVENT':
    case 'sEVALL':
      // formát těla nemáme ověřený → spolehlivější je dotáhnout detail události přes REST
      return { changed: false, resync: evId };
    default:
      return { changed: false };
  }
}
