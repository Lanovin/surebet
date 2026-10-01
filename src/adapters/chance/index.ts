// Chance.cz – stejná platforma jako Tipsport (sdílený modul ../tipsport/platform.ts).
// Camoufox strategie jako Tipsport (liší se jen origin), viz docs/bookmakers/chance.md.
import type { AdapterFactory } from '../types.js';
import { createPlatformAdapter } from '../tipsport/platform.js';

const factory: AdapterFactory = (ctx) => createPlatformAdapter('chance', ctx);
export default factory;
