import type { BookmakerId } from '../src/core/types.js';

export interface BookmakerInfo {
  id: BookmakerId;
  name: string;
  url: string;
  /** Barva štítku v dashboardu (hex). */
  color: string;
  /** Výchozí zpoždění přijetí sázky (ms) – živě se zpřesňuje z user_actions. */
  acceptanceDelayMs: { prematch: number; live: number };
}

export const BOOKMAKER_INFO: Record<BookmakerId, BookmakerInfo> = {
  tipsport: { id: 'tipsport', name: 'Tipsport', url: 'https://www.tipsport.cz', color: '#1d4ed8', acceptanceDelayMs: { prematch: 1000, live: 6000 } },
  fortuna: { id: 'fortuna', name: 'Fortuna', url: 'https://www.ifortuna.cz', color: '#eab308', acceptanceDelayMs: { prematch: 1000, live: 5000 } },
  betano: { id: 'betano', name: 'Betano', url: 'https://www.betano.cz', color: '#f97316', acceptanceDelayMs: { prematch: 1000, live: 5000 } },
  chance: { id: 'chance', name: 'Chance', url: 'https://www.chance.cz', color: '#16a34a', acceptanceDelayMs: { prematch: 1000, live: 6000 } },
  sazka: { id: 'sazka', name: 'Sazka', url: 'https://www.sazka.cz/kurzove-sazky', color: '#dc2626', acceptanceDelayMs: { prematch: 1000, live: 5000 } },
  merkurxtip: { id: 'merkurxtip', name: 'MerkurXtip', url: 'https://www.merkurxtip.cz', color: '#9333ea', acceptanceDelayMs: { prematch: 1000, live: 5000 } },
  kingsbet: { id: 'kingsbet', name: 'Kingsbet', url: 'https://www.kingsbet.cz', color: '#0891b2', acceptanceDelayMs: { prematch: 1000, live: 5000 } },
  betx: { id: 'betx', name: 'BetX', url: 'https://bet-x.cz', color: '#db2777', acceptanceDelayMs: { prematch: 1000, live: 5000 } },
};
