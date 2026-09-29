// Sazka / Allwyn (www.allwyn.cz/kurzove-sazky) – platforma OpenBet "engage".
// L2 REST API (apigw.allwyn.cz) → L3 OpenBet push websocket (live). L5 blokuje Akamai (viz docs).
import type { AdapterFactory } from '../types.js';
import { SazkaApiStrategy, SazkaPushStrategy } from './strategies.js';

const factory: AdapterFactory = (ctx) => ({
  bookmaker: 'sazka',
  strategies: [new SazkaApiStrategy(ctx), new SazkaPushStrategy(ctx)],
});

export default factory;
