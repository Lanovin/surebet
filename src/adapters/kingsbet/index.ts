// kingsbet.cz – sportsbook běží na platformě Altenar (widget SDK, integration "kingsbet").
// Parsování i strategie sdílí s MerkurXtip: src/adapters/common/altenar*.ts.
import type { AdapterFactory } from '../types.js';
import type { AltenarSite } from '../common/altenar.js';
import { AltenarBrowserStrategy, AltenarHttpStrategy } from '../common/altenar-api.js';

export const KINGSBET: AltenarSite = {
  bookmaker: 'kingsbet',
  integration: 'kingsbet',
  origin: 'https://www.kingsbet.cz',
  // web i tiket počítají s cenou zaokrouhlenou na 2 místa (2.8572 → 2.86; vklad 100 → výhra 286.00)
  rounding: 'round',
  eventUrl: (e) => `https://www.kingsbet.cz/sport?page=event&eventId=${e.id}&sportId=${e.sportId}`,
};

const factory: AdapterFactory = (ctx) => ({
  bookmaker: 'kingsbet',
  strategies: [new AltenarHttpStrategy(ctx, KINGSBET), new AltenarBrowserStrategy(ctx, KINGSBET, 'altenar-browser')],
});

export default factory;
