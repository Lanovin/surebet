'use client';
// Jedno WebSocket spojení pro celý dashboard + store (useSyncExternalStore). Žádný polling.
import { useSyncExternalStore } from 'react';
import type { ArbDTO, HealthDTO, HealthLogDTO, ServerMessage } from '@shared/protocol';
import type { Settings } from '@core/settings';
import { playAlert, notifyArb } from './alerts';

export interface ArbRow extends ArbDTO {
  status: 'active' | 'ended';
  addedAt: number;
  endedLocalAt?: number;
  marginDir: 'up' | 'down' | null;
  marginDirAt: number;
  ticks: { ts: number; margin: number }[];
}

export interface Toast {
  id: number;
  ts: number;
  text: string;
  tone: 'info' | 'warn' | 'bad' | 'good';
}

export interface LiveState {
  connected: boolean;
  dataSource: string;
  arbs: Map<string, ArbRow>;
  health: HealthDTO[];
  healthLog: HealthLogDTO[];
  unmatched: number;
  settings: Settings | null;
  latency: { last: number | null; p50: number | null; p95: number | null; e2e: number | null; n: number };
  clockOffset: number;
  toasts: Toast[];
  soundOn: boolean;
  notifyOn: boolean;
}

const ENDED_VISIBLE_MS = 3000;
const MAX_TICKS = 600;

let state: LiveState = {
  connected: false,
  dataSource: '?',
  arbs: new Map(),
  health: [],
  healthLog: [],
  unmatched: 0,
  settings: null,
  latency: { last: null, p50: null, p95: null, e2e: null, n: 0 },
  clockOffset: 0,
  toasts: [],
  soundOn: true,
  notifyOn: true,
};
const listeners = new Set<() => void>();
const latencySamples: number[] = [];
const e2eSamples: number[] = [];
let ws: WebSocket | null = null;
let started = false;
let retry = 0;
let pingId = 0;
let bestRtt = Infinity;
let toastId = 0;

function set(patch: Partial<LiveState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function getLive(): LiveState {
  return state;
}

export function useLive<T>(sel: (s: LiveState) => T): T {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      startLive();
      return () => listeners.delete(cb);
    },
    () => sel(state),
    () => sel(state),
  );
}

