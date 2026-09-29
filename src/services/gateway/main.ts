// Gateway: REST API pro dashboard + WebSocket push (arby, zdraví adaptérů, nastavení) bez pollingu z frontendu.
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import { BOOKMAKERS } from '../../core/types.js';
import { BOOKMAKER_INFO } from '../../../config/bookmakers.js';
import { env } from '../../infra/env.js';
import { createLogger } from '../../infra/logger.js';
import { db, closeDb } from '../../infra/db.js';
import { CH, KEY, createRedis } from '../../infra/redis.js';
import { SettingsStore } from '../../infra/settingsStore.js';
import { migrate } from '../../db/migrate.js';
import { confirmUnmatched, listUnmatched, rejectUnmatched } from '../matching/review.js';
import { computeStats } from './stats.js';
import type { ArbDTO, ArbEventMessage, ClientMessage, HealthDTO, HealthLogDTO, ServerMessage } from '../../shared/protocol.js';

const log = createLogger('gateway');
const VERSION = '0.1.0';

type Handler = (req: http.IncomingMessage, params: Record<string, string>, body: unknown, url: URL) => Promise<unknown>;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function main(): Promise<void> {
  await migrate();
  const settings = new SettingsStore();
  await settings.load();
  await settings.watch();
  const redis = createRedis('gateway');
  const sub = createRedis('gateway-sub');

  // --- REST --------------------------------------------------------------------------------
  const routes: { method: string; re: RegExp; keys: string[]; fn: Handler }[] = [];
  const route = (method: string, path: string, fn: Handler) => {
    const keys: string[] = [];
    const re = new RegExp('^' + path.replace(/:(\w+)/g, (_m, k) => (keys.push(k), '([^/]+)')) + '$');
    routes.push({ method, re, keys, fn });
  };

  route('GET', '/api/meta', async () => {
    const stats = await redis.get('detector:stats');
    const hm = await redis.get('health:meta');
    return {
      version: VERSION,
      serverTime: Date.now(),
      dataSource: hm ? JSON.parse(hm).source : env.DATA_SOURCE,
      bookmakers: BOOKMAKERS.map((b) => BOOKMAKER_INFO[b]),
      detector: stats ? JSON.parse(stats) : null,
      ingest: hm ? JSON.parse(hm) : null,
    };
  });

  route('GET', '/api/arbs/active', async () => activeArbs());

  route('GET', '/api/arbs/recent', async (_r, _p, _b, url) => {
    const limit = Math.min(500, Number(url.searchParams.get('limit') ?? 100));
    const r = await db().query(
      `SELECT id, mode, sport, event_name, market_key, margin_at_detection, max_margin, first_seen, last_seen, duration_ms,
              end_reason, bookmaker_pair, is_sim FROM arbs WHERE end_reason IS NOT NULL ORDER BY last_seen DESC LIMIT $1`,
      [limit],
    );
    return r.rows;
  });

  route('GET', '/api/arbs/:id', async (_r, p) => {
    const r = await db().query('SELECT * FROM arbs WHERE id = $1', [p.id]);
    if (!r.rows[0]) throw new HttpError(404, 'arb not found');
    const ticks = await db().query(
      `SELECT extract(epoch from ts) * 1000 AS ts, margin FROM arb_ticks WHERE arb_id = $1 ORDER BY ts LIMIT 5000`,
      [p.id],
    );
    const actions = await db().query('SELECT * FROM user_actions WHERE arb_id = $1 ORDER BY ts', [p.id]);
    const active = await redis.hget(KEY.activeArbs, p.id);
    return { arb: r.rows[0], active: active ? JSON.parse(active) : null, ticks: ticks.rows.map((t) => ({ ts: Number(t.ts), margin: t.margin })), actions: actions.rows };
  });

  const actionSchema = z.object({
    arbId: z.string().uuid(),
    action: z.enum(['placed', 'missed', 'rejected', 'odds_changed']),
    bookmaker: z.enum(BOOKMAKERS).optional(),
    stake: z.number().positive().optional(),
    actualOdds: z.number().min(1).optional(),
    acceptanceMs: z.number().int().min(0).max(600_000).optional(),
    marginAtClick: z.number().optional(),
    shownAt: z.number().optional(),
    note: z.string().max(500).optional(),
    legs: z.array(z.object({ bookmaker: z.enum(BOOKMAKERS), stake: z.number().optional(), actualOdds: z.number().optional() })).optional(),
  });

  route('POST', '/api/actions', async (_r, _p, body) => {
    const a = actionSchema.parse(body);
    const arb = await db().query<{ first_seen: Date; mode: string; margin_at_detection: number }>('SELECT first_seen, mode, margin_at_detection FROM arbs WHERE id = $1', [a.arbId]);
    if (!arb.rows[0]) throw new HttpError(404, 'arb not found');
    const now = Date.now();
    const firstSeen = arb.rows[0].first_seen.getTime();
    const reaction = a.shownAt ? now - a.shownAt : now - firstSeen;
    const r = await db().query(
      `INSERT INTO user_actions (arb_id, action, bookmaker, stake, actual_odds, reaction_ms, arb_age_ms, margin_at_click, note, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        a.arbId,
        a.action,
        a.bookmaker ?? null,
        a.stake ?? null,
        a.actualOdds ?? null,
        Math.max(0, Math.round(reaction)),
        now - firstSeen,
        a.marginAtClick ?? arb.rows[0].margin_at_detection,
        a.note ?? null,
        JSON.stringify({ acceptanceMs: a.acceptanceMs, live: arb.rows[0].mode !== 'PREMATCH', shownAt: a.shownAt, legs: a.legs }),
      ],
    );
    return r.rows[0];
  });

  route('GET', '/api/health', async () => {
    const h = await redis.hgetall(KEY.health);
    return { health: BOOKMAKERS.map((b) => (h[b] ? JSON.parse(h[b]) : null)).filter(Boolean), log: await healthLog(200) };
  });

  route('GET', '/api/settings', async () => ({ settings: settings.get(), defaults: (await import('../../core/settings.js')).defaultSettings() }));
  route('PATCH', '/api/settings', async (_r, _p, body) => {
    try {
      return { settings: await settings.update(body, redis) };
    } catch (e) {
      if (e instanceof z.ZodError) throw new HttpError(400, e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      throw e;
    }
  });

  route('GET', '/api/unmatched', async (_r, _p, _b, url) => {
    const rows = await listUnmatched(url.searchParams.get('status') ?? 'pending');
    return rows;
  });

  route('GET', '/api/unmatched/:id/candidates', async (_r, p) => {
    const u = await db().query('SELECT sport, start_time FROM unmatched_events WHERE id = $1', [p.id]);
    if (!u.rows[0]) throw new HttpError(404, 'not found');
    const r = await db().query(
      `SELECT e.id, h.name AS home, a.name AS away, e.start_time, c.name AS competition,
              (SELECT array_agg(bookmaker) FROM event_links l WHERE l.event_id = e.id) AS books
       FROM events e JOIN participants h ON h.id = e.home_id JOIN participants a ON a.id = e.away_id
       LEFT JOIN competitions c ON c.id = e.competition_id
       WHERE e.sport = $1 AND e.start_time BETWEEN $2::timestamptz - interval '3 hours' AND $2::timestamptz + interval '3 hours'
       ORDER BY abs(extract(epoch from e.start_time - $2::timestamptz)) LIMIT 50`,
      [u.rows[0].sport, u.rows[0].start_time],
    );
    return r.rows;
  });

  route('POST', '/api/unmatched/:id/confirm', async (_r, p, body) => {
    const b = z.object({ eventId: z.number().int().optional(), swapped: z.boolean().optional() }).parse(body ?? {});
    const row = await confirmUnmatched(Number(p.id), b);
    await redis.publish(CH.unmatched, JSON.stringify({ bookmaker: row.bookmaker, sourceEventId: row.source_event_id, action: 'confirmed' }));
    void broadcastUnmatched();
    return row;
  });

  route('POST', '/api/unmatched/:id/reject', async (_r, p) => {
    const row = await rejectUnmatched(Number(p.id));
    await redis.publish(
      CH.unmatched,
      JSON.stringify({ bookmaker: row.bookmaker, sourceEventId: row.source_event_id, action: 'rejected', candidateId: row.candidate_event_id }),
    );
    void broadcastUnmatched();
    return row;
  });

  route('GET', '/api/stats', async (_r, _p, _b, url) =>
    computeStats({ sim: (url.searchParams.get('source') ?? env.DATA_SOURCE) === 'sim', days: Math.min(365, Number(url.searchParams.get('days') ?? 30)) }),
  );

  route('GET', '/api/events/:id', async (_r, p) => {
    const ev = await redis.hget(KEY.events, p.id);
    const books: Record<string, unknown> = {};
    for (const b of BOOKMAKERS) {
      const s = await redis.hget(KEY.bookState(b), p.id);
      if (s) books[b] = JSON.parse(s);
    }
    return { event: ev ? JSON.parse(ev) : null, books };
  });

  async function activeArbs(): Promise<ArbDTO[]> {
    const h = await redis.hgetall(KEY.activeArbs);
    return Object.values(h).map((v) => JSON.parse(v) as ArbDTO);
  }

  async function healthLog(limit: number): Promise<HealthLogDTO[]> {
    const r = await db().query(
      `SELECT id, extract(epoch from ts) * 1000 AS ts, bookmaker, scope, event, strategy, level, state, prev_state, prev_strategy, reason
       FROM adapter_health WHERE event <> 'probe' ORDER BY ts DESC LIMIT $1`,
      [limit],
    );
    return r.rows.map((x) => ({
      id: x.id,
      ts: Number(x.ts),
      bookmaker: x.bookmaker,
      scope: x.scope,
      event: x.event,
      strategy: x.strategy,
      level: x.level,
      state: x.state,
      prevState: x.prev_state,
      prevStrategy: x.prev_strategy,
      reason: x.reason,
    }));
  }

  async function pendingCount(): Promise<number> {
    const r = await db().query<{ n: number }>(`SELECT count(*)::int AS n FROM unmatched_events WHERE status = 'pending'`);
    return r.rows[0].n;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type');
    res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,OPTIONS');
    if (req.method === 'OPTIONS') return void res.writeHead(204).end();
    if (url.pathname === '/healthz') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      try {
        let body: unknown;
        if (req.method === 'POST' || req.method === 'PATCH') {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const txt = Buffer.concat(chunks).toString('utf8');
          body = txt ? JSON.parse(txt) : undefined;
        }
        const out = await r.fn(req, params, body, url);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(out));
      } catch (e) {
        const status = e instanceof HttpError ? e.status : e instanceof z.ZodError ? 400 : 500;
        const msg = e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : (e as Error).message;
        if (status === 500) log.error(`${req.method} ${url.pathname}`, { error: msg });
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: msg }));
      }
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not found' }));
  });

  // --- WebSocket ---------------------------------------------------------------------------
  const wss = new WebSocketServer({ server, path: '/ws', perMessageDeflate: false });
  const send = (ws: WebSocket, msg: ServerMessage) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };
  const broadcast = (msg: ServerMessage) => {
    const data = JSON.stringify(msg);
    for (const ws of wss.clients) if (ws.readyState === WebSocket.OPEN) ws.send(data);
  };
  let lastPending = -1;
  const broadcastUnmatched = async () => {
    const n = await pendingCount();
    if (n !== lastPending) {
      lastPending = n;
      broadcast({ t: 'unmatched', pending: n });
    }
  };

  wss.on('connection', async (ws) => {
    ws.on('message', (raw) => {
      try {
        const m = JSON.parse(String(raw)) as ClientMessage;
        if (m.t === 'ping') send(ws, { t: 'pong', id: m.id, clientTs: m.clientTs, serverTs: Date.now() });
      } catch {
        /* ignore */
      }
    });
    const hm = await redis.get('health:meta');
    send(ws, { t: 'hello', serverTime: Date.now(), dataSource: hm ? JSON.parse(hm).source : env.DATA_SOURCE, version: VERSION });
    const h = await redis.hgetall(KEY.health);
    send(ws, {
      t: 'snapshot',
      arbs: await activeArbs(),
      health: BOOKMAKERS.map((b) => (h[b] ? (JSON.parse(h[b]) as HealthDTO) : null)).filter((x): x is HealthDTO => !!x),
      unmatched: await pendingCount(),
      recentHealth: await healthLog(50),
    });
    send(ws, { t: 'settings', settings: settings.get() });
  });

  await sub.subscribe(CH.arbEvents, CH.health, CH.settingsChanged);
  sub.on('message', (ch, payload) => {
    try {
      if (ch === CH.arbEvents) {
        const m = JSON.parse(payload) as ArbEventMessage;
        broadcast({ t: 'arb', kind: m.kind, arb: m.arb, detectedAt: m.detectedAt, dataAt: m.dataAt, sentAt: Date.now() });
      } else if (ch === CH.health) {
        const m = JSON.parse(payload);
        if (m.snapshot) broadcast({ t: 'health', health: m.snapshot as HealthDTO[] });
        else broadcast({ t: 'health_event', event: m as HealthLogDTO });
      } else if (ch === CH.settingsChanged) {
        // SettingsStore se přenačte sám; pošleme až novou verzi
        setTimeout(() => broadcast({ t: 'settings', settings: settings.get() }), 50);
      }
    } catch (e) {
      log.error('broadcast failed', { error: (e as Error).message });
    }
  });
  const unmatchedTimer = setInterval(() => void broadcastUnmatched().catch(() => {}), 10_000);

  server.listen(env.GATEWAY_PORT, () => log.info(`listening on http://localhost:${env.GATEWAY_PORT} (ws /ws)`));

  const shutdown = async () => {
    clearInterval(unmatchedTimer);
    wss.close();
    server.close();
    await settings.close();
    await sub.quit().catch(() => {});
    await redis.quit().catch(() => {});
    await closeDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  log.error('fatal', { error: (e as Error).stack ?? String(e) });
  process.exit(1);
});


