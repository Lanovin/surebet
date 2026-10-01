// Betano.cz (Kaizen Gaming) – jen přes camoufox-bridge, viz docs/bookmakers/betano.md.
// Playwright Chromium a plain HTTP blokuje Cloudflare bot management (403 „Betano Splash Screen“),
// proto L5 strategie v Camoufoxu: discover (zachycení XHR stránek) → replay (fetch uvnitř stránky).
//  ⚠️ URL stránek si ověř v prohlížeči (klikni na sport a zkopíruj adresu) – slugy se můžou lišit.
import type { AdapterFactory } from '../types.js';
import { CamoufoxReplayStrategy } from '../common/camoufox-replay.js';
import { parseBetano } from './parse.js';

const ORIGIN = 'https://www.betano.cz';

const factory: AdapterFactory = (ctx) => ({
  bookmaker: 'betano',
  strategies: [
    new CamoufoxReplayStrategy(
      {
        bookmaker: 'betano',
        origin: ORIGIN,
        pages: {
          prematch: [
            { url: `${ORIGIN}/sport/fotbal/`, sport: 'football' },
            { url: `${ORIGIN}/sport/tenis/`, sport: 'tennis' },
            { url: `${ORIGIN}/sport/hokej/`, sport: 'hockey' },
          ],
          live: [{ url: `${ORIGIN}/live/` }],
        },
        match: /betano\.cz\/(api|danae-webapi)\//,
        parse: parseBetano,
        isBlocked: (_status, body) => body.includes('Betano Splash Screen') || body.includes('betano-splash-screen'),
      },
      ctx,
    ),
  ],
});

export default factory;