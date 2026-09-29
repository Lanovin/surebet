// SYNOT TIP – interní JSON API webu sport.synottip.cz (WCF služby platformy eBet).
// Všechny volání jsou POST s JSON tělem; odpověď {Result, Token, ReturnValue}. Result 1 = OK,
// 0 = chyba (typicky neplatný/prošlý Token). Anonymní Token vrací GetLiveInitData.
// Bez hlavičky `accept: application/json` WCF odpovídá XML.
import type { Sport } from '../../core/types.js';
import { StrategyError } from '../types.js';
import { ORIGIN, SPORT_IDS } from './parse.js';

export const API = `${ORIGIN}/WebServices/Api/SportsBettingService.svc`;
export const SESSION_API = `${ORIGIN}/WebServices/ApiSession/SportsBettingSessionService.svc`;
/** Čeština (id jazyka webu). */
export const LANGUAGE_ID = 12;

export const HTTP_HEADERS: Record<string, string> = {
  'content-type': 'application/json;charset=UTF-8',
  accept: 'application/json',
  origin: ORIGIN,
  referer: `${ORIGIN}/`,
};

export const initBody = () => ({ Version: 'CZ-I', LanguageID: LANGUAGE_ID, AppType: 1, CanGetRightBanner: false, RecaptchaResponse: null });

/** WCF JSON datum. */
export const wcfDate = (ms: number) => `/Date(${Math.round(ms)})/`;

/** Prematch: všechny zápasy sportu s hlavním trhem (bez filtru GameIds). */
export const mainBody = (token: string, sport: Sport) => ({
  LanguageID: LANGUAGE_ID,
  Token: token,
  CategoryID: String(SPORT_IDS[sport]),
  Top: 5000,
  IncludeLiveCategories: false,
});

/** Prematch: vybrané typy trhů (GameIds) pro zápasy začínající v okně [from, to]. */
export const marketsBody = (token: string, sport: Sport, gameIds: number[], from: number, to: number) => ({
  LanguageID: LANGUAGE_ID,
  Token: token,
  CategoryID: String(SPORT_IDS[sport]),
  GameIds: gameIds,
  From: wcfDate(from),
  To: wcfDate(to),
  Top: 5000,
  IncludeLiveCategories: false,
});

/** Live: všechny živé zápasy všech sportů s hlavními trhy a stavem (JSON, ~100 kB). */
export const liveBody = (token: string) => ({ ActualEvents: true, LanguageID: LANGUAGE_ID, Token: token, UseLongPolling: false, TimeStamp: 0 });

export interface ApiEnvelope<T = unknown> {
  Result: number;
  Token?: string | null;
  ReturnValue?: T | null;
  TimeStamp?: number | null;
}

/** Transport: POST s JSON tělem → status + text (Node fetch, nebo fetch uvnitř stránky). */
export type Transport = (url: string, body: string, timeoutMs: number) => Promise<{ status: number; text: string }>;

export interface CallStats {
  requests: number;
  bytes: number;
  /** Začátek nejstaršího požadavku (API necachuje – data jsou čerstvá v okamžiku dotazu). */
  oldest?: number;
}

/** Klient s anonymním tokenem; při Result 0 token obnoví a požadavek jednou zopakuje. */
export class SynotApi {
  private token?: string;
  private tokenPromise?: Promise<string>;

  constructor(private readonly transport: Transport) {}

  private async raw<T>(url: string, body: unknown, timeoutMs: number, stats?: CallStats): Promise<ApiEnvelope<T>> {
    const started = Date.now();
    const r = await this.transport(url, JSON.stringify(body), timeoutMs);
    if (stats) {
      stats.requests++;
      stats.bytes += r.text.length;
      if (!stats.oldest || started < stats.oldest) stats.oldest = started;
    }
    if (r.status !== 200) {
      throw new StrategyError(`synot API HTTP ${r.status}`, r.status === 403 || r.status === 429 ? 'blocked' : 'http', {
        status: r.status,
        url,
        sample: r.text.slice(0, 300),
      });
    }
    try {
      return JSON.parse(r.text) as ApiEnvelope<T>;
    } catch {
      throw new StrategyError('synot: non-JSON response', /cloudflare|captcha|access denied/i.test(r.text) ? 'blocked' : 'structure', {
        status: r.status,
        url,
        sample: r.text.slice(0, 300),
      });
    }
  }

  async getToken(timeoutMs = 10_000, stats?: CallStats): Promise<string> {
    if (this.token) return this.token;
    this.tokenPromise ??= (async () => {
      try {
        const r = await this.raw(`${SESSION_API}/GetLiveInitData`, initBody(), timeoutMs, stats);
        if (r.Result !== 1 || !r.Token) throw new StrategyError('synot: GetLiveInitData returned no token', 'structure', { result: r.Result });
        this.token = r.Token;
        return r.Token;
      } finally {
        this.tokenPromise = undefined;
      }
    })();
    return this.tokenPromise;
  }

  resetToken(): void {
    this.token = undefined;
  }

  /** Volání s tokenem; `body(token)` sestaví tělo. */
  async call<T>(url: string, body: (token: string) => unknown, timeoutMs: number, stats?: CallStats): Promise<ApiEnvelope<T>> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.getToken(10_000, stats);
      const r = await this.raw<T>(url, body(token), timeoutMs, stats);
      if (r.Result === 1) return r;
      if (attempt === 0) {
        this.resetToken(); // prošlý / neplatný token
        continue;
      }
      throw new StrategyError(`synot API Result ${r.Result}`, 'structure', { url, result: r.Result });
    }
  }
}
