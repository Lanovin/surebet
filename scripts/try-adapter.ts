// Ruční zkouška adaptéru:  npx tsx scripts/try-adapter.ts <bookmaker> [prematch|live] [--strategy=name] [--save] [--json] [--push[=s]]
// Spustí healthCheck + fetch každé strategie, zvaliduje výstup a vypíše souhrn.
// --push[=30]: u strategií se subscribe() (websocket) místo fetch() poslouchá N sekund a vypisuje stav.
import { BOOKMAKERS, SPORTS, type BookmakerId, type FeedScope } from '../src/core/types.js';
import { validateRawOdds } from '../src/core/validate.js';
import { HttpClient } from '../src/adapters/http.js';
import { BrowserPool } from '../src/adapters/browser.js';
import { Fixtures, PROJECT_ROOT } from '../src/adapters/fixtures.js';
import { join } from 'node:path';
import { createLogger } from '../src/infra/logger.js';
import type { AdapterFactory } from '../src/adapters/types.js';

const args = process.argv.slice(2);
const bk = args[0] as BookmakerId;
if (!BOOKMAKERS.includes(bk)) {
  console.error(`usage: try-adapter <${BOOKMAKERS.join('|')}> [prematch|live] [--strategy=name] [--save] [--json]`);
  process.exit(1);
}
const scope = (args.find((a) => a === 'prematch' || a === 'live') ?? 'prematch') as FeedScope;
const only = args.find((a) => a.startsWith('--strategy='))?.split('=')[1];
const save = args.includes('--save');
const asJson = args.includes('--json');
const pushArg = args.find((a) => a === '--push' || a.startsWith('--push='));
const pushSec = pushArg ? Number(pushArg.split('=')[1] ?? 30) || 30 : 0;

const mod = (await import(`../src/adapters/${bk}/index.ts`)) as { default: AdapterFactory };
const browser = new BrowserPool({
  idleCloseMs: 60_000,
  // vlastní profil, aby šlo zkoušet víc sázkovek souběžně (Chrome zamyká profil)
  userDataDir: join(PROJECT_ROOT, '.infra', `browser-profile-try-${bk}`),
});
const ctx = {
  bookmaker: bk,
  http: new HttpClient({ minIntervalMs: 150 }),
  browser,
  fixtures: new Fixtures(bk),
  log: createLogger(`try:${bk}`),
};
const adapter = mod.default(ctx);
try {
  for (const s of adapter.strategies) {
    if (only && s.name !== only) continue;
    if (!s.supports[scope]) {
      console.log(`- ${s.name} (L${s.level}) nepodporuje ${scope}`);
      continue;
    }
    console.log(`\n=== ${bk} / ${s.name} (level ${s.level}) / ${scope}`);
    const h = await s.healthCheck().catch((e) => ({ ok: false, latencyMs: 0, message: String(e?.message ?? e) }));
    console.log('health:', JSON.stringify(h));
    if (pushSec && s.subscribe) {
      await tryPush(s, pushSec);
      continue;
    }
    const t0 = performance.now();
    try {
      const raw = await s.fetch({ scope, sports: [...SPORTS] });
      const ms = Math.round(performance.now() - t0);
      const v = validateRawOdds(raw, { minEvents: scope === 'prematch' ? 5 : 0, maxAgeMs: 120_000 });
      console.log(`fetch: ${ms} ms, valid=${v.ok}`, JSON.stringify(v.stats), v.errors.join(' | '), v.warnings.join(' | '));
      const bySport: Record<string, number> = {};
      const byMarket: Record<string, number> = {};
      for (const e of raw.events) {
        bySport[e.sport] = (bySport[e.sport] ?? 0) + 1;
        for (const m of e.markets) {
          const t = m.key.split('|').slice(0, 2).join('|');
          byMarket[t] = (byMarket[t] ?? 0) + 1;
        }
      }
      console.log('events by sport:', JSON.stringify(bySport));
      console.log('markets by type:', JSON.stringify(byMarket));
      for (const e of raw.events.slice(0, 3)) {
        console.log(
          `  ${e.sport} | ${e.competition} | ${e.home} – ${e.away} | ${new Date(e.startTime).toISOString()} live=${e.live}`,
          e.state ? JSON.stringify(e.state) : '',
        );
        for (const m of e.markets.slice(0, 4)) {
          console.log(`     ${m.key} open=${m.open} ` + m.selections.map((x) => `${x.key}@${x.odds}`).join(' '));
        }
      }
      if (asJson) console.log(JSON.stringify(raw, null, 2));
      if (save) console.log('saved:', await ctx.fixtures.save(`sample-${s.name}-${scope}.json`, raw));
    } catch (e) {
      const err = e as Error & { kind?: string; details?: unknown };
      console.log(`FAIL (${Math.round(performance.now() - t0)} ms): [${err.kind ?? err.name}] ${err.message}`);
      if (err.details) console.log('details:', JSON.stringify(err.details).slice(0, 1500));
    }
  }
} finally {
  for (const s of adapter.strategies) await s.dispose?.().catch(() => {});
  await browser.close();
}

/** Poslouchá push strategii N sekund: počet zpráv, událostí, trhů a stáří dat (now − fetchedAt). */
async function tryPush(s: (typeof adapter.strategies)[number], sec: number): Promise<void> {
  let n = 0;
  let last: { events: number; markets: number; ageMs: number; valid: boolean } | null = null;
  const ages: number[] = [];
  const stop = await s.subscribe!(
    { scope, sports: [...SPORTS] },
    (raw) => {
      n++;
      const v = validateRawOdds(raw, { minEvents: 0, maxAgeMs: 120_000 });
      const ageMs = Date.now() - raw.fetchedAt;
      ages.push(ageMs);
      last = { events: raw.events.length, markets: raw.events.reduce((k, e) => k + e.markets.length, 0), ageMs, valid: v.ok };
    },
    (err) => console.log('push error:', err.message),
  );
  const timer = setInterval(() => console.log(`  +${n} zpráv`, last ? JSON.stringify(last) : '(zatím nic)'), 5000);
  await new Promise((r) => setTimeout(r, sec * 1000));
  clearInterval(timer);
  await stop();
  ages.sort((a, b) => a - b);
  const q = (p: number) => ages[Math.min(ages.length - 1, Math.floor(p * ages.length))] ?? null;
  console.log(`push: ${n} zpráv za ${sec} s, stáří dat p50 ${q(0.5)} ms / p95 ${q(0.95)} ms, poslední`, JSON.stringify(last));
}
