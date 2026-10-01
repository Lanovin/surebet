// Klient pro camoufox-bridge (Python sidecar, viz camoufox-bridge/README.md).
// Stejná primitiva jako BrowserPool (capture / fetchInPage), jen běží v Camoufoxu (Firefox),
// který Cloudflare JS detekce u Betana a Tipsportu nepozná jako automatizaci tak snadno jako Chromium.
import type { BookmakerId } from '../core/types.js';
import { StrategyError } from './types.js';

export interface BridgeResponse {
  url: string;
  status: number;
  body: string;
  json?: unknown;
  /** Požadavek, kterým si stránka odpověď vyžádala (pro replay přes fetchInPage). */
  method?: string;
  postData?: string | null;
  requestHeaders?: Record<string, string>;
}

export interface BridgeCaptureResult {
  responses: BridgeResponse[];
  navStatus: number | null;
  title: string;
  pageUrl: string;
  /** Heuristika bridge: titul blokační stránky nebo 403 na dokument. */
  blocked: boolean;
}

export interface BridgeCaptureOptions {
  url?: string;
  /** Regex nad URL odpovědi (posílá se jako .source, flagy se ignorují). */
  match: RegExp;
  timeoutMs?: number;
  minResponses?: number;
  settleMs?: number;
  reload?: boolean;
}

export interface BridgeFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  credentials?: 'include' | 'omit' | 'same-origin';
  /**
   * Po prvním otevření originu (Cloudflare JS nastaví cookies) přejít na lehký dokument stejného originu
   * (např. /robots.txt) – web sázkovky pak v prohlížeči neběží a stránka drží jen stovky kB místo stovek MB.
   */
  idlePath?: string;
}

export class CamoufoxBridge {
  constructor(readonly baseUrl: string = process.env.CAMOUFOX_URL ?? 'http://127.0.0.1:8765') {}

  private async call<T>(path: string, body: unknown | undefined, timeoutMs: number): Promise<T> {
    let r: Response;
    try {
      r = await fetch(this.baseUrl + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new StrategyError(`camoufox bridge nedostupný (${this.baseUrl}${path}): ${(e as Error).message}`, 'other');
    }
    const text = await r.text();
    if (!r.ok) throw new StrategyError(`camoufox bridge ${path} → ${r.status}: ${text.slice(0, 300)}`, 'other');
    return JSON.parse(text) as T;
  }

  async capture(bk: BookmakerId, o: BridgeCaptureOptions): Promise<BridgeCaptureResult> {
    const timeoutMs = o.timeoutMs ?? 30_000;
    const res = await this.call<BridgeCaptureResult>(
      '/capture',
      { bk, url: o.url, match: o.match.source, reload: o.reload, timeoutMs, minResponses: o.minResponses, settleMs: o.settleMs },
      timeoutMs + (o.settleMs ?? 0) + 30_000,
    );
    for (const x of res.responses) {
      try {
        x.json = JSON.parse(x.body);
      } catch {
        /* ne-JSON */
      }
    }
    return res;
  }

  /** fetch() uvnitř stránky dané sázkovky (same-origin cookies + otisk prohlížeče). `url` může být i cesta. */
  async fetchInPage(
    bk: BookmakerId,
    origin: string,
    url: string,
    init: BridgeFetchInit = {},
  ): Promise<{ status: number; contentType: string | null; body: string }> {
    // první fetch otevírá origin: 2× goto (45 s) + load (15 s) + settle (4 s) + fetch (45 s v bridge.py)
    return this.call('/fetch', { bk, origin, url, ...init }, 180_000);
  }

  /** Zavře stránku sázkovky; bez `bk` celý prohlížeč (čistá session, nový fingerprint). */
  async close(bk?: BookmakerId): Promise<void> {
    await this.call('/close', bk ? { bk } : {}, 30_000);
  }

  async health(): Promise<{ running: boolean; pages: string[] }> {
    return this.call('/health', undefined, 5_000);
  }
}

/** Sdílená instance pro strategie. */
export const camoufox = new CamoufoxBridge();