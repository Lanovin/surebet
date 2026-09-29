import { describe, expect, it } from 'vitest';
import { loadFixture } from '../fixtures.js';
import type { AdapterContext } from '../types.js';
import { createLogger } from '../../infra/logger.js';
import factory from './index.js';
import { BRANDS, PROBE_PATH, detectBlock } from '../tipsport/platform.js';

interface RecordedResponse {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

describe('chance – shared Tipsport platform', () => {
  it('recognizes the recorded Cloudflare WAF 403 page (same template as Tipsport)', async () => {
    const rec = await loadFixture<RecordedResponse>('chance', 'waf-403-rest.json');
    expect(rec.url).toBe(BRANDS.chance.origin + PROBE_PATH);
    expect(rec.status).toBe(403);
    expect(rec.headers.server).toBe('cloudflare');
    expect(rec.body).toContain('chance'); // brand-specifická verze chybové stránky
    expect(detectBlock(rec.status, rec.body)).toEqual({ blocked: true, kind: 'waf-block', rayId: 'a425a5321ae2b190' });
  });

  it('has no strategies while blocked', () => {
    const ctx = { bookmaker: 'chance', log: createLogger('test') } as unknown as AdapterContext;
    const a = factory(ctx);
    expect(a.bookmaker).toBe('chance');
    expect(a.strategies).toEqual([]);
  });
});
