// Sdílená platforma skupiny Tipsport (Tipsport.cz, Chance.cz – stejný Next.js frontend, stejné /rest API,
// stejná Cloudflare konfigurace). Chance adaptér importuje odsud.
//
// STAV: Playwright Chromium a plain HTTP blokuje Cloudflare bot management (403 „Chyba“, ID C1-<ray>),
// detaily v docs/bookmakers/tipsport.md. Funkční cesta je L5 strategie v Camoufoxu přes camoufox-bridge
// (common/camoufox-replay.ts) se známými /rest endpointy (fetch uvnitř stránky, viz platformTargets).
// Zapnuto pro značky v CAMOUFOX_BRANDS; detectBlock/probeAccess zůstávají pro diagnostiku.
import type { FeedScope, HealthResult } from '../../core/types.js';
import type { HttpClient } from '../http.js';
import type { Adapter, AdapterContext } from '../types.js';
import { CamoufoxReplayStrategy, type KnownTarget } from '../common/camoufox-replay.js';
import { parseTipsport, SUPERSPORT_IDS } from './parse.js';

export type PlatformBrand = 'tipsport' | 'chance';

export interface BrandConfig {
  bookmaker: PlatformBrand;
  origin: string;
  /** Hodnota hlavičky x-nextjs-brandsite, kterou vrací origin. */
  brandSite: string;
}

export const BRANDS: Record<PlatformBrand, BrandConfig> = {
  tipsport: { bookmaker: 'tipsport', origin: 'https://www.tipsport.cz', brandSite: 'TIPSPORT_CZ' },
  chance: { bookmaker: 'chance', origin: 'https://www.chance.cz', brandSite: 'CHANCE' },
};

/** Endpoint, který web volá jako první při načtení nabídky – slouží jako sonda přístupu k /rest. */
export const PROBE_PATH = '/rest/offer/v6/sports';

export interface BlockInfo {
  blocked: boolean;
  /** waf-block = vlastní chybová stránka Tipsportu za Cloudflare WAF; cf-challenge = interaktivní výzva CF. */
  kind?: 'waf-block' | 'cf-challenge';
  /** Ray ID z chybové stránky (bez prefixu C1-) – pro případnou reklamaci/diagnostiku. */
  rayId?: string;
}

/** Pozná blokaci z odpovědi (čistá funkce). */
export function detectBlock(status: number, body: string, headers?: { get(name: string): string | null }): BlockInfo {
  if (headers?.get('cf-mitigated') === 'challenge' || /<title>Just a moment\.\.\.<\/title>/i.test(body)) {
    return { blocked: true, kind: 'cf-challenge' };
  }
  const errorPage = /<title>Chyba<\/title>/.test(body) || body.includes('__ts_page_type=`error`');
  if (status === 403 && errorPage) {
    const ray = /C1-([0-9a-f]{16})/.exec(body)?.[1];
    return { blocked: true, kind: 'waf-block', rayId: ray };
  }
  return { blocked: false };
}

/** Jeden levný GET na /rest sondu; ok=true znamená, že JSON API je z tohoto klienta dostupné. */
export async function probeAccess(http: HttpClient, brand: PlatformBrand): Promise<HealthResult> {
  const url = BRANDS[brand].origin + PROBE_PATH;
  const t0 = performance.now();
  try {
    const r = await http.text(url, { allowStatus: [403, 429, 503], timeoutMs: 10_000 });
    const latencyMs = Math.round(performance.now() - t0);
    const b = detectBlock(r.status, r.body, r.headers);
    if (b.blocked) {
      return { ok: false, latencyMs, httpStatus: r.status, message: `${b.kind} (ray ${b.rayId ?? r.headers.get('cf-ray') ?? '?'})` };
    }
    const json = (r.headers.get('content-type') ?? '').includes('json');
    return { ok: r.status === 200 && json, latencyMs, httpStatus: r.status, message: json ? 'rest reachable' : 'unexpected response' };
  } catch (e) {
    return { ok: false, latencyMs: Math.round(performance.now() - t0), message: String((e as Error)?.message ?? e) };
  }
}

/** Značky, pro které je zapnutá Camoufox strategie (camoufox-bridge). */
export const CAMOUFOX_BRANDS: readonly PlatformBrand[] = ['tipsport', 'chance'];

/** Celá nabídka superSportu jedním požadavkem (limit 1000 = bez stránkování; fotbal ~750 zápasů, ~1,3 MB). */
export const OFFER_LIMIT = 1000;

const JSON_HEADERS = { accept: 'application/json', 'content-type': 'application/json;charset=utf-8' };

/**
 * Známé endpointy (ověřeno na tipsport.cz 2026-10-01, Chance má stejné /rest API):
 *  * prematch: POST /rest/offer/v2/offer pro každý superSport z SUPERSPORT_IDS (výchozí záložka „Zápas“)
 *  * live: in-play entity (zápasy) + kurzy po skupinách, parser je spojí
 */
export function platformTargets(origin: string, scope: FeedScope): KnownTarget[] {
  if (scope === 'live') {
    return [
      {
        url: `${origin}/rest/offer/v1/live/in-play/entities`,
        parts: [
          { name: 'entities', url: `${origin}/rest/offer/v1/live/in-play/entities`, headers: { accept: 'application/json' } },
          { name: 'odds', url: `${origin}/rest/offer/v1/live/in-play/event-groups/odds`, headers: { accept: 'application/json' } },
        ],
      },
    ];
  }
  return Object.entries(SUPERSPORT_IDS).map(([id, sport]) => ({
    url: `${origin}/rest/offer/v2/offer?limit=${OFFER_LIMIT}`,
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      results: false,
      highlightAnyTime: false,
      limit: OFFER_LIMIT,
      order: 'DATESTART',
      type: 'SUPERSPORT',
      id: Number(id),
      matchViewFilters: [],
      withLive: false,
    }),
    sport,
  }));
}

/** Adaptér platformy: Camoufox strategie pro CAMOUFOX_BRANDS, jinak bez strategií (blokováno). */
export function createPlatformAdapter(brand: PlatformBrand, ctx: AdapterContext): Adapter {
  if (!CAMOUFOX_BRANDS.includes(brand)) {
    ctx.log.warn(`${brand}: no working strategy – Cloudflare bot management blocks automated clients, see docs/bookmakers/${brand}.md`);
    return { bookmaker: brand, strategies: [] };
  }
  const { origin } = BRANDS[brand];
  return {
    bookmaker: brand,
    strategies: [
      new CamoufoxReplayStrategy(
        {
          bookmaker: brand,
          origin,
          targets: (scope) => platformTargets(origin, scope),
          match: /\/rest\/(offer|common)\//,
          idlePath: '/robots.txt',
          parse: parseTipsport,
          isBlocked: (status, body) => detectBlock(status, body).blocked,
        },
        ctx,
      ),
    ],
  };
}
