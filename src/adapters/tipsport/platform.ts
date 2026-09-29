// Sdílená platforma skupiny Tipsport (Tipsport.cz, Chance.cz – stejný Next.js frontend, stejné /rest API,
// stejná Cloudflare konfigurace). Chance adaptér importuje odsud.
//
// STAV (2026-09-28): žádná povolená strategie nefunguje. Cloudflare bot management vrací 403 („Chyba“,
// ID C1-<ray>): curl/Node fetch hned (otisk klienta), headless Chrome projde jen prvním HTML dokumentem
// (SSR bez kurzů) a /rest/common/v1/init-web – jakmile doběhne CF JS detekce, jsou všechna /rest/offer/*
// i další dokumenty 403 (profil „spálený“ i s cf_clearance). Projít by šlo jen skrytím automatizace
// (stealth), což projekt zakazuje. Detaily a postup opravy: docs/bookmakers/tipsport.md.
// Proto adaptér zatím nevrací žádné strategie; tento modul drží jen konfiguraci značek a diagnostiku bloku,
// aby šel přístup levně ověřit (probeAccess) a strategie doplnit, až bude z čeho nahrát fixtures.
import type { HealthResult } from '../../core/types.js';
import type { HttpClient } from '../http.js';
import type { Adapter, AdapterContext } from '../types.js';

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

/** Adaptér platformy. Strategie jsou prázdné, dokud nebude přístup (viz hlavička souboru). */
export function createPlatformAdapter(brand: PlatformBrand, ctx: AdapterContext): Adapter {
  ctx.log.warn(`${brand}: no working strategy – Cloudflare bot management blocks automated clients, see docs/bookmakers/${brand}.md`);
  return { bookmaker: brand, strategies: [] };
}
