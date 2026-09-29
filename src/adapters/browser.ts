import type { BrowserContext, Page, Response } from 'playwright';
import { join } from 'node:path';
import type { BookmakerId } from '../core/types.js';
import { PROJECT_ROOT } from './fixtures.js';
import { createLogger } from '../infra/logger.js';

const log = createLogger('browser');

export interface CapturedResponse {
  url: string;
  status: number;
  body: string;
  json?: unknown;
}

export interface CaptureOptions {
  /** Kam navigovat. Když chybí, jen se poslouchá na už otevřené stránce. */
  url?: string;
  /** Které odpovědi zachytit. */
  match: (url: string, resourceType: string) => boolean;
  timeoutMs?: number;
  /** Kolik odpovědí stačí (default 1). */
  minResponses?: number;
  /** Jak dlouho ještě sbírat po dosažení minResponses (ms). */
  settleMs?: number;
  /** Vynutí reload, i když stránka už je na dané URL. */
  reload?: boolean;
}

/**
 * Jeden headless Chromium pro celý ingest, jeden sdílený (perzistentní) browser context
 * a nejvýš jedna stránka na sázkovku. Při nečinnosti se prohlížeč zavře, aby nežral paměť.
 */
export class BrowserPool {
  private context?: BrowserContext;
  private launching?: Promise<BrowserContext>;
  private pages = new Map<BookmakerId, Page>();
  private locks = new Map<BookmakerId, Promise<unknown>>();
  private lastUse = Date.now();
  private idleTimer?: NodeJS.Timeout;

  constructor(
    readonly opts: {
      headless?: boolean;
      channel?: string;
      idleCloseMs?: number;
      userDataDir?: string;
      blockResources?: boolean;
    } = {},
  ) {}

  get isRunning(): boolean {
    return !!this.context;
  }

  get openPages(): number {
    return this.pages.size;
  }

  private async ensureContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    if (!this.launching) {
      this.launching = (async () => {
        const { chromium } = await import('playwright');
        const headless = this.opts.headless ?? process.env.BROWSER_HEADLESS !== '0';
        const channel = this.opts.channel ?? process.env.BROWSER_CHANNEL ?? undefined;
        const userDataDir = this.opts.userDataDir ?? join(PROJECT_ROOT, '.infra', 'browser-profile');
        log.info('launching chromium', { headless, channel: channel ?? 'bundled', userDataDir });
        const ctx = await chromium.launchPersistentContext(userDataDir, {
          headless,
          channel,
          locale: 'cs-CZ',
          timezoneId: 'Europe/Prague',
          viewport: { width: 1366, height: 900 },
          args: ['--disable-dev-shm-usage', '--disable-gpu', '--mute-audio', '--disable-extensions', '--no-first-run'],
        });
        ctx.on('close', () => {
          this.context = undefined;
          this.pages.clear();
        });
        this.context = ctx;
        // perzistentní context otevírá prázdnou stránku – zavřeme ji
        for (const p of ctx.pages()) await p.close().catch(() => {});
        this.armIdle();
        return ctx;
      })().finally(() => {
        this.launching = undefined;
      });
    }
    return this.launching;
  }

  private armIdle(): void {
    clearInterval(this.idleTimer);
    const idle = this.opts.idleCloseMs ?? 10 * 60_000;
    this.idleTimer = setInterval(() => {
      if (this.context && Date.now() - this.lastUse > idle) {
        log.info('closing idle chromium');
        void this.close();
      }
    }, 30_000);
    this.idleTimer.unref();
  }

  /** Stránka dané sázkovky (vytvoří se při prvním použití). */
  async page(bk: BookmakerId): Promise<Page> {
    this.lastUse = Date.now();
    const existing = this.pages.get(bk);
    if (existing && !existing.isClosed()) return existing;
    const ctx = await this.ensureContext();
    const page = await ctx.newPage();
    if (this.opts.blockResources ?? true) {
      await page.route('**/*', (route) => {
        const t = route.request().resourceType();
        if (t === 'image' || t === 'media' || t === 'font') return route.abort();
        return route.continue();
      });
    }
    page.on('close', () => this.pages.delete(bk));
    this.pages.set(bk, page);
    return page;
  }

  /** Serializuje práci na stránce jedné sázkovky (fetch z více scope nesmí navigovat současně). */
  async withPage<T>(bk: BookmakerId, fn: (page: Page) => Promise<T>): Promise<T> {
    const prev = this.locks.get(bk) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(async () => fn(await this.page(bk)));
    this.locks.set(bk, run);
    try {
      return await run;
    } finally {
      this.lastUse = Date.now();
      if (this.locks.get(bk) === run) this.locks.delete(bk);
    }
  }

  /** Naviguje (volitelně) a zachytí síťové odpovědi odpovídající `match`. */
  async capture(bk: BookmakerId, o: CaptureOptions): Promise<CapturedResponse[]> {
    return this.withPage(bk, async (page) => {
      const got: CapturedResponse[] = [];
      const pending: Promise<void>[] = [];
      let resolveEnough!: () => void;
      const enough = new Promise<void>((r) => (resolveEnough = r));
      const onResponse = (res: Response) => {
        const req = res.request();
        if (!o.match(res.url(), req.resourceType())) return;
        pending.push(
          (async () => {
            try {
              const body = await res.text();
              let json: unknown;
              try {
                json = JSON.parse(body);
              } catch {
                /* ne-JSON odpověď */
              }
              got.push({ url: res.url(), status: res.status(), body, json });
              if (got.length >= (o.minResponses ?? 1)) resolveEnough();
            } catch {
              /* tělo už není dostupné (redirect apod.) */
            }
          })(),
        );
      };
      page.on('response', onResponse);
      try {
        const timeout = o.timeoutMs ?? 30_000;
        if (o.url && (o.reload || page.url() !== o.url)) {
          await page.goto(o.url, { waitUntil: 'domcontentloaded', timeout });
        } else if (o.reload) {
          await page.reload({ waitUntil: 'domcontentloaded', timeout });
        }
        await Promise.race([enough, new Promise((r) => setTimeout(r, timeout))]);
        if (o.settleMs) await new Promise((r) => setTimeout(r, o.settleMs));
        await Promise.allSettled(pending);
        return got;
      } finally {
        page.off('response', onResponse);
      }
    });
  }

  /** Zavolá fetch() uvnitř stránky (same-origin, cookies a TLS otisk prohlížeče). */
  async fetchInPage(
    bk: BookmakerId,
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string; credentials?: 'include' | 'omit' | 'same-origin' } = {},
  ): Promise<{ status: number; body: string }> {
    return this.withPage(bk, (page) =>
      page.evaluate(
        async ({ url, init }) => {
          // API s "Access-Control-Allow-Origin: *" (např. Altenar) odmítá požadavky s cookies -> credentials: 'omit'
          const r = await fetch(url, { credentials: 'include', ...init });
          return { status: r.status, body: await r.text() };
        },
        { url, init },
      ),
    );
  }

  async cookieHeader(url: string): Promise<string> {
    const ctx = await this.ensureContext();
    const cookies = await ctx.cookies(url);
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  async closePage(bk: BookmakerId): Promise<void> {
    await this.pages.get(bk)?.close().catch(() => {});
    this.pages.delete(bk);
  }

  async close(): Promise<void> {
    clearInterval(this.idleTimer);
    const ctx = this.context;
    this.context = undefined;
    this.pages.clear();
    await ctx?.close().catch(() => {});
  }
}
