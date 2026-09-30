// SYNOT TIP – interní JSON API webu sport.synottip.cz (WCF služby platformy eBet).
// Všechny volání jsou POST s JSON tělem; odpověď {Result, Token, ReturnValue}. Result 1 = OK,
// 0 = chyba (typicky neplatný/prošlý Token). Anonymní Token vrací GetLiveInitData.
// Bez hlavičky `accept: application/json` WCF odpovídá XML.
import type { Sport } from '../../core/types.js';
import { StrategyError } from '../types.js';
import { ORIGIN, SPORT_IDS } from './parse.js';

export const API = `${ORIGIN}/WebServices/Api/SportsBettingService.svc`;
export const SESSION_API = `${ORIGIN}/WebServices/ApiSession/SportsBettingSessionService.svc`;
/**
 * Live seznam, který používá live stránka webu (`getLiveEventsWLAsync` v app.min.js). Oproti
 * GetLIPEvtsDsk (live box na prematch stránce) posílá i totaly/handicapy/sety, ale ne basketbalový
 * "Zápas" 1/0/2. Web posílá hlavičku `Verify: sport <token>`.
 */
export const LIVE_URL = `${ORIGIN}/WebServices/Api/webapi/GetLiveEventsWL`;
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

/** Velikost stránky výpisu (`Top`); další stránka přes `Skip`, když `UnpaginatedEventCount` > Skip + Top. */
export const PAGE_SIZE = 5000;

/**
 * CategoryID: kořenová kategorie sportu, nebo `null` = všechny sporty jedním požadavkem (web tak volá
 * úvodní nabídku). Seznam kategorií (`"12,14"`) API nepodporuje – vrátí prázdnou odpověď.
 */
const categoryId = (sport: Sport | null) => (sport ? String(SPORT_IDS[sport]) : null);

/** Prematch: všechny zápasy sportu (null = všech sportů) s hlavním trhem (bez filtru GameIds). */
export const mainBody = (token: string, sport: Sport | null, skip = 0) => ({
  LanguageID: LANGUAGE_ID,
  Token: token,
  CategoryID: categoryId(sport),
  Top: PAGE_SIZE,
  ...(skip ? { Skip: skip } : {}),
  IncludeLiveCategories: false,
});

/**
 * Prematch: vybrané typy trhů (GameIds) pro zápasy začínající v okně [from, to]. Filtr GameIds platí
 * pro všechny sporty požadavku najednou (ID typu trhu je číslo, jeho význam se ale liší podle sportu).
 */
export const marketsBody = (token: string, sport: Sport | null, gameIds: number[], from: number, to: number, skip = 0) => ({
  LanguageID: LANGUAGE_ID,
  Token: token,
  CategoryID: categoryId(sport),
  GameIds: gameIds,
  From: wcfDate(from),
  To: wcfDate(to),
  Top: PAGE_SIZE,
  ...(skip ? { Skip: skip } : {}),
  IncludeLiveCategories: false,
});

/** Live: všechny živé zápasy všech sportů s trhy seznamu a stavem (JSON, 150–250 kB). Bez long-pollingu. */
export const liveBody = (token: string) => ({ ActualEvents: true, LanguageID: LANGUAGE_ID, Token: token, UseLongPolling: false, TimeStamp: 0 });
export const liveHeaders = (token: string): Record<string, string> => ({ Verify: `sport ${token}` });

export interface ApiEnvelope<T = unknown> {
  Result: number;
  Token?: string | null;
  ReturnValue?: T | null;
  TimeStamp?: number | null;
}

/** Transport: POST s JSON tělem → status + text (Node fetch, nebo fetch uvnitř stránky). */
export type Transport = (url: string, body: string, timeoutMs: number, headers?: Record<string, string>) => Promise<{ status: number; text: string }>;

/**
 * Server drží live snapshot v cache a přegenerovává ho každých ~1,03 s (ojediněle 2–4 s);
 * požadavek bez long-pollingu dostane poslední hotový snapshot → data jsou 0–1 s stará už v
 * okamžiku dotazu. `TimeStamp` odpovědi = čas vygenerování v 100ns tikách serveru; báze tiků se
 * liší mezi uzly za F5 (cookie BIGipServer drží uzel, ale ne zaručeně).
 */
export const LIVE_SNAPSHOT_MS = 1_100;

