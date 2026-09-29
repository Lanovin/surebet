import type { Redis } from 'ioredis';
import { db } from './db.js';
import { CH, createRedis } from './redis.js';
import { deepMerge, resolveSettings, settingsSchema, type Settings } from '../core/settings.js';

/**
 * Nastavení sdílené mezi službami: zdroj pravdy je Postgres (settings.key='app'),
 * změna se rozešle přes Redis pub/sub a každá služba si ji načte bez restartu.
 */
export class SettingsStore {
  private current: Settings = resolveSettings(undefined);
  private listeners = new Set<(s: Settings, prev: Settings) => void>();
  private sub?: Redis;

  get(): Settings {
    return this.current;
  }

  async load(): Promise<Settings> {
    const r = await db().query<{ value: unknown }>(`SELECT value FROM settings WHERE key = 'app'`);
    this.current = resolveSettings(r.rows[0]?.value);
    return this.current;
  }

  /** Začne poslouchat změny od ostatních služeb. */
  async watch(): Promise<void> {
    this.sub = createRedis('settings-sub');
    await this.sub.subscribe(CH.settingsChanged);
    this.sub.on('message', async () => {
      const prev = this.current;
      await this.load();
      for (const l of this.listeners) l(this.current, prev);
    });
  }

  onChange(fn: (s: Settings, prev: Settings) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Aplikuje částečnou změnu, zvaliduje, uloží a rozešle. */
  async update(patch: unknown, pub: Redis): Promise<Settings> {
    const next = settingsSchema.parse(deepMerge(this.current, patch));
    await db().query(
      `INSERT INTO settings (key, value, updated_at) VALUES ('app', $1, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify(next)],
    );
    const prev = this.current;
    this.current = next;
    for (const l of this.listeners) l(next, prev);
    await pub.publish(CH.settingsChanged, String(Date.now()));
    return next;
  }

  async close(): Promise<void> {
    await this.sub?.quit().catch(() => {});
  }
}
