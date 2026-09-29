import pg from 'pg';
import { env } from './env.js';

// numeric -> number, bigint (id) -> number (bezpečné pro naše rozsahy)
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

let pool: pg.Pool | undefined;

export function db(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: Number(process.env.PG_POOL_MAX ?? 5) });
    pool.on('error', (err) => console.error('[db] pool error', err.message));
  }
  return pool;
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

/** Hromadný INSERT – rows jako pole hodnot ve stejném pořadí jako columns. */
export async function insertMany(table: string, columns: string[], rows: unknown[][], suffix = ''): Promise<void> {
  if (!rows.length) return;
  const CHUNK = Math.max(1, Math.floor(30000 / columns.length));
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const params: unknown[] = [];
    const values = chunk
      .map((r) => `(${r.map((v) => (params.push(v), `$${params.length}`)).join(',')})`)
      .join(',');
    await db().query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${values} ${suffix}`, params);
  }
}
