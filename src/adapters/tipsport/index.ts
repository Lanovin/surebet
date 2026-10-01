// Tipsport.cz – Camoufox strategie sdílené platformy (./platform.ts), viz docs/bookmakers/tipsport.md.
import type { AdapterFactory } from '../types.js';
import { createPlatformAdapter } from './platform.js';

const factory: AdapterFactory = (ctx) => createPlatformAdapter('tipsport', ctx);
export default factory;
