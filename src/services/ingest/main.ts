// Ingest: adaptéry -> validace -> párování -> stav kurzů v Redisu + diffy (pub/sub) + odds_snapshots.
import { BOOKMAKERS, type BookmakerId, type RawOdds } from '../../core/types.js';
import { env } from '../../infra/env.js';
import { createLogger } from '../../infra/logger.js';
import { db, closeDb } from '../../infra/db.js';
import { CH, KEY, createRedis } from '../../infra/redis.js';
import { SettingsStore } from '../../infra/settingsStore.js';
import { migrate } from '../../db/migrate.js';
import { HttpClient } from '../../adapters/http.js';
import { BrowserPool } from '../../adapters/browser.js';
import { Fixtures } from '../../adapters/fixtures.js';
import { AdapterRunner, type HealthEvent } from '../../adapters/runner.js';
import { buildAdapters } from '../../adapters/registry.js';
import type { AdapterContext } from '../../adapters/types.js';
import { Matcher } from '../matching/matcher.js';
import { expireUnmatched } from '../matching/review.js';
import { EventTracker } from './eventTracker.js';
import { BookStore, type LinkedEvent } from './bookStore.js';
import { SnapshotWriter } from './snapshots.js';
import type { HealthDTO, OddsDiffMessage } from '../../shared/protocol.js';

const log = createLogger('ingest');

