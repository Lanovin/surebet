// Betano.cz (Kaizen Gaming) – jen přes camoufox-bridge, viz docs/bookmakers/betano.md.
// Playwright Chromium a plain HTTP blokuje Cloudflare bot management (403 „Betano Splash Screen“),
// proto L5 strategie v Camoufoxu se známými endpointy (fetch uvnitř stránky, ověřeno 2026-10-01):
//  * prematch: /api/sports/upcoming/calendar/<KÓD>/ = „Nadcházející“ zápasy sportu (výchozí = dnes do
//    půlnoci, ?hours=12 = příštích 12 h – jiné hodnoty a ?date Betano ignoruje), jeden požadavek na sport
//  * live: /danae-webapi/api/live/overview/latest (normalizovaný tvar, všechny sporty najednou)
import type { AdapterFactory } from '../types.js';
import type { KnownTarget } from '../common/camoufox-replay.js';
import { CamoufoxReplayStrategy } from '../common/camoufox-replay.js';
import { parseBetano, SPORT_CODES } from './parse.js';

const ORIGIN = 'https://www.betano.cz';
const TZ = 'timeZoneId=Europe/Prague';

function prematchTargets(): KnownTarget[] {
  return Object.entries(SPORT_CODES).flatMap(([code, sport]) => [
    { url: `${ORIGIN}/api/sports/upcoming/calendar/${code}/?${TZ}`, sport },
    { url: `${ORIGIN}/api/sports/upcoming/calendar/${code}/?hours=12&${TZ}`, sport },
  ]);
}

const LIVE_TARGETS: KnownTarget[] = [
  { url: `${ORIGIN}/danae-webapi/api/live/overview/latest?includeVirtuals=false&queryLanguageId=7&queryOperatorId=10` },
];

const factory: AdapterFactory = (ctx) => ({
  bookmaker: 'betano',
  strategies: [
    new CamoufoxReplayStrategy(
      {
        bookmaker: 'betano',
        origin: ORIGIN,
        targets: (scope) => (scope === 'live' ? LIVE_TARGETS : prematchTargets()),
        match: /betano\.cz\/(api|danae-webapi)\//,
        idlePath: '/robots.txt',
        parse: parseBetano,
        isBlocked: (_status, body) => body.includes('Betano Splash Screen') || body.includes('betano-splash-screen'),
      },
      ctx,
    ),
  ],
});

export default factory;
