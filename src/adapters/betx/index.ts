// betx (web https://bet-x.cz, provozovatel Evona Electronic) – vlastní platforma Evona,
// interní SportsOfferApi na sportapis-cz.betx.bet s kurzy ze Sportradar UOF.
// Pozn.: doména betx.cz je zaparkovaná (INWX "Domain parked"), skutečný web je bet-x.cz.
//  L2 betx-api     – listing (prematch; live záloha, cache serveru ~11 s)
//  L3 betx-push    – live přes SignalR push webu (runner ho v LIVE s preferPush bere první)
//  L5 betx-browser – listing přes fetch v Chromiu
import type { AdapterFactory } from '../types.js';
import { BetxBrowserStrategy, BetxHttpStrategy, BetxPushStrategy, DEFAULT_OPTIONS } from './strategies.js';

const factory: AdapterFactory = (ctx) => ({
  bookmaker: 'betx',
  strategies: [new BetxHttpStrategy(ctx, DEFAULT_OPTIONS), new BetxPushStrategy(ctx, DEFAULT_OPTIONS), new BetxBrowserStrategy(ctx, DEFAULT_OPTIONS)],
});

export default factory;
