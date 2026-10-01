import { describe, expect, it } from 'vitest';
import { loadFixture } from '../fixtures.js';
import type { HttpClient } from '../http.js';
import type { AdapterContext } from '../types.js';
import { createLogger } from '../../infra/logger.js';
import factory from './index.js';
import { BRANDS, PROBE_PATH, detectBlock, probeAccess } from './platform.js';
import { parseTipsport } from './parse.js';
import { validateRawOdds } from '../../core/validate.js';

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
  it('uses the camoufox strategy', () => {
    const ctx = { bookmaker: 'tipsport', log: createLogger('test') } as unknown as AdapterContext;
    const a = factory(ctx);
    expect(a.bookmaker).toBe('tipsport');
    expect(a.strategies.map((s) => [s.name, s.level])).toEqual([['camoufox', 5]]);
  });
});

describe('tipsport parse', () => {
  const ctx = { scope: 'prematch' as const, origin: BRANDS.tipsport.origin };
  // tvar podle archivních odpovědí (výpis s oppRows) – po prvním běhu nahradit nahranou fixture
  const listing = {
    matches: [
      {
        id: 5551,
        idSuperSport: 16,
        nameSuperSport: 'Fotbal',
        nameCompetition: '1. liga',
        homeParticipant: 'Sparta Praha',
        visitingParticipant: 'Slavia Praha',
        datetimeClosed: '2026-10-04T18:00:00+02:00',
        matchUrl: '/kurzy/zapas/sparta-praha-slavia-praha-5551',
        oppRows: [
          {
            oppsTab: [
              { label: '1', odd: 2.45, bettingEnabled: true },
              { label: '0', odd: 3.4, bettingEnabled: true },
              { label: '2', odd: 2.8, bettingEnabled: true },
              { label: '10', odd: 1.44, bettingEnabled: true },
              { label: '02', odd: 1.55, bettingEnabled: true },
              { label: '12', odd: 1.31, bettingEnabled: false },
            ],
          },
        ],
      },
      {
        id: 5552,
        idSuperSport: 43,
        nameCompetition: 'ATP Tokio',
        homeParticipant: 'Menšík J.',
        visitingParticipant: 'Lehečka J.',
        datetimeClosed: 1791100000000,
        oppRows: [{ oppsTab: [{ label: '1', odd: 1.9 }, { label: '2', odd: 1.95 }] }],
      },
      {
        id: 5553,
        nameSuperSport: 'Lední hokej',
        nameCompetition: 'Extraliga',
        homeParticipant: 'Sparta',
        visitingParticipant: 'Třinec',
        datetimeClosed: 1791100000000,
        // 2-cestně u hokeje = nejasné (vč. prodloužení?) → vynechat
        oppRows: [{ oppsTab: [{ label: '1', odd: 1.8 }, { label: '2', odd: 2.0 }] }],
      },
    ],
  };

  it('maps 1X2, DC and tennis ML from listing rows', () => {
    const ev = parseTipsport(listing, ctx);
    expect(ev.map((e) => e.sourceId)).toEqual(['5551', '5552']);
    const fb = ev[0];
    expect(fb).toMatchObject({ sport: 'football', home: 'Sparta Praha', away: 'Slavia Praha', competition: '1. liga', live: false });
    expect(fb.startTime).toBe(Date.parse('2026-10-04T16:00:00Z'));
    expect(fb.url).toBe('https://www.tipsport.cz/kurzy/zapas/sparta-praha-slavia-praha-5551');
    expect(fb.markets.map((m) => m.key)).toEqual(['1X2|REG', 'DC|REG']);
    expect(fb.markets[0].selections.map((s) => [s.key, s.odds])).toEqual([['HOME', 2.45], ['DRAW', 3.4], ['AWAY', 2.8]]);
    expect(fb.markets[1].selections.find((s) => s.key === 'HOME_AWAY')?.open).toBe(false);
    expect(ev[1].markets.map((m) => m.key)).toEqual(['ML|MATCH']);
    const v = validateRawOdds({ bookmaker: 'tipsport', strategy: 'camoufox', scope: 'prematch', fetchedAt: Date.now(), events: ev }, { minEvents: 1, maxAgeMs: 60_000 });
    expect(v.errors).toEqual([]);
  });

  it('skips half-time rows and unknown labels', () => {
    const ev = parseTipsport(
      { id: 1, idSuperSport: 16, homeParticipant: 'A', visitingParticipant: 'B', datetimeClosed: 1791100000000,
        eventTables: [{ name: '1. poločas', boxes: [{ cells: [{ name: '1', odd: 3 }, { name: '0', odd: 2 }, { name: '2', odd: 4 }] }] }] },
      ctx,
    );
    expect(ev).toEqual([]);
  });
});