function wsUrl(): string {
  const env = process.env.NEXT_PUBLIC_WS_URL;
  if (env) return env;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.hostname}:3001/ws`;
}

export function pushToast(text: string, tone: Toast['tone'] = 'info'): void {
  const t: Toast = { id: ++toastId, ts: Date.now(), text, tone };
  set({ toasts: [...state.toasts.slice(-4), t] });
  setTimeout(() => set({ toasts: state.toasts.filter((x) => x.id !== t.id) }), 6000);
}

export function setLocalPref(p: { soundOn?: boolean; notifyOn?: boolean }): void {
  set(p);
  try {
    localStorage.setItem('surebet:prefs', JSON.stringify({ soundOn: state.soundOn, notifyOn: state.notifyOn }));
  } catch {
    /* localStorage nemusí být k dispozici */
  }
}

function percentile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

function recordLatency(detectedAt: number, dataAt: number): void {
  // měříme až po vykreslení (další frame), v čase serveru
  requestAnimationFrame(() => {
    const serverNow = Date.now() + state.clockOffset;
    const l = Math.max(0, serverNow - detectedAt);
    latencySamples.push(l);
    if (latencySamples.length > 200) latencySamples.shift();
    e2eSamples.push(Math.max(0, serverNow - dataAt));
    if (e2eSamples.length > 200) e2eSamples.shift();
    set({
      latency: {
        last: Math.round(l),
        p50: percentile(latencySamples, 0.5),
        p95: percentile(latencySamples, 0.95),
        e2e: percentile(e2eSamples, 0.5),
        n: latencySamples.length,
      },
    });
  });
}

function onArb(kind: 'new' | 'update' | 'end', arb: ArbDTO): void {
  const now = Date.now();
  const arbs = new Map(state.arbs);
  const prev = arbs.get(arb.id);
  if (kind === 'end') {
    if (!prev) return;
    arbs.set(arb.id, { ...prev, ...arb, status: 'ended', endedLocalAt: now });
    setTimeout(() => {
      const m = new Map(state.arbs);
      const r = m.get(arb.id);
      if (r?.status === 'ended') {
        m.delete(arb.id);
        set({ arbs: m });
      }
    }, ENDED_VISIBLE_MS);
  } else {
    const dir = prev && arb.margin !== prev.margin ? (arb.margin > prev.margin ? 'up' : 'down') : (prev?.marginDir ?? null);
    const ticks = prev ? [...prev.ticks, { ts: arb.lastSeen, margin: arb.margin }].slice(-MAX_TICKS) : [{ ts: arb.firstSeen, margin: arb.margin }];
    arbs.set(arb.id, {
      ...arb,
      status: 'active',
      addedAt: prev?.addedAt ?? now,
      marginDir: dir,
      marginDirAt: prev && arb.margin !== prev.margin ? now : (prev?.marginDirAt ?? 0),
      ticks,
    });
    if (kind === 'new') maybeAlert(arb);
  }
  set({ arbs });
}

function maybeAlert(arb: ArbDTO): void {
  const s = state.settings;
  if (!s || arb.muted) return;
  if (arb.margin < s.alerts.minMarginPct) return;
  if (s.alerts.sound && state.soundOn) playAlert(arb.mode);
  if (s.alerts.notifications && state.notifyOn) notifyArb(arb);
}

function handle(msg: ServerMessage): void {
  switch (msg.t) {
    case 'hello':
      set({ dataSource: msg.dataSource, clockOffset: msg.serverTime - Date.now() });
      break;
    case 'snapshot': {
      const now = Date.now();
      const arbs = new Map<string, ArbRow>();
      for (const a of msg.arbs)
        arbs.set(a.id, { ...a, status: 'active', addedAt: now - 10_000, marginDir: null, marginDirAt: 0, ticks: [{ ts: a.lastSeen, margin: a.margin }] });
      set({ arbs, health: msg.health, unmatched: msg.unmatched, healthLog: msg.recentHealth });
      break;
    }
    case 'arb':
      onArb(msg.kind, msg.arb);
      recordLatency(msg.detectedAt, msg.dataAt);
      break;
    case 'health':
      set({ health: msg.health });
      break;
    case 'health_event': {
      set({ healthLog: [msg.event, ...state.healthLog].slice(0, 200) });
      if (msg.event.event === 'strategy_switch' || msg.event.event === 'state_change') {
        const tone = msg.event.state === 'BLOCKED' ? 'bad' : msg.event.state === 'DEGRADED' ? 'warn' : 'good';
        const sw = msg.event.prevStrategy ? `${msg.event.prevStrategy} → ${msg.event.strategy}` : msg.event.strategy;
        pushToast(`${msg.event.bookmaker} (${msg.event.scope}): ${msg.event.state} · ${sw}`, tone);
      }
      break;
    }
    case 'settings':
      set({ settings: msg.settings as Settings });
      break;
    case 'unmatched':
      set({ unmatched: msg.pending });
      break;
    case 'pong': {
      const now = Date.now();
      const rtt = now - msg.clientTs;
      if (rtt <= bestRtt * 1.5) {
        bestRtt = Math.min(bestRtt, rtt);
        set({ clockOffset: msg.serverTs - (msg.clientTs + rtt / 2) });
      }
      break;
    }
  }
}

function connect(): void {
  const sock = new WebSocket(wsUrl());
  ws = sock;
  sock.onopen = () => {
    retry = 0;
    bestRtt = Infinity;
    set({ connected: true });
    sock.send(JSON.stringify({ t: 'ping', id: ++pingId, clientTs: Date.now() }));
  };
  sock.onmessage = (ev) => {
    try {
      handle(JSON.parse(ev.data as string) as ServerMessage);
    } catch {
      /* ignore */
    }
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    set({ connected: false });
    const delay = Math.min(10_000, 500 * 2 ** retry++);
    setTimeout(connect, delay);
  };
  sock.onerror = () => sock.close();
}

export function startLive(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  try {
    const p = JSON.parse(localStorage.getItem('surebet:prefs') ?? '{}');
    set({ soundOn: p.soundOn ?? true, notifyOn: p.notifyOn ?? true });
  } catch {
    /* ignore */
  }
  connect();
  setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'ping', id: ++pingId, clientTs: Date.now() }));
  }, 5000);
}
