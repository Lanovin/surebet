import { describe, expect, it } from 'vitest';
import type { CamoufoxBridge } from '../camoufox.js';
import type { AdapterContext } from '../types.js';
import type { RawEvent } from '../../core/types.js';
import { createLogger } from '../../infra/logger.js';
import { CamoufoxReplayStrategy, type CamoufoxReplayConfig } from './camoufox-replay.js';

const ev = (id: string, sport: RawEvent['sport'] = 'football'): RawEvent => ({
  sourceId: id,
  sport,
  competition: 'L',
  home: 'A',
  away: 'B',
  startTime: 1791100000000,
  live: false,
  markets: [{ key: 'ML|MATCH', open: true, selections: [{ key: 'HOME', odds: 1.9 }, { key: 'AWAY', odds: 1.9 }] }],
});

/** Bridge stub: url → { status, body }; zaznamenává volání fetchInPage. */
function stubBridge(responses: Record<string, { status: number; body: string }>) {
  const calls: { url: string; method?: string; body?: string }[] = [];
  const bridge = {
    fetchInPage: async (_bk: string, _origin: string, url: string, init: { method?: string; body?: string } = {}) => {
      calls.push({ url, method: init.method, body: init.body });
      const r = responses[url] ?? { status: 404, body: 'not found' };
      return { ...r, contentType: 'application/json' };
    },
    capture: async () => {
      throw new Error('discovery must not run when targets are given');
    },
    close: async () => {},
    health: async () => ({ running: true, pages: [] }),
  } as unknown as CamoufoxBridge;
  return { bridge, calls };
}

const ctx = { bookmaker: 'betano', log: createLogger('test') } as unknown as AdapterContext;

function strategy(cfg: Partial<CamoufoxReplayConfig>, bridge: CamoufoxBridge) {
  return new CamoufoxReplayStrategy(
    {
      bookmaker: 'betano',
      origin: 'https://x.test',
      match: /api/,
      parse: (json) => (json as { events: string[] }).events?.map((id) => ev(id)) ?? [],
      isBlocked: (_s, body) => body.includes('Splash'),
      ...cfg,
    },
    ctx,
    bridge,
  );
}

const req = { scope: 'prematch' as const, sports: ['football' as const] };

describe('camoufox replay – known targets', () => {
  it('replays given targets without page discovery and merges events', async () => {
    const { bridge, calls } = stubBridge({
      'https://x.test/a': { status: 200, body: '{"events":["1","2"]}' },
      'https://x.test/b': { status: 200, body: '{"events":["2","3"]}' },
    });
    const s = strategy({ targets: () => [{ url: 'https://x.test/a' }, { url: 'https://x.test/b', method: 'POST', body: '{"id":7}' }] }, bridge);
    const r = await s.fetch(req);
    expect(r.events.map((e) => e.sourceId)).toEqual(['1', '2', '3']);
    expect(calls).toEqual([
      { url: 'https://x.test/a', method: 'GET', body: undefined },
      { url: 'https://x.test/b', method: 'POST', body: '{"id":7}' },
    ]);
  });

  it('one failing target does not drop the others; targets are rebuilt next poll', async () => {
    const { bridge } = stubBridge({ 'https://x.test/a': { status: 200, body: '{"events":["1"]}' } });
    let built = 0;
    const s = strategy({ targets: () => (built++, [{ url: 'https://x.test/a' }, { url: 'https://x.test/missing' }]) }, bridge);
    expect((await s.fetch(req)).events.map((e) => e.sourceId)).toEqual(['1']);
    await s.fetch(req);
    expect(built).toBe(2);
  });

  it('all targets failing → http error; block page → blocked error', async () => {
    const s1 = strategy({ targets: () => [{ url: 'https://x.test/missing' }] }, stubBridge({}).bridge);
    await expect(s1.fetch(req)).rejects.toMatchObject({ kind: 'http' });
    const s2 = strategy(
      { targets: () => [{ url: 'https://x.test/a' }] },
      stubBridge({ 'https://x.test/a': { status: 403, body: '<title>Betano Splash Screen</title>' } }).bridge,
    );
    await expect(s2.fetch(req)).rejects.toMatchObject({ kind: 'blocked' });
  });

  it('parts are fetched separately and passed to the parser as one object', async () => {
    const { bridge } = stubBridge({
      'https://x.test/ent': { status: 200, body: '{"ids":["9"]}' },
      'https://x.test/odds': { status: 200, body: '{"ok":true}' },
    });
    let seen: unknown;
    const s = strategy(
      {
        targets: () => [{ url: 'https://x.test/ent', parts: [{ name: 'entities', url: 'https://x.test/ent' }, { name: 'odds', url: 'https://x.test/odds' }] }],
        parse: (json) => ((seen = json), [ev('9')]),
      },
      bridge,
    );
    expect((await s.fetch({ scope: 'live', sports: ['football'] })).events).toHaveLength(1);
    expect(seen).toEqual({ entities: { ids: ['9'] }, odds: { ok: true } });
  });

  it('empty live is fine, empty prematch is an error', async () => {
    const { bridge } = stubBridge({ 'https://x.test/a': { status: 200, body: '{"events":[]}' } });
    const s = strategy({ targets: () => [{ url: 'https://x.test/a' }] }, bridge);
    expect((await s.fetch({ scope: 'live', sports: ['football'] })).events).toEqual([]);
    await expect(s.fetch(req)).rejects.toMatchObject({ kind: 'empty' });
  });
});
