// Aplikuje SQL migrace z db/migrations. Soubory *.timescale.sql jen pokud je TimescaleDB dostupná.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { db, closeDb } from '../infra/db.js';
import { PROJECT_ROOT } from '../adapters/fixtures.js';
import { createLogger } from '../infra/logger.js';
import { MARKET_TYPES } from '../core/types.js';
import { REQUIRED_SELECTIONS, marketLabel, marketKey, marketHasLine } from '../core/markets.js';

const log = createLogger('migrate');

export async function migrate(): Promise<{ timescale: boolean; applied: string[] }> {
  const pool = db();
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  let timescale = false;
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS timescaledb');
    timescale = true;
  } catch (e) {
    log.warn('TimescaleDB není k dispozici – časové řady budou obyčejné tabulky', { error: (e as Error).message });
  }
  const dir = join(PROJECT_ROOT, 'db', 'migrations');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const done = new Set((await pool.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    if (f.endsWith('.timescale.sql') && !timescale) continue;
    const sql = await readFile(join(dir, f), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
      await client.query('COMMIT');
      applied.push(f);
      log.info(`applied ${f}`);
    } catch (e) {
      await client.query('ROLLBACK');
      throw new Error(`migration ${f} failed: ${(e as Error).message}`);
    } finally {
      client.release();
    }
  }
  // číselník typů trhů z kódu
  for (const t of MARKET_TYPES) {
    const label = marketLabel(marketHasLine(t) ? marketKey(t, 'MATCH', 0) : marketKey(t, 'MATCH')).split(' · ')[0];
    await pool.query(
      `INSERT INTO market_types (code, name, selections) VALUES ($1,$2,$3)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, selections = EXCLUDED.selections`,
      [t, label, REQUIRED_SELECTIONS[t]],
    );
  }
  return { timescale, applied };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then((r) => log.info('migrations done', r))
    .catch((e) => {
      log.error(e.message);
      process.exitCode = 1;
    })
    .finally(() => closeDb());
}
