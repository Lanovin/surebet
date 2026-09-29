// Detektor: odebírá diffy kurzů, hledá arby, řídí jejich životní cyklus, ukládá a publikuje je.
import { BOOKMAKERS, type BookmakerId } from '../../core/types.js';
import { createLogger } from '../../infra/logger.js';
import { closeDb } from '../../infra/db.js';
import { CH, KEY, createRedis } from '../../infra/redis.js';
import { SettingsStore } from '../../infra/settingsStore.js';
import { migrate } from '../../db/migrate.js';
import type { ArbEventMessage, BookEventState, EventView, OddsDiffMessage } from '../../shared/protocol.js';
import { ArbEngine } from './engine.js';
import { ArbPersistence } from './persist.js';
import { Predictor } from './predictor.js';

const log = createLogger('detector');

async function main(): Promise<void> {
  await migrate();
  const settings = new SettingsStore();
  await settings.load();
  await settings.watch();
  const pub = createRedis('detector');
  const sub = createRedis('detector-sub');
  const persistence = new ArbPersistence();
  const censored = await persistence.markRestart();
  if (censored) log.info(`${censored} arbů z předchozího běhu ukončeno jako system_restart (cenzurováno)`);
  persistence.start();
  await pub.del(KEY.activeArbs);

  const predictor = new Predictor(() => settings.get());
  await predictor.refresh().catch((e) => log.warn('predictor refresh failed', { error: (e as Error).message }));

  const engine = new ArbEngine({
    settings: () => settings.get(),
    now: () => Date.now(),
    predict: (f, a) => predictor.predict(f, a),
    emit: (kind, arb, dto, dataAt) => {
      const msg: ArbEventMessage = { kind, arb: dto, detectedAt: Date.now(), dataAt };
      const p = pub.pipeline();
      if (kind === 'end') p.hdel(KEY.activeArbs, arb.id);
      else p.hset(KEY.activeArbs, arb.id, JSON.stringify(dto));
      p.publish(CH.arbEvents, JSON.stringify(msg));
      void p.exec();
      if (kind === 'new') log.info(`NEW ${dto.mode} ${dto.margin.toFixed(2)} % ${dto.eventName} | ${dto.marketLabel} | ${dto.legs.map((l) => `${l.bookmaker}:${l.selection}@${l.odds}`).join(' ')}`);
      else if (kind === 'end') log.debug(`END ${dto.eventName} ${dto.marketLabel} ${arb.endReason} ${Math.round(((arb.endedAt ?? 0) - arb.firstSeen) / 1000)} s`);
    },
    persistNew: (arb, dto) => persistence.newArb(arb, dto),
    persistTick: (arb) => persistence.tick(arb),
    persistEnd: (arb) => persistence.endArb(arb),
  });

  // počáteční stav z Redisu (pokud ingest už běží)
  const evRaw = await pub.hgetall(KEY.events);
  const events = Object.values(evRaw).map((v) => JSON.parse(v) as EventView);
  const states: [BookmakerId, number, BookEventState][] = [];
  for (const bk of BOOKMAKERS) {
    const h = await pub.hgetall(KEY.bookState(bk));
    for (const [id, v] of Object.entries(h)) states.push([bk, Number(id), JSON.parse(v) as BookEventState]);
  }
  engine.loadState(events, states);
  log.info('state loaded', { events: events.length, bookStates: states.length, active: engine.active.size });

  await sub.subscribe(CH.oddsDiff, CH.control);
  sub.on('message', (ch, payload) => {
    try {
      if (ch === CH.control) {
        const m = JSON.parse(payload) as { type: string };
        if (m.type === 'ingest_start') {
          log.info('ingest restartoval – reset stavu detektoru');
          engine.reset();
        }
        return;
      }
      engine.applyDiff(JSON.parse(payload) as OddsDiffMessage);
    } catch (e) {
      log.error('diff failed', { error: (e as Error).message });
    }
  });

  settings.onChange(() => engine.reevaluateAll());

  const sweep = setInterval(() => engine.sweep(), 500);
  const heartbeat = setInterval(() => persistence.heartbeat([...engine.active.values()]), 5_000);
  const refresh = setInterval(() => void predictor.refresh().catch(() => {}), 60_000);
  const statsTimer = setInterval(() => {
    void pub.set(
      'detector:stats',
      JSON.stringify({ ...engine.stats, active: engine.active.size, events: engine.events.size, predictor: predictor.info(), updatedAt: Date.now() }),
    );
  }, 2_000);

  const shutdown = async () => {
    log.info('shutting down – aktivní arby končí jako system_restart');
    clearInterval(sweep);
    clearInterval(heartbeat);
    clearInterval(refresh);
    clearInterval(statsTimer);
    engine.shutdown();
    await persistence.stop();
    await pub.del(KEY.activeArbs);
    await settings.close();
    await sub.quit().catch(() => {});
    await pub.quit().catch(() => {});
    await closeDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  log.error('fatal', { error: (e as Error).stack ?? String(e) });
  process.exit(1);
});
