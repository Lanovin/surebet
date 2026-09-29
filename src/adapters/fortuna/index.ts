// Fortuna (ifortuna.cz) – platforma FEG „ufo“ (není sdílená s Betano/Kaizen), viz docs/bookmakers/fortuna.md.
//  L2 rest-api      – veřejné offer API přes plain HTTP (prematch i live)
//  L3 websocket     – STOMP/SockJS ws-offer.ifortuna.cz, push pro live (subscribe) + REST snapshot
//  L5 browser-fetch – stejné API přes fetch() uvnitř stránky www.ifortuna.cz (fallback)
import type { AdapterFactory } from '../types.js';
import { BrowserTransport, DEFAULT_DETAIL, FortunaPollStrategy, HttpTransport } from './strategies.js';
import { FortunaWsStrategy } from './ws.js';

const factory: AdapterFactory = (ctx) => ({
  bookmaker: 'fortuna',
  strategies: [
    new FortunaPollStrategy('rest-api', 2, ctx, new HttpTransport(ctx), { detail: DEFAULT_DETAIL }),
    new FortunaWsStrategy(ctx),
    new FortunaPollStrategy('browser-fetch', 5, ctx, new BrowserTransport(ctx), { detail: null }),
  ],
});

export default factory;
