import { StrategyError } from './types.js';

export const DEFAULT_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** Statusy, které se nemají považovat za chybu. */
  allowStatus?: number[];
  signal?: AbortSignal;
}

export interface HttpResponse<T> {
  status: number;
  headers: Headers;
  body: T;
  ms: number;
  url: string;
}

/**
 * Tenký obal nad fetch: výchozí hlavičky prohlížeče, cookie jar sázkovky,
 * timeouty, minimální rozestup mezi požadavky (rate limit) a omezení souběhu.
 */
export class HttpClient {
  private cookies = new Map<string, string>();
  private lastRequestAt = 0;
  private active = 0;
  private waiters: (() => void)[] = [];
  readonly defaultHeaders: Record<string, string>;

  constructor(
    readonly opts: {
      minIntervalMs?: number;
      maxConcurrent?: number;
      headers?: Record<string, string>;
      timeoutMs?: number;
    } = {},
  ) {
    this.defaultHeaders = {
      'user-agent': DEFAULT_UA,
      accept: 'application/json, text/plain, */*',
      'accept-language': 'cs-CZ,cs;q=0.9,en;q=0.8',
      ...opts.headers,
    };
  }

  setCookie(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  /** Převezme cookies ve formátu hlavičky Cookie (např. z Playwright contextu). */
  setCookieHeader(header: string): void {
    for (const part of header.split(';')) {
      const i = part.indexOf('=');
      if (i > 0) this.cookies.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
    }
  }

  cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  clearCookies(): void {
    this.cookies.clear();
  }

  async text(url: string, o: HttpOptions = {}): Promise<HttpResponse<string>> {
    return this.request(url, o, (r) => r.text());
  }

  async json<T = unknown>(url: string, o: HttpOptions = {}): Promise<HttpResponse<T>> {
    return this.request(url, o, async (r) => {
      const txt = await r.text();
      try {
        return JSON.parse(txt) as T;
      } catch {
        throw new StrategyError(`invalid JSON from ${url}`, 'structure', {
          status: r.status,
          sample: txt.slice(0, 500),
        });
      }
    });
  }

  private async request<T>(url: string, o: HttpOptions, read: (r: Response) => Promise<T>): Promise<HttpResponse<T>> {
    await this.acquire();
    const started = performance.now();
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), o.timeoutMs ?? this.opts.timeoutMs ?? 15000);
    const onAbort = () => ctrl.abort();
    o.signal?.addEventListener('abort', onAbort);
    try {
      const headers: Record<string, string> = { ...this.defaultHeaders, ...o.headers };
      const cookie = this.cookieHeader();
      if (cookie && !headers.cookie) headers.cookie = cookie;
      let res: Response;
      try {
        res = await fetch(url, { method: o.method ?? 'GET', headers, body: o.body, signal: ctrl.signal, redirect: 'follow' });
      } catch (err) {
        const aborted = ctrl.signal.aborted;
        throw new StrategyError(`${aborted ? 'timeout' : 'network error'}: ${url}`, aborted ? 'timeout' : 'http', {
          cause: String((err as Error)?.message ?? err),
        });
      }
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const first = c.split(';')[0];
        const i = first.indexOf('=');
        if (i > 0) this.cookies.set(first.slice(0, i).trim(), first.slice(i + 1).trim());
      }
      if (!res.ok && !(o.allowStatus ?? []).includes(res.status)) {
        const sample = (await res.text().catch(() => '')).slice(0, 800);
        const blocked = res.status === 403 || res.status === 429 || /cloudflare|captcha|access denied/i.test(sample);
        throw new StrategyError(`HTTP ${res.status} ${url}`, blocked ? 'blocked' : 'http', {
          status: res.status,
          server: res.headers.get('server'),
          sample,
        });
      }
      const body = await read(res);
      return { status: res.status, headers: res.headers, body, ms: performance.now() - started, url: res.url };
    } finally {
      clearTimeout(timeout);
      o.signal?.removeEventListener('abort', onAbort);
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    const max = this.opts.maxConcurrent ?? 4;
    while (this.active >= max) await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
    const min = this.opts.minIntervalMs ?? 0;
    const wait = this.lastRequestAt + min - Date.now();
    this.lastRequestAt = Math.max(Date.now(), this.lastRequestAt + min);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  private release(): void {
    this.active--;
    this.waiters.shift()?.();
  }
}
