import { describe, expect, it } from 'vitest';
import { loadFixture } from '../fixtures.js';
import type { HttpClient } from '../http.js';
import type { AdapterContext } from '../types.js';
import { createLogger } from '../../infra/logger.js';
import factory from './index.js';
import { BRANDS, PROBE_PATH, detectBlock, probeAccess } from './platform.js';

interface RecordedResponse {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

const hdrs = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });

/** HttpClient stub vracející nahranou odpověď (bez sítě). */
function stubHttp(rec: RecordedResponse): HttpClient {
  return {
    text: async (url: string) => ({ status: rec.status, headers: new Headers(rec.headers), body: rec.body, ms: 1, url }),
  } as unknown as HttpClient;
}

describe('tipsport platform – WAF block detection', () => {
  it('recognizes the recorded Cloudflare WAF 403 page', async () => {
    const rec = await loadFixture<RecordedResponse>('tipsport', 'waf-403-rest.json');
    expect(rec.url).toBe(BRANDS.tipsport.origin + PROBE_PATH);
    expect(rec.status).toBe(403);
    expect(rec.headers.server).toBe('cloudflare');
    const b = detectBlock(rec.status, rec.body, hdrs(rec.headers));
    expect(b).toEqual({ blocked: true, kind: 'waf-block', rayId: 'a425a5315abe8f89' });
    // ray ID na stránce = cf-ray hlavička
    expect(rec.headers['cf-ray'].startsWith(b.rayId!)).toBe(true);
  });

  it('does not flag normal JSON or foreign 403 responses', () => {
    expect(detectBlock(200, '{"data":{"children":[]}}').blocked).toBe(false);
    expect(detectBlock(403, '{"message":"forbidden"}').blocked).toBe(false);
  });

  it('recognizes an interactive Cloudflare challenge', () => {
    expect(detectBlock(403, '<html><title>Just a moment...</title></html>')).toEqual({ blocked: true, kind: 'cf-challenge' });
    expect(detectBlock(403, '', hdrs({ 'cf-mitigated': 'challenge' })).kind).toBe('cf-challenge');
  });

  it('probeAccess reports the block with status and ray id', async () => {
    const rec = await loadFixture<RecordedResponse>('tipsport', 'waf-403-rest.json');
    const h = await probeAccess(stubHttp(rec), 'tipsport');
    expect(h.ok).toBe(false);
    expect(h.httpStatus).toBe(403);
    expect(h.message).toContain('waf-block');
    expect(h.message).toContain('a425a5315abe8f89');
  });

  it('probeAccess is ok for a JSON 200', async () => {
    const h = await probeAccess(
      stubHttp({ url: '', status: 200, headers: { 'content-type': 'application/json' }, body: '{}' }),
      'tipsport',
    );
    expect(h).toMatchObject({ ok: true, httpStatus: 200 });
  });
});

describe('tipsport adapter', () => {
  it('has no strategies while blocked', () => {
    const ctx = { bookmaker: 'tipsport', log: createLogger('test') } as unknown as AdapterContext;
    const a = factory(ctx);
    expect(a.bookmaker).toBe('tipsport');
    expect(a.strategies).toEqual([]);
  });
});
