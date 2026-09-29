// Chance.cz – stejná platforma jako Tipsport (sdílený modul ../tipsport/platform.ts).
// Zatím bez funkční strategie (Cloudflare bot management 403), viz docs/bookmakers/chance.md.
import type { AdapterFactory } from '../types.js';
import { createPlatformAdapter } from '../tipsport/platform.js';

const factory: AdapterFactory = (ctx) => createPlatformAdapter('chance', ctx);
export default factory;
