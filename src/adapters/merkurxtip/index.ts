// MerkurXtip (www.merkurxtip.cz/sazeni) – sportsbook Altenar (integrace "merkurxtip").
// L2 veřejné widget API (sb2frontend-altenar2.biahosted.com) → L5 totéž API přes prohlížeč.
// Parsování i strategie sdílí s Kingsbetem: src/adapters/common/altenar*.ts.
import type { AdapterFactory } from '../types.js';
import type { AltenarSite } from '../common/altenar.js';
import { AltenarBrowserStrategy, AltenarHttpStrategy } from '../common/altenar-api.js';

export const MERKURXTIP: AltenarSite = {
  bookmaker: 'merkurxtip',
  integration: 'merkurxtip',
  origin: 'https://www.merkurxtip.cz',
  // web kurz ořízne na 2 místa (2.1667 → 2.16), tiket počítá s přesnou cenou → oříznutá hodnota
  // odpovídá tomu, co uživatel vidí, a výplatu nikdy nenadhodnotí
  rounding: 'floor',
  // hash router Altenar SDK
  eventUrl: (e) => `https://www.merkurxtip.cz/sazeni#/sport/${e.sportId}/category/${e.catId ?? 0}/championship/${e.champId ?? 0}/event/${e.id}`,
};

const factory: AdapterFactory = (ctx) => ({
  bookmaker: 'merkurxtip',
  strategies: [new AltenarHttpStrategy(ctx, MERKURXTIP), new AltenarBrowserStrategy(ctx, MERKURXTIP, 'browser-fetch')],
});

export default factory;
