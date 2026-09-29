// Sestavení adaptérů podle zdroje dat (sim = testovací kurzy, real = skutečné sázkovky).
import { BOOKMAKERS, type BookmakerId } from '../core/types.js';
import type { Adapter, AdapterContext, AdapterFactory } from './types.js';
import { createSimAdapter } from './sim/index.js';
import { createLogger } from '../infra/logger.js';

const log = createLogger('registry');

export async function loadRealAdapter(bk: BookmakerId, ctx: AdapterContext): Promise<Adapter | null> {
  try {
    const mod = (await import(`./${bk}/index.js`)) as { default?: AdapterFactory };
    if (typeof mod.default !== 'function') return null;
    const a = mod.default(ctx);
    return a.strategies.length ? a : null;
  } catch (e) {
    const msg = (e as Error).message;
    if (!/Cannot find module|ERR_MODULE_NOT_FOUND/.test(msg)) log.warn(`adapter ${bk} failed to load`, { error: msg });
    return null;
  }
}

export async function buildAdapters(
  source: 'sim' | 'real',
  only: string[],
  ctxFor: (bk: BookmakerId) => AdapterContext,
): Promise<{ adapters: Adapter[]; missing: BookmakerId[] }> {
  const adapters: Adapter[] = [];
  const missing: BookmakerId[] = [];
  for (const bk of BOOKMAKERS) {
    if (only.length && !only.includes(bk)) continue;
    if (source === 'sim') adapters.push(createSimAdapter(bk));
    else {
      const a = await loadRealAdapter(bk, ctxFor(bk));
      if (a) adapters.push(a);
      else missing.push(bk);
    }
  }
  return { adapters, missing };
}
