// Dávkový zápis odds_snapshots (jen změny) – flush jednou za sekundu.
import { insertMany } from '../../infra/db.js';
import { createLogger } from '../../infra/logger.js';

const log = createLogger('snapshots');
const COLS = ['ts', 'bookmaker', 'event_id', 'market', 'selection', 'odds', 'status', 'mode'];
const MAX_BUFFER = 200_000;

export class SnapshotWriter {
  private buf: unknown[][] = [];
  private timer?: NodeJS.Timeout;
  private flushing?: Promise<void>;
  written = 0;
  dropped = 0;

  start(intervalMs = 1000): void {
    this.timer = setInterval(() => void this.flush(), intervalMs);
  }

  push(row: [Date, string, number, string, string, number | null, string, string]): void {
    if (this.buf.length >= MAX_BUFFER) {
      this.dropped++;
      return;
    }
    this.buf.push(row);
  }

  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (!this.buf.length) return;
    const rows = this.buf;
    this.buf = [];
    this.flushing = insertMany('odds_snapshots', COLS, rows)
      .then(() => {
        this.written += rows.length;
      })
      .catch((e) => log.error('flush failed', { error: (e as Error).message, rows: rows.length }))
      .finally(() => {
        this.flushing = undefined;
      });
    return this.flushing;
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.flush();
  }
}
