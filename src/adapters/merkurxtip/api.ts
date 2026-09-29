// MerkurXtip – Altenar widget API (sb2frontend-altenar2.biahosted.com), veřejné, bez klíče.
// Integrace "merkurxtip" vrací i oryx websocket webu ("open-sportsbook" → extras.integration).
import type { Sport } from '../../core/types.js';
import { StrategyError } from '../types.js';
import { SPORT_IDS } from './parse.js';

export const API = 'https://sb2frontend-altenar2.biahosted.com/api/widget';
export const ORIGIN = 'https://www.merkurxtip.cz';
export const COMMON = 'culture=cs-CZ&timezoneOffset=-120&integration=merkurxtip&deviceType=1&numFormat=en-GB&countryCode=CZ';
export const HTTP_HEADERS: Record<string, string> = { origin: ORIGIN, referer: `${ORIGIN}/` };

/** Prematch: všechny zápasy sportu (~1 měsíc dopředu) s hlavními trhy. */
export const eventsUrl = (sport: Sport) => `${API}/GetEvents?${COMMON}&sportId=${SPORT_IDS[sport]}`;
/** Live: běžící zápasy sportu s hlavními trhy + stav (ls, score, timer). */
export const liveUrl = (sport: Sport) => `${API}/GetLiveEvents?${COMMON}&sportId=${SPORT_IDS[sport]}`;
/** Live přehled: počty živých zápasů po sportech (liveSports) + události prvního sportu. */
export const liveOverviewUrl = () => `${API}/GetLiveOverview?${COMMON}&sportId=0`;
/** Detail jedné události – všechny trhy a linie. */
export const detailUrl = (eventId: number | string) => `${API}/GetEventDetails?${COMMON}&eventId=${eventId}`;
export const HEALTH_URL = `${API}/GetInfo?${COMMON}`;

/** Transport: Node fetch nebo fetch uvnitř stránky. `ageMs` = stáří z CDN cache (hlavička Age). */
export type Transport = (url: string, timeoutMs: number) => Promise<{ status: number; body: unknown; bytes: number; ageMs?: number }>;

export interface CallStats {
  requests: number;
  bytes: number;
  /** Nejstarší okamžik vzniku dat (now − Age) přes všechny odpovědi. */
  oldest?: number;
}

export async function getJson<T>(t: Transport, url: string, timeoutMs: number, stats?: CallStats): Promise<T> {
  const started = Date.now();
  const r = await t(url, timeoutMs);
  if (stats) {
    stats.requests++;
    stats.bytes += r.bytes;
    const born = started - (r.ageMs ?? 0);
    if (!stats.oldest || born < stats.oldest) stats.oldest = born;
  }
  if (r.status !== 200 || r.body == null || typeof r.body !== 'object') {
    throw new StrategyError(`merkurxtip API HTTP ${r.status}`, r.status === 403 || r.status === 429 ? 'blocked' : 'http', {
      status: r.status,
      url,
      sample: JSON.stringify(r.body)?.slice(0, 300),
    });
  }
  return r.body as T;
}
