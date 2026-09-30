// DTO a zprávy mezi službami a dashboardem (Redis pub/sub + WebSocket). Bez závislostí na Node.
import type {
  AdapterState,
  BookmakerId,
  FeedScope,
  GameState,
  MarketType,
  Mode,
  PauseInfo,
  SelectionKey,
  Sport,
} from '../core/types.js';

/** Kanonická událost tak, jak ji vidí detektor a dashboard. */
export interface EventView {
  id: number;
  sport: Sport;
  competition: string;
  home: string;
  away: string;
  startTime: number;
  mode: Mode;
  live: boolean;
  finished: boolean;
  state?: GameState;
  /** sázkovka, jejíž herní stav je použit */
  stateFrom?: BookmakerId;
  pause?: PauseInfo;
  books: BookmakerId[];
  isSim: boolean;
  updatedAt: number;
}

/** Pohled jedné sázkovky na událost – trhy už v orientaci kanonické události. */
export interface BookEventState {
  sourceEventId: string;
  swapped: boolean;
  scope: FeedScope;
  seenAt: number;
  url?: string;
  markets: Record<string, { open: boolean; sels: Partial<Record<SelectionKey, { odds: number; open: boolean; changedAt: number }>> }>;
}

export interface OddsChange {
  eventId: number;
  market: string;
  sel: SelectionKey;
  odds: number | null;
  prev: number | null;
  status: 'open' | 'suspended' | 'removed';
}

/** Zpráva na kanálu odds:diff (jedna na fetch jedné sázkovky). */
export interface OddsDiffMessage {
  /** null = zpráva jen se změnami událostí (bez kurzů) */
  bk: BookmakerId | null;
  scope: FeedScope;
  fetchedAt: number;
  publishedAt: number;
  /** události potvrzené tímto fetchem (obnovují stáří nohou) */
  seen: number[];
  /** události, které z nabídky zmizely */
  removed: number[];
  /** kompletní nový stav změněných událostí této sázkovky */
  states: Record<number, BookEventState>;
  changes: OddsChange[];
  /** kanonické události, u nichž se změnil režim/stav */
  events: EventView[];
}

export interface ArbLegDTO {
  bookmaker: BookmakerId;
  /** výsledek arbu (výběr trhu/skupiny arbu) */
  selection: SelectionKey;
  selectionLabel: string;
  /** trh, který se u sázkovky skutečně sází (u arbů napříč trhy se liší od trhu arbu) */
  market: string;
  marketSelection: SelectionKey;
  marketLabel: string;
  odds: number;
  effOdds: number;
  stake: number;
  payout: number;
  changedAt: number;
  seenAt: number;
  swapped: boolean;
  sourceEventId: string;
  url?: string;
}

export interface PredictionDTO {
  medianMs: number | null;
  p25Ms: number | null;
  p75Ms: number | null;
  pOver: Record<5 | 10 | 30 | 60, number>;
  n: number;
  nEvents: number;
  segment: string;
  level: number;
  /** reakční doba + max. zpoždění přijetí sázkovek arbu */
  neededMs: number;
  /** P(arb vydrží > neededMs) */
  pNeeded: number | null;
  source: 'km' | 'model';
}

export interface ArbDTO {
  id: string;
  mode: Mode;
  sport: Sport;
  competition: string;
  eventId: number;
  eventName: string;
  home: string;
  away: string;
  startTime: number;
  market: string;
  marketLabel: string;
  marketType: MarketType;
  line: number | null;
  legs: ArbLegDTO[];
  /** marže v % */
  margin: number;
  prevMargin: number | null;
  maxMargin: number;
  marginAtDetection: number;
  firstSeen: number;
  lastSeen: number;
  bankroll: number;
  totalStake: number;
  minProfit: number;
  positive: boolean;
  prediction: PredictionDTO | null;
  /** ztlumený: nízká šance, že vydrží reakční dobu + přijetí sázky */
  muted: boolean;
  /** PAUSED: predikovaná životnost přesahuje zbývající čas přestávky */
  risky: boolean;
  pause?: PauseInfo & { remainingSec: number };
  state?: GameState;
  timeToStartSec: number | null;
  isSim: boolean;
  endReason?: string;
  endedAt?: number;
}

export type ArbEventKind = 'new' | 'update' | 'end';

export interface ArbEventMessage {
  kind: ArbEventKind;
  arb: ArbDTO;
  /** kdy detektor arb (změnu) zjistil – epoch ms */
  detectedAt: number;
  /** kdy vznikla data, která změnu vyvolala */
  dataAt: number;
}

export interface HealthScopeDTO {
  scope: FeedScope;
  state: AdapterState;
  active: string | null;
  activeLevel: number | null;
  push: boolean;
  lastOkAt: number | null;
  lastDataAt: number | null;
  lastError: string | null;
  lastLatencyMs: number | null;
  events: number;
  intervalMs: number;
  strategies: { name: string; level: number; status: string; failures: number; lastError?: string }[];
}

export interface HealthDTO {
  bookmaker: BookmakerId;
  state: AdapterState;
  enabled: boolean;
  source: 'sim' | 'real' | 'none';
  scopes: HealthScopeDTO[];
  matchedEvents: number;
  unmatchedEvents: number;
  updatedAt: number;
}

export interface HealthLogDTO {
  id: number;
  ts: number;
  bookmaker: BookmakerId;
  scope: string | null;
  event: string;
  strategy: string | null;
  level: number | null;
  state: string | null;
  prevState: string | null;
  prevStrategy: string | null;
  reason: string | null;
}

export type ServerMessage =
  | { t: 'hello'; serverTime: number; dataSource: string; version: string }
  | { t: 'snapshot'; arbs: ArbDTO[]; health: HealthDTO[]; unmatched: number; recentHealth: HealthLogDTO[] }
  | { t: 'arb'; kind: ArbEventKind; arb: ArbDTO; detectedAt: number; dataAt: number; sentAt: number }
  | { t: 'health'; health: HealthDTO[] }
  | { t: 'health_event'; event: HealthLogDTO }
  | { t: 'settings'; settings: unknown }
  | { t: 'unmatched'; pending: number }
  | { t: 'pong'; id: number; clientTs: number; serverTs: number };

export type ClientMessage = { t: 'ping'; id: number; clientTs: number };
