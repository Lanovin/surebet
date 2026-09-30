// Sazka / Allwyn – URL a volání interního OpenBet REST API (apigw.allwyn.cz, Azure APIM).
// Klíč Ocp-Apim-Subscription-Key je veřejně v HTML webu (appSettings["Integrations:SAG:SubscriptionKey"]).
import type { Sport } from '../../core/types.js';
import { StrategyError } from '../types.js';
import type { ObEvent, ObEventsResponse } from './parse.js';
import { SPORT_NODES } from './parse.js';

export const API_BASE = 'https://apigw.allwyn.cz/openbet';
export const SUBSCRIPTION_KEY = '6fdc6e24bfcb438bac06efb0f1488534';
export const WS_URL = 'wss://ob-push-engage-prod.allwyn.cz/websock';
export const ORIGIN = 'https://www.allwyn.cz';

export const API_HEADERS: Record<string, string> = {
  'Ocp-Apim-Subscription-Key': SUBSCRIPTION_KEY,
  'X-Accept-Language': 'cs-CZ',
  'x-ob-channel': 'I',
};
/** Hlavičky, které posílá prohlížeč (pro Node fetch je přidáváme ručně). */
export const HTTP_HEADERS: Record<string, string> = { ...API_HEADERS, origin: ORIGIN, referer: `${ORIGIN}/` };

/**
 * Listing událostí sportu s hlavními trhy (CUSTOM_GROUP = to, co web ukazuje v přehledu).
 * Pro fotbal navíc skupina DRAW_NO_BET (sázka bez remízy).
 */
export function listingUrl(sports: Sport[], scope: 'prematch' | 'live', bust = scope === 'live'): string {
  const p = new URLSearchParams();
  p.set('drilldownTagIds', sports.map((s) => SPORT_NODES[s].id).join(','));
  if (scope === 'live') p.set('liveNowOrSoon', 'true');
  else p.set('eventState', 'OPEN_EVENT');
  if (scope === 'prematch' && sports.length === 1 && sports[0] === 'football') {
    p.set('marketGroupTypesIncluded', 'CUSTOM_GROUP,DRAW_NO_BET');
    p.set('marketsSortsIncluded', 'MR,HL,--,DC,DN');
  }
  if (bust) p.set('_', String(Date.now()));
  return `${API_BASE}/orchestrations/sazkaEventsDrilldownList?${p.toString().replace(/%2C/g, ',')}`;
}

/**
 * Detail (všechny trhy) pro více událostí najednou – eventIds oddělené čárkou.
 * `bust`: cache za Akamai (server-timing "cdn-cache; desc=MISS", přesto X-Created-At až ~90 s
 * staré) drží odpovědi podle URL na více uzlech s různým stářím – dva po sobě jdoucí požadavky
 * mohou vrátit data 87 s a 17 s stará (nemonotónně). Request hlavička Cache-Control se ignoruje →
 * `_=<ms>` (live vždy, prematch standardně taky – viz SazkaOptions.prematchCacheBust).
 */
export function detailUrl(ids: string[], bust = false): string {
  return `${API_BASE}/orchestrations/sazkaEventsDrilldownDetail?eventIds=${ids.join(',')}${bust ? `&_=${Date.now()}` : ''}`;
}

export const HEALTH_URL = `${API_BASE}/content-service/q/sazka-sports?eventState=LIVE_EVENT`;

/** Abstrakce transportu: Node fetch (ctx.http) nebo fetch uvnitř stránky (ctx.browser). */
export type Transport = (
  url: string,
  timeoutMs: number,
) => Promise<{ status: number; body: unknown; bytes: number; /** X-Created-At (epoch ms), když je k dispozici */ createdAt?: number }>;

export interface CallStats {
  requests: number;
  bytes: number;
  /** Nejstarší X-Created-At ze všech odpovědí (= skutečné stáří dat). */
  oldest?: number;
}

export async function getEvents(t: Transport, url: string, timeoutMs: number, stats?: CallStats): Promise<ObEvent[]> {
  const r = await t(url, timeoutMs);
  if (stats) {
    stats.requests++;
    stats.bytes += r.bytes;
    if (r.createdAt && (!stats.oldest || r.createdAt < stats.oldest)) stats.oldest = r.createdAt;
  }
  const body = r.body as ObEventsResponse;
  if (r.status !== 200 || !body || typeof body !== 'object') {
    throw new StrategyError(`sazka API HTTP ${r.status}`, r.status === 403 || r.status === 429 ? 'blocked' : 'http', {
      status: r.status,
      url,
      sample: JSON.stringify(body)?.slice(0, 300),
    });
  }
  if (!body.data || !Array.isArray(body.data.events)) {
    throw new StrategyError('sazka API: unexpected structure (data.events missing)', 'structure', {
      url,
      sample: JSON.stringify(body).slice(0, 300),
    });
  }
  return body.data.events;
}

export function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
