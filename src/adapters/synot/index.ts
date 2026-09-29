// SYNOT TIP (sport.synottip.cz) – platforma eBet (stejná jako slovenský TIPOS).
// L2 interní API webu (JSON, prematch protobuf v base64) → L5 totéž API přes prohlížeč.
import type { AdapterFactory } from '../types.js';
import { SynotApiStrategy, SynotBrowserStrategy } from './strategies.js';

const factory: AdapterFactory = (ctx) => ({
  bookmaker: 'synot',
  strategies: [new SynotApiStrategy(ctx), new SynotBrowserStrategy(ctx)],
});

export default factory;
