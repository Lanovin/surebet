import type { BookmakerId, FeedScope, HealthResult, RawOdds, Sport } from '../core/types.js';
import type { HttpClient } from './http.js';
import type { BrowserPool } from './browser.js';
import type { Fixtures } from './fixtures.js';
import type { Logger } from '../infra/logger.js';

export type StrategyLevel = 0 | 1 | 2 | 3 | 4 | 5;

/**
 * Žebříček strategií (od nejlehčí):
 *  1 oficiální/veřejné API, 2 interní JSON/REST webu, 3 websocket feed webu,
 *  4 server-rendered HTML, 5 Playwright (zachytávání síťových odpovědí nebo DOM).
 *  0 = simulátor (testovací kurzy).
 */
export const LEVEL_NAMES: Record<StrategyLevel, string> = {
  0: 'simulátor',
  1: 'veřejné API',
  2: 'interní JSON/REST',
  3: 'websocket',
  4: 'HTML',
  5: 'Playwright',
};

export interface FetchRequest {
  scope: FeedScope;
  sports: Sport[];
  signal?: AbortSignal;
}

export interface Strategy {
  readonly name: string;
  readonly level: StrategyLevel;
  readonly supports: { prematch: boolean; live: boolean };
  /**
   * Nejkratší smysluplný interval pollingu pro scope (ms) – např. když server/CDN data cachuje
   * nebo sázkovka při rychlejším tempu vrací 403. Runner nikdy nepolluje rychleji.
   */
  readonly minIntervalMs?: Partial<Record<FeedScope, number>>;
  /** Stáhne kompletní aktuální nabídku pro daný scope (všechny události, které strategie umí). */
  fetch(req: FetchRequest): Promise<RawOdds>;
  /** Levná kontrola dostupnosti (např. HEAD/malý endpoint). */
  healthCheck(): Promise<HealthResult>;
  /**
   * Push strategie (websocket): začne streamovat kompletní stavy pro scope.
   * Vrací funkci pro ukončení. Když chybí, runner používá polling přes fetch().
   */
  subscribe?(
    req: FetchRequest,
    onData: (raw: RawOdds) => void,
    onError: (err: Error) => void,
  ): Promise<() => Promise<void>>;
  /**
   * Pokus o opravu před přepnutím na další úroveň (obnova session/cookies, znovuobjevení endpointu).
   * Vrací true, když má smysl strategii zkusit znovu.
   */
  repair?(): Promise<boolean>;
  dispose?(): Promise<void>;
}

export interface AdapterContext {
  bookmaker: BookmakerId;
  http: HttpClient;
  browser: BrowserPool;
  fixtures: Fixtures;
  log: Logger;
}

export interface Adapter {
  bookmaker: BookmakerId;
  /** Strategie seřazené od nejlehčí (nejnižší level) po nejtěžší. */
  strategies: Strategy[];
}

export type AdapterFactory = (ctx: AdapterContext) => Adapter;

/** Chyba, kterou strategie hází, když zjistí konkrétní důvod selhání (pro diagnostiku). */
export class StrategyError extends Error {
  constructor(
    message: string,
    readonly kind: 'http' | 'structure' | 'blocked' | 'timeout' | 'validation' | 'empty' | 'other',
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'StrategyError';
  }
}