async function main(): Promise<void> {
  await migrate();
  const settings = new SettingsStore();
  await settings.load();
  await settings.watch();
  const redis = createRedis('ingest');
  const sub = createRedis('ingest-sub');
  const matcher = new Matcher(() => settings.get());
  await matcher.load();
  const tracker = new EventTracker(() => settings.get());
  const store = new BookStore();
  const snapshots = new SnapshotWriter();
  snapshots.start();
  const browser = new BrowserPool();
  const counts = new Map<BookmakerId, { matched: number; unmatched: number }>();

  // Stav z minulého běhu už neplatí – detektor si načte čistý stav.
  await redis.del(...BOOKMAKERS.map((b) => KEY.bookState(b)), KEY.events);
  // detektor zahodí stav z minulého běhu (aktivní arby končí jako system_restart = cenzurováno)
  await redis.publish(CH.control, JSON.stringify({ type: 'ingest_start', at: Date.now(), source: env.DATA_SOURCE }));

  const ctxFor = (bk: BookmakerId): AdapterContext => ({
    bookmaker: bk,
    http: new HttpClient({ minIntervalMs: 120, maxConcurrent: 4 }),
    browser,
    fixtures: new Fixtures(bk),
    log: createLogger(`adapter:${bk}`),
  });

  const source = env.DATA_SOURCE === 'real' ? 'real' : 'sim';
  const { adapters, missing } = await buildAdapters(source, env.BOOKMAKERS, ctxFor);
  if (missing.length) log.warn(`bez adaptéru (zatím neimplementováno): ${missing.join(', ')}`);
  log.info(`zdroj dat: ${source}, adaptéry: ${adapters.map((a) => a.bookmaker).join(', ')}`);

  const onHealth = (ev: HealthEvent) => {
    log.info(`health ${ev.bookmaker}/${ev.scope}: ${ev.event} ${ev.prevStrategy ?? ''}${ev.prevStrategy ? ' -> ' : ''}${ev.strategy} [${ev.state}] ${ev.reason ?? ''}`);
    void db()
      .query(
        `INSERT INTO adapter_health (bookmaker, scope, event, strategy, level, state, prev_state, prev_strategy, reason, details)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, ts`,
        [ev.bookmaker, ev.scope, ev.event, ev.strategy, ev.level, ev.state, ev.prevState ?? null, ev.prevStrategy ?? null, ev.reason ?? null, ev.details ? JSON.stringify(ev.details) : null],
      )
      .then((r) =>
        redis.publish(
          CH.health,
          JSON.stringify({
            id: r.rows[0].id,
            ts: new Date(r.rows[0].ts).getTime(),
            bookmaker: ev.bookmaker,
            scope: ev.scope,
            event: ev.event,
            strategy: ev.strategy,
            level: ev.level,
            state: ev.state,
            prevState: ev.prevState ?? null,
            prevStrategy: ev.prevStrategy ?? null,
            reason: ev.reason ?? null,
          }),
        ),
      )
      .catch((e) => log.error('health insert failed', { error: (e as Error).message }));
  };

  /** Konsenzus: když je velký podíl kurzů mimo ostatní sázkovky, odpověď je nejspíš rozbitá (prohozené výběry apod.). */
  const postValidate = (raw: RawOdds): string | null => {
    const cfg = settings.get().consensus;
    let compared = 0;
    let outliers = 0;
    for (const ev of raw.events) {
      const link = matcher.peekLink(raw.bookmaker, ev.sourceId);
      if (!link) continue;
      for (const m of ev.markets) {
        if (!m.open) continue;
        for (const s of m.selections) {
          const key = link.swapped ? m.key : m.key; // orientace se liší jen u AH/týmových trhů; hrubý test stačí na 1X2/ML/OU
          if (link.swapped && /^(AH|AH_SETS|OU_HOME|OU_AWAY)\|/.test(key)) continue;
          const sel = link.swapped ? (s.key === 'HOME' ? 'AWAY' : s.key === 'AWAY' ? 'HOME' : s.key) : s.key;
          const others = store.othersOdds(raw.bookmaker, link.eventId, key, sel);
          if (others.length < cfg.minBooks) continue;
          const med = median(others.map((o) => 1 / o));
          compared++;
          if (Math.abs(1 / s.odds - med) / med > cfg.maxDeviationPct / 100) outliers++;
        }
      }
    }
    if (compared >= 30 && outliers / compared > 0.3) return `${outliers}/${compared} kurzů mimo konsenzus`;
    return null;
  };

  const processRaw = async (raw: RawOdds): Promise<void> => {
    const now = Date.now();
    const isSim = raw.strategy.startsWith('sim');
    const items: LinkedEvent[] = [];
    let unmatched = 0;
    for (const ev of raw.events) {
      const r = await matcher.resolve(raw.bookmaker, ev, isSim);
      if (r.status !== 'linked') {
        unmatched++;
        continue;
      }
      const canon = matcher.getEvent(r.eventId);
      if (!canon) continue;
      items.push({ eventId: r.eventId, swapped: r.swapped, raw: ev });
      tracker.report(canon, raw.bookmaker, ev, r.swapped, now);
    }
    const c = counts.get(raw.bookmaker) ?? { matched: 0, unmatched: 0 };
    if (raw.scope === 'prematch') (c.matched = items.length), (c.unmatched = unmatched);
    counts.set(raw.bookmaker, c);

    const diff = store.apply(raw.bookmaker, raw.scope, raw.fetchedAt, items);
    const events = tracker.drainChanged(now);
    const msg: OddsDiffMessage = {
      bk: raw.bookmaker,
      scope: raw.scope,
      fetchedAt: raw.fetchedAt,
      publishedAt: Date.now(),
      seen: diff.seen,
      removed: diff.removed,
      states: diff.states,
      changes: diff.changes,
      events,
    };
    const p = redis.pipeline();
    const st = Object.entries(diff.states);
    if (st.length) p.hset(KEY.bookState(raw.bookmaker), Object.fromEntries(st.map(([id, s]) => [id, JSON.stringify(s)])));
    if (diff.removed.length) p.hdel(KEY.bookState(raw.bookmaker), ...diff.removed.map(String));
    if (events.length) p.hset(KEY.events, Object.fromEntries(events.map((e) => [String(e.id), JSON.stringify(e)])));
    p.publish(CH.oddsDiff, JSON.stringify(msg));
    await p.exec();

    const ts = new Date(raw.fetchedAt);
    for (const ch of diff.changes) {
      const mode = tracker.get(ch.eventId)?.mode ?? (raw.scope === 'live' ? 'LIVE' : 'PREMATCH');
      snapshots.push([ts, raw.bookmaker, ch.eventId, ch.market, ch.sel, ch.odds, ch.status, mode]);
    }
  };

  // zpracování sériově, aby se diffy jedné sázkovky nepředbíhaly
  let chain: Promise<void> = Promise.resolve();
  const runners = adapters.map(
    (a) =>
      new AdapterRunner(a, ctxFor(a.bookmaker), {
        onData: (raw) => {
          chain = chain.then(() => processRaw(raw)).catch((e) => log.error('process failed', { bk: raw.bookmaker, error: (e as Error).message }));
          return chain;
        },
        onHealth,
        liveDemand: (bk) => tracker.liveDemand(bk),
        postValidate,
        settings: () => settings.get(),
      }),
  );
  for (const r of runners) {
    if (settings.get().bookmakers[r.bookmaker]?.enabled !== false) r.start();
  }

  // povolení / zakázání sázkovky z nastavení bez restartu
  settings.onChange((s, prev) => {
    for (const r of runners) {
      const en = s.bookmakers[r.bookmaker]?.enabled !== false;
      const was = prev.bookmakers[r.bookmaker]?.enabled !== false;
      if (en && !was) r.start();
      if (!en && was) void r.stop();
    }
  });

  // časové přepočty režimů (fallback pauzy) + publikace změněných událostí
  const eventTimer = setInterval(() => {
    const now = Date.now();
    tracker.tick(now);
    const events = tracker.drainChanged(now);
    if (!events.length) return;
    const msg: OddsDiffMessage = { bk: null, scope: 'live', fetchedAt: now, publishedAt: now, seen: [], removed: [], states: {}, changes: [], events };
    void redis
      .pipeline()
      .hset(KEY.events, Object.fromEntries(events.map((e) => [String(e.id), JSON.stringify(e)])))
      .publish(CH.oddsDiff, JSON.stringify(msg))
      .exec();
  }, 1000);

  // zdraví adaptérů pro dashboard
  const healthTimer = setInterval(() => {
    const now = Date.now();
    const list: HealthDTO[] = BOOKMAKERS.map((bk) => {
      const r = runners.find((x) => x.bookmaker === bk);
      const st = r?.status();
      const c = counts.get(bk);
      return {
        bookmaker: bk,
        state: st?.state ?? 'BLOCKED',
        enabled: settings.get().bookmakers[bk]?.enabled !== false,
        source: r ? source : 'none',
        scopes: st?.scopes ?? [],
        matchedEvents: c?.matched ?? 0,
        unmatchedEvents: c?.unmatched ?? 0,
        updatedAt: now,
      };
    });
    void redis
      .pipeline()
      .hset(KEY.health, Object.fromEntries(list.map((h) => [h.bookmaker, JSON.stringify(h)])))
      .set('health:meta', JSON.stringify({ source, updatedAt: now, snapshotsWritten: snapshots.written, pendingUnmatched: matcher.pendingCount() }))
      .publish(CH.health, JSON.stringify({ snapshot: list }))
      .exec();
  }, 2000);

  const maintenance = setInterval(() => {
    matcher.prune();
    void expireUnmatched().catch(() => {});
  }, 5 * 60_000);

  await sub.subscribe(CH.unmatched);
  sub.on('message', (_ch, payload) => {
    try {
      const m = JSON.parse(payload) as { bookmaker: BookmakerId; sourceEventId: string; action: 'confirmed' | 'rejected'; candidateId?: number };
      void matcher.onResolved(m.bookmaker, m.sourceEventId, m.action, m.candidateId);
    } catch {
      /* ignore */
    }
  });

  const shutdown = async () => {
    log.info('shutting down');
    clearInterval(eventTimer);
    clearInterval(healthTimer);
    clearInterval(maintenance);
    for (const r of runners) await r.stop();
    await snapshots.stop();
    await browser.close();
    await settings.close();
    await sub.quit().catch(() => {});
    await redis.quit().catch(() => {});
    await closeDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

main().catch((e) => {
  log.error('fatal', { error: (e as Error).stack ?? String(e) });
  process.exit(1);
});
