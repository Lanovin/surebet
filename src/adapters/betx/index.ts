// betx (web https://bet-x.cz, provozovatel Evona Electronic) – vlastní platforma Evona,
// interní SportsOfferApi na sportapis-cz.betx.bet s kurzy ze Sportradar UOF.
// Pozn.: doména betx.cz je zaparkovaná (INWX "Domain parked"), skutečný web je bet-x.cz.
import type { AdapterFactory } from '../types.js';
import { BetxBrowserStrategy, BetxHttpStrategy, DEFAULT_OPTIONS } from './strategies.js';

const factory: AdapterFactory = (ctx) => ({
  bookmaker: 'betx',
  strategies: [new BetxHttpStrategy(ctx, DEFAULT_OPTIONS), new BetxBrowserStrategy(ctx, DEFAULT_OPTIONS)],
});

export default factory;
