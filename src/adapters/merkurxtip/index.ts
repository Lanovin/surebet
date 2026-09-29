// MerkurXtip (www.merkurxtip.cz/sazeni) – sportsbook Altenar (integrace "merkurxtip").
// L2 veřejné widget API (sb2frontend-altenar2.biahosted.com) → L5 totéž API přes prohlížeč.
import type { AdapterFactory } from '../types.js';
import { MerkurApiStrategy, MerkurBrowserStrategy } from './strategies.js';

const factory: AdapterFactory = (ctx) => ({
  bookmaker: 'merkurxtip',
  strategies: [new MerkurApiStrategy(ctx), new MerkurBrowserStrategy(ctx)],
});

export default factory;