/**
 * Odhad okamžiku vygenerování live snapshotu. offset = t1 − TimeStamp/10⁴ je vždy ≥ skutečný
 * posun hodin uzlu (odpověď nemůže přijít dřív, než vznikla) → minimum přes odpovědi posun
 * odhaduje zdola s chybou ≈ nejkratší zpoždění (desítky ms). Minimum pomalu "prosakuje" nahoru
 * (drift hodin). Offset o víc než 3 s menší = jiný uzel / skok hodin → nová kalibrace; o víc než
 * 3 s větší je nejednoznačné (zaseknutý snapshot × uzel s jinou bází) → konzervativní mez a po
 * 3 takových odpovědích za sebou nová kalibrace. Dokud kalibrace není usazená, platí konzervativní
 * mez t0 − LIVE_SNAPSHOT_MS. Tentýž snapshot (stejný TimeStamp) má vždy stejný čas → opakovaný
 * dotaz na nezměněná data je nezomladí (detektor porovnává seenAt nohou s changedAt ostatních).
 */
export class SnapshotClock {
  private base?: number;
  private samples = 0;
  private far = 0;
  private lastTs?: number;
  private lastGen?: number;
  constructor(
    private readonly minSamples = 10,
    private readonly leakMsPerSample = 2,
    private readonly jumpMs = 3_000,
  ) {}

  generatedAt(timeStamp: number | null | undefined, t0: number, t1: number): number {
    const fallback = t0 - LIVE_SNAPSHOT_MS;
    if (typeof timeStamp !== 'number' || !Number.isFinite(timeStamp) || timeStamp <= 0) return fallback;
    if (timeStamp === this.lastTs && this.lastGen !== undefined) return Math.min(this.lastGen, t1);
    const o = t1 - timeStamp / 10_000;
    let ambiguous = false;
    if (this.base === undefined || o < this.base - this.jumpMs) this.recalibrate(o);
    else if (o > this.base + this.jumpMs) {
      if (++this.far >= 3) this.recalibrate(o);
      else ambiguous = true;
    } else {
      this.far = 0;
      this.base = Math.min(this.base + this.leakMsPerSample, o);
    }
    let gen = fallback;
    if (!ambiguous) {
      this.samples++;
      const est = Math.round(timeStamp / 10_000 + this.base!);
      gen = this.samples >= this.minSamples ? Math.min(est, t1) : Math.min(est, fallback);
    }
    this.lastTs = timeStamp;
    this.lastGen = gen;
    return gen;
  }

  private recalibrate(o: number): void {
    this.base = o;
    this.samples = 0;
    this.far = 0;
  }
}

export interface CallStats {
  requests: number;
  bytes: number;
  /** Začátek nejstaršího požadavku (prematch API necachuje – data jsou čerstvá v okamžiku dotazu). */
  oldest?: number;
  /** Začátek a konec posledního požadavku (live: pro odhad stáří snapshotu). */
  lastStart?: number;
  lastEnd?: number;
}

/** Klient s anonymním tokenem; při Result 0 token obnoví a požadavek jednou zopakuje. */
export class SynotApi {
  private token?: string;
  private tokenPromise?: Promise<string>;

  constructor(private readonly transport: Transport) {}

  private async raw<T>(url: string, body: unknown, timeoutMs: number, stats?: CallStats, headers?: Record<string, string>): Promise<ApiEnvelope<T>> {
    const started = Date.now();
    const r = await this.transport(url, JSON.stringify(body), timeoutMs, headers);
    if (stats) {
      stats.requests++;
      stats.bytes += r.text.length;
      if (!stats.oldest || started < stats.oldest) stats.oldest = started;
      stats.lastStart = started;
      stats.lastEnd = Date.now();
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

  /** Volání s tokenem; `body(token)` sestaví tělo, `headers(token)` volitelné hlavičky navíc. */
  async call<T>(
    url: string,
    body: (token: string) => unknown,
    timeoutMs: number,
    stats?: CallStats,
    headers?: (token: string) => Record<string, string>,
  ): Promise<ApiEnvelope<T>> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.getToken(10_000, stats);
      const r = await this.raw<T>(url, body(token), timeoutMs, stats, headers?.(token));
      if (r.Result === 1) return r;
      if (attempt === 0) {
        this.resetToken(); // prošlý / neplatný token
        continue;
      }
      throw new StrategyError(`synot API Result ${r.Result}`, 'structure', { url, result: r.Result });
    }
  }
}
