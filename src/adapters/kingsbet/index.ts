// kingsbet.cz – sportsbook běží na platformě Altenar (widget SDK, integration "kingsbet").
import type { AdapterFactory } from '../types.js';
import { AltenarBrowserStrategy, AltenarHttpStrategy, type AltenarOptions } from './strategies.js';

/** Prematch: 4 listingy + detail nejbližších 20 událostí (do 24 h). Live: 4 listingy. */
const OPTIONS: AltenarOptions = { detailLimit: 20, detailHorizonHours: 24 };

const factory: AdapterFactory = (ctx) => ({
  bookmaker: 'kingsbet',
  strategies: [new AltenarHttpStrategy(ctx, OPTIONS), new AltenarBrowserStrategy(ctx, OPTIONS)],
});

export default factory;
