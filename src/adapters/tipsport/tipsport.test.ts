import { describe, expect, it } from 'vitest';
import { loadFixture } from '../fixtures.js';
import type { HttpClient } from '../http.js';
import type { AdapterContext } from '../types.js';
import { createLogger } from '../../infra/logger.js';
import factory from './index.js';
import { BRANDS, OFFER_LIMIT, PROBE_PATH, detectBlock, platformTargets, probeAccess } from './platform.js';
import { parseTipsport, SUPERSPORT_IDS } from './parse.js';
import { validateRawOdds } from '../../core/validate.js';
import type { RawEvent } from '../../core/types.js';

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

  it('prematch targets: one full-offer POST per superSport', () => {
    const t = platformTargets(BRANDS.tipsport.origin, 'prematch');
    expect(t).toHaveLength(Object.keys(SUPERSPORT_IDS).length);
    expect(new Set(t.map((x) => x.sport))).toEqual(new Set(Object.values(SUPERSPORT_IDS)));
    const fb = t.find((x) => x.sport === 'football')!;
    expect(fb).toMatchObject({ method: 'POST', url: `https://www.tipsport.cz/rest/offer/v2/offer?limit=${OFFER_LIMIT}` });
    expect(JSON.parse(fb.body!)).toMatchObject({ type: 'SUPERSPORT', id: 16, limit: OFFER_LIMIT, withLive: false });
  });

  it('live target: entities + odds parts', () => {
    const [t] = platformTargets(BRANDS.chance.origin, 'live');
    expect(t.parts?.map((p) => [p.name, p.url])).toEqual([
      ['entities', 'https://www.chance.cz/rest/offer/v1/live/in-play/entities'],
      ['odds', 'https://www.chance.cz/rest/offer/v1/live/in-play/event-groups/odds'],
    ]);
  });
});

const keys = (e: RawEvent) => e.markets.map((m) => m.key);
const odds = (e: RawEvent, key: string) => e.markets.find((m) => m.key === key)?.selections.map((s) => [s.key, s.odds]);

describe('tipsport parse – full offer per superSport (fixtures/tipsport/offer-supersports.json, 2026-10-01)', async () => {
  const offers = await loadFixture<Record<string, unknown>>('tipsport', 'offer-supersports.json');
  const parse = (id: number) => parseTipsport(offers[String(id)], { scope: 'prematch', origin: BRANDS.tipsport.origin, sport: SUPERSPORT_IDS[id] });

  it('football: 1X2 from the „Zápas“ tab (10/02 without 12 → no DC)', () => {
    const e = parse(16)[0];
    expect(e).toMatchObject({ sourceId: '8257127', sport: 'football', competition: 'UEFA - Liga národů', home: 'Ázerbájdžán', away: 'Lichtenštejnsko', live: false });
    expect(e.startTime).toBe(Date.parse('2026-10-01T18:00:00.000+02:00'));
    expect(e.url).toBe('https://www.tipsport.cz/kurzy/zapas/fotbal-azerbajdzan-lichtenstejnsko/8257127');
    expect(keys(e)).toEqual(['1X2|REG']);
    expect(odds(e, '1X2|REG')).toEqual([['HOME', 1.07], ['DRAW', 11.2], ['AWAY', 50]]);
  });

  it('team sports with a 3-way „Zápas“ → 1X2|REG (regular time / 9 innings)', () => {
    for (const [id, sport] of [[23, 'hockey'], [7, 'basketball'], [20, 'handball'], [2, 'american_football'], [6, 'baseball']] as const) {
      const ev = parse(id);
      expect(ev.length, sport).toBeGreaterThan(0);
      expect(ev.every((e) => e.sport === sport && keys(e).includes('1X2|REG')), sport).toBe(true);
    }
    expect(odds(parse(2)[0], '1X2|REG')).toEqual([['HOME', 2.37], ['DRAW', 15.6], ['AWAY', 1.71]]);
  });

  it('individual sports: 2-way ML|MATCH for tennis, table tennis, darts', () => {
    const t = parse(43)[0];
    expect(t).toMatchObject({ sport: 'tennis', home: 'Molčan Alex', away: 'Khachanov Karen', competition: 'ATP Peking - tvrdý p.' });
    expect(odds(t, 'ML|MATCH')).toEqual([['HOME', 4.16], ['AWAY', 1.24]]);
    expect(keys(parse(40)[0])).toEqual(['ML|MATCH']);
    expect(odds(parse(42)[0], 'ML|MATCH')).toEqual([['HOME', 2.82], ['AWAY', 1.42]]);
  });

  it('MMA and boxing: 3-way result → 1X2|REG, 2-way winner skipped', () => {
    expect(odds(parse(208)[0], '1X2|REG')).toEqual([['HOME', 2.68], ['DRAW', 45], ['AWAY', 1.42]]);
    expect(parse(208).every((e) => e.sport === 'mma' && keys(e).every((k) => k === '1X2|REG'))).toBe(true);
    expect(parse(11)[0]).toMatchObject({ sport: 'boxing', home: 'Alvarez Ronny', away: 'Carmona Narciso' });
  });

  it('all fixtures validate', () => {
    const all = Object.keys(offers).flatMap((id) => parse(Number(id)));
    expect(new Set(all.map((e) => e.sport)).size).toBe(11);
    const v = validateRawOdds({ bookmaker: 'tipsport', strategy: 'camoufox', scope: 'prematch', fetchedAt: Date.now(), events: all }, { minEvents: 1, maxAgeMs: 60_000 });
    expect(v.errors).toEqual([]);
  });
});

describe('tipsport parse – live in-play entities + odds (fixtures/tipsport/live-in-play.json)', async () => {
  const json = await loadFixture('tipsport', 'live-in-play.json');
  const ev = parseTipsport(json, { scope: 'live', origin: BRANDS.tipsport.origin });

  it('joins matches with odds groups; skips e-sports, races and golf', () => {
    expect(ev).toHaveLength(9);
    expect(new Set(ev.map((e) => e.sport))).toEqual(new Set(['football', 'tennis', 'handball', 'snooker', 'table_tennis', 'darts', 'volleyball']));
    const v = validateRawOdds({ bookmaker: 'tipsport', strategy: 'camoufox', scope: 'live', fetchedAt: Date.now(), events: ev }, { minEvents: 1, maxAgeMs: 60_000 });
    expect(v.errors).toEqual([]);
  });

  it('football: 1X2 and goals total with status text and score', () => {
    const e = ev.find((x) => x.sourceId === '8603683')!;
    expect(e).toMatchObject({ sport: 'football', competition: '2. egyptská liga', home: 'El Mansoura', away: 'FC Masar', live: true });
    expect(e.state).toEqual({ statusText: '2.pol. - 49.min (0:0, 0:0)', score: [0, 0] });
    expect(odds(e, '1X2|REG')).toEqual([['HOME', 11], ['DRAW', 2.5], ['AWAY', 1.6]]);
    expect(odds(e, 'OU|REG|1.5')).toEqual([['UNDER', 1.38], ['OVER', 2.67]]);
  });

  it('tennis and snooker: ML|MATCH, tennis games total; no score for individual sports', () => {
    const t = ev.find((x) => x.sourceId === '8608270')!;
    expect(keys(t)).toEqual(['ML|MATCH', 'OU|MATCH|19.5']);
    expect(t.state).toEqual({ statusText: '2.set - 3:6, 0:0 (00:00*)' });
    expect(odds(ev.find((x) => x.sourceId === '8608898')!, 'ML|MATCH')).toEqual([['HOME', 1.04], ['AWAY', 8]]);
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