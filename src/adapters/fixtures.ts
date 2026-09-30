import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BookmakerId } from '../core/types.js';

export const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXTURES_DIR = join(PROJECT_ROOT, 'fixtures');

/** Ukládání vzorků odpovědí – funkční (pro testy) i rozbitých (pro diagnostiku). */
export class Fixtures {
  private lastBrokenAt = 0;
  constructor(readonly bookmaker: BookmakerId) {}

  dir(): string {
    return join(FIXTURES_DIR, this.bookmaker);
  }

  async save(name: string, data: unknown): Promise<string> {
    const file = join(this.dir(), name.endsWith('.json') || name.endsWith('.html') ? name : `${name}.json`);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
    return file;
  }

  /** fixtures/<bookmaker>/broken-<datum>.json; nejvýš jednou za 10 minut, aby se disk nezaplnil. */
  async saveBroken(info: { strategy: string; error: string; details?: unknown; sample?: unknown }): Promise<string | null> {
    // simulátor chyby záměrně vyrábí – jejich vzorky nemají diagnostickou hodnotu
    if (info.strategy.startsWith('sim')) return null;
    if (Date.now() - this.lastBrokenAt < 10 * 60_000) return null;
    this.lastBrokenAt = Date.now();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return this.save(`broken-${stamp}.json`, { savedAt: new Date().toISOString(), bookmaker: this.bookmaker, ...info });
  }
}

export async function loadFixture<T = unknown>(bookmaker: BookmakerId, name: string): Promise<T> {
  const txt = await readFile(join(FIXTURES_DIR, bookmaker, name), 'utf8');
  return (name.endsWith('.json') ? JSON.parse(txt) : txt) as T;
}

export async function listFixtures(bookmaker: BookmakerId): Promise<string[]> {
  try {
    return await readdir(join(FIXTURES_DIR, bookmaker));
  } catch {
    return [];
  }
}
