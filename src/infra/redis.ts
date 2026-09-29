import { Redis } from 'ioredis';
import { env } from './env.js';

/** Názvy kanálů a klíčů v Redisu na jednom místě. */
export const CH = {
  oddsDiff: 'odds:diff',
  eventUpdate: 'event:update',
  arbEvents: 'arb:events',
  health: 'adapter:health',
  settingsChanged: 'settings:changed',
  unmatched: 'unmatched:changed',
  control: 'control',
} as const;

export const KEY = {
  /** hash: eventId -> JSON pohledu sázkovky na událost (trhy, kurzy, lastSeen) */
  bookState: (bk: string) => `state:${bk}`,
  /** hash: eventId -> JSON kanonické události (jména, režim, herní stav, pauza) */
  events: 'events',
  /** hash: arbId -> JSON aktivního arbu */
  activeArbs: 'arbs:active',
  /** hash: bookmaker -> JSON zdraví adaptéru */
  health: 'health',
  settings: 'settings',
} as const;

export function createRedis(name: string): Redis {
  const r = new Redis(env.REDIS_URL, { connectionName: name, maxRetriesPerRequest: null, lazyConnect: false });
  r.on('error', (err) => console.error(`[redis:${name}]`, err.message));
  return r;
}
