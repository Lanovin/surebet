import type { BookmakerId, Mode, Sport } from '@core/types';
import { BOOKMAKER_INFO } from '@config/bookmakers';

export const SPORT_LABEL: Record<Sport, string> = {
  football: 'Fotbal',
  tennis: 'Tenis',
  basketball: 'Basket',
  hockey: 'Hokej',
};

export const MODE_LABEL: Record<Mode, string> = { PREMATCH: 'PREMATCH', PAUSED: 'PAUSED', LIVE: 'LIVE' };

export const PAUSE_LABEL: Record<string, string> = {
  football_ht: 'poločas',
  basketball_ht: 'poločas',
  basketball_quarter: 'mezi čtvrtinami',
  hockey_intermission: 'přestávka mezi třetinami',
  tennis_set_break: 'mezi sety',
};

export function bkName(bk: BookmakerId | string): string {
  return BOOKMAKER_INFO[bk as BookmakerId]?.name ?? bk;
}

export function bkColor(bk: BookmakerId | string): string {
  return BOOKMAKER_INFO[bk as BookmakerId]?.color ?? '#888';
}

/** 12 s · 3:05 · 1:02:03 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '–';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return `${m}:${String(r).padStart(2, '0')}`;
  const h = Math.floor(m / 60);
  return `${h}:${String(m % 60).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

export function formatCountdown(sec: number | null): string {
  if (sec === null) return '–';
  if (sec < 3600) return formatDuration(sec * 1000);
  const h = sec / 3600;
  return h < 48 ? `${h.toFixed(1)} h` : `${Math.round(h / 24)} d`;
}

export function formatKc(x: number): string {
  return new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 0 }).format(x) + ' Kč';
}

export function formatKc2(x: number): string {
  return new Intl.NumberFormat('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(x) + ' Kč';
}

export function formatPct(x: number | null | undefined, digits = 2): string {
  if (x === null || x === undefined) return '–';
  return `${x.toFixed(digits)} %`;
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString('cs-CZ', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${r.status}`);
  return body as T;
}
