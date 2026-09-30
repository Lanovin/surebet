import type { BookmakerId, MarketType, Mode, SelectionKey, Sport } from '@core/types';
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

function signed(x: number): string {
  return x > 0 ? `+${x}` : `${x}`;
}

/**
 * Co přesně vsadit: srozumitelný popis výběru (týmy, linie) a jak se výběr jmenuje u sázkovky,
 * která má týmy v opačném pořadí (swapped) – tam je kanonický „domácí“ uvedený jako druhý.
 */
export function describeLeg(
  a: { marketType: MarketType; line: number | null; home: string; away: string },
  sel: SelectionKey,
  swapped: boolean,
): { title: string; atBook?: string } {
  const line = a.line ?? 0;
  const team = sel === 'HOME' ? a.home : a.away;
  const pos = (s: SelectionKey) => (s === 'HOME' ? (swapped ? '2' : '1') : swapped ? '1' : '2');
  const at = swapped && (sel === 'HOME' || sel === 'AWAY') ? `u sázkovky jako „${pos(sel)}“ – týmy má v opačném pořadí` : undefined;
  switch (a.marketType) {
    case '1X2':
      if (sel === 'DRAW') return { title: 'X · remíza' };
      return { title: `${sel === 'HOME' ? '1' : '2'} · ${team}`, atBook: at };
    case 'ML':
      return { title: team, atBook: at };
    case 'DNB':
      return { title: `${team} (bez remízy)`, atBook: at };
    case 'AH':
      return { title: `${team} ${signed(sel === 'HOME' ? line : -line)}`, atBook: at };
    case 'AH_SETS':
      return { title: `${team} ${signed(sel === 'HOME' ? line : -line)} setu`, atBook: at };
    case 'OU':
    case 'OU_SETS':
      return { title: `${sel === 'OVER' ? 'Více' : 'Méně'} než ${line}` };
    case 'OU_HOME':
      return { title: `${a.home}: ${sel === 'OVER' ? 'více' : 'méně'} než ${line}` };
    case 'OU_AWAY':
      return { title: `${a.away}: ${sel === 'OVER' ? 'více' : 'méně'} než ${line}` };
    case 'BTTS':
      return { title: `Oba dají gól – ${sel === 'YES' ? 'ano' : 'ne'}` };
    case 'OE':
      return { title: sel === 'ODD' ? 'Lichý počet' : 'Sudý počet' };
  }
}

/** Důvod zániku arbu česky („leg_odds_changed:kingsbet“ → „Kingsbet: změna kurzu“). */
export function endReasonLabel(reason: string | undefined): string {
  if (!reason) return '–';
  const [code, bk] = reason.split(':');
  const who = bk ? bkName(bk) : '';
  switch (code) {
    case 'leg_odds_changed':
      return who ? `${who}: změna kurzu` : 'změna kurzu';
    case 'stale':
      return who ? `${who}: kurz nepotvrzen (stará data)` : 'kurz nepotvrzen (stará data)';
    case 'suspended':
      return 'trh pozastaven nebo stažen';
    case 'event_started':
      return 'zápas začal';
    case 'pause_started':
      return 'začala přestávka';
    case 'pause_ended':
      return 'skončila přestávka';
    case 'event_finished':
      return 'zápas skončil';
    case 'threshold_changed':
      return 'změna prahu v nastavení';
    case 'unlinked':
      return 'zrušené spárování zápasu';
    case 'system_restart':
      return 'restart systému';
    default:
      return reason;
  }
}

/** Herní čas pro přehled: minuta (vzestupné hodiny) nebo zbývající čas periody (odpočet, basket). */
export function clockLabel(st: { clockSec?: number; periodRemainingSec?: number } | undefined): string | null {
  if (st?.clockSec !== undefined) return `${Math.floor(st.clockSec / 60)}'`;
  if (st?.periodRemainingSec !== undefined) return `zbývá ${Math.floor(st.periodRemainingSec / 60)}:${String(st.periodRemainingSec % 60).padStart(2, '0')}`;
  return null;
}
