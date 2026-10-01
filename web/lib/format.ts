import type { BookmakerId, Mode, SelectionKey, Sport } from '@core/types';
import { BOOKMAKER_INFO } from '@config/bookmakers';
import { parseMarketKey, swapSelection, SCORE_UNIT, SCOPE_LABEL } from '@core/markets';

export const SPORT_LABEL: Record<Sport, string> = {
  football: 'Fotbal',
  tennis: 'Tenis',
  basketball: 'Basket',
  hockey: 'Hokej',
  handball: 'Házená',
  volleyball: 'Volejbal',
  baseball: 'Baseball',
  american_football: 'Am. fotbal',
  mma: 'MMA',
  boxing: 'Box',
  darts: 'Šipky',
  snooker: 'Snooker',
  table_tennis: 'Stolní tenis',
};

export const MODE_LABEL: Record<Mode, string> = { PREMATCH: 'PREMATCH', PAUSED: 'PAUSED', LIVE: 'LIVE' };

export const PAUSE_LABEL: Record<string, string> = {
  football_ht: 'poločas',
  basketball_ht: 'poločas',
  basketball_quarter: 'mezi čtvrtinami',
  hockey_intermission: 'přestávka mezi třetinami',
  tennis_set_break: 'mezi sety',
  handball_ht: 'poločas',
  volleyball_set_break: 'mezi sety',
  american_football_ht: 'poločas',
  american_football_quarter: 'mezi čtvrtinami',
  other_break: 'přestávka',
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

/**
 * Na co se sází, srozumitelně a bez zkratek – velký štítek v přehledu i v detailu:
 * { kind: „Počet gólů“, detail: „více / méně než 2.5“, scope: „1. poločas“ }.
 */
export function marketKind(market: string, sport?: Sport): { kind: string; detail?: string; scope?: string } {
  const p = parseMarketKey(market);
  const unit = SCORE_UNIT[sport ?? 'football'];
  const line = p.line ?? 0;
  const scope = p.scope === 'REG' || p.scope === 'MATCH' ? undefined : SCOPE_LABEL[p.scope];
  const k = (kind: string, detail?: string) => ({ kind, detail, scope });
  switch (p.type) {
    case '1X2':
      return k('Výhra', '1 · X · 2 (domácí, remíza, hosté)');
    case 'H_DA':
      return k('Výhra', '1 proti X2 (domácí / remíza nebo hosté)');
    case 'A_HD':
      return k('Výhra', '2 proti 1X (hosté / domácí nebo remíza)');
    case 'D_HA':
      return k('Výhra', 'X proti 12 (remíza / kdokoli vyhraje)');
    case 'ML':
      return k('Výhra', 'vítěz zápasu');
    case 'DNB':
      return k('Výhra', 'bez remízy (při remíze vrácení vkladu)');
    case 'DC':
      return k('Dvojtip');
    case 'OU':
      return k(`Počet ${unit}`, `více / méně než ${line}`);
    case 'OU_HOME':
      return k(`Počet ${unit} domácích`, `více / méně než ${line}`);
    case 'OU_AWAY':
      return k(`Počet ${unit} hostů`, `více / méně než ${line}`);
    case 'OU_SETS':
      return k('Počet setů', `více / méně než ${line}`);
    case 'AH':
      return k(`Handicap (${unit})`, `${signed(line)} / ${signed(-line)}`);
    case 'AH_SETS':
      return k('Handicap setů', `${signed(line)} / ${signed(-line)}`);
    case 'BTTS':
      return k('Oba týmy dají gól', 'ano / ne');
    case 'OE':
      return k(`Lichý / sudý počet ${unit}`);
  }
}

function signed(x: number): string {
  return x > 0 ? `+${x}` : `${x}`;
}

/**
 * Co přesně vsadit: srozumitelný popis výběru (týmy, linie) v trhu, který se u sázkovky skutečně sází
 * (u arbů napříč trhy se liší od trhu arbu – např. výsledek „X2“ vsazený jako asijský handicap hostů +0.5),
 * a jak se výběr jmenuje u sázkovky s týmy v opačném pořadí (swapped).
 */
export function describeLeg(market: string, sel: SelectionKey, a: { home: string; away: string; sport?: Sport }, swapped: boolean): { title: string; atBook?: string } {
  const p = parseMarketKey(market);
  const unit = SCORE_UNIT[a.sport ?? 'football'];
  const line = p.line ?? 0;
  const team = sel === 'HOME' ? a.home : a.away;
  const flip = (s: SelectionKey) => (swapped ? swapSelection(s) : s);
  const code: Partial<Record<SelectionKey, string>> = { HOME: '1', AWAY: '2', HOME_DRAW: '1X', HOME_AWAY: '12', DRAW_AWAY: 'X2' };
  const at = swapped && code[sel] && code[flip(sel)] !== code[sel] ? `u sázkovky jako „${code[flip(sel)]}“ – týmy má v opačném pořadí` : undefined;
  switch (p.type) {
    case '1X2':
    case 'H_DA':
    case 'A_HD':
    case 'D_HA':
      if (sel === 'DRAW') return { title: 'X · remíza' };
      return { title: `${sel === 'HOME' ? '1' : '2'} · vyhraje ${team}`, atBook: at };
    case 'DC':
      if (sel === 'HOME_DRAW') return { title: `1X · ${a.home} nebo remíza (dvojtip)`, atBook: at };
      if (sel === 'DRAW_AWAY') return { title: `X2 · remíza nebo ${a.away} (dvojtip)`, atBook: at };
      return { title: `12 · bez remízy – vyhraje kdokoli (dvojtip)` };
    case 'ML':
      return { title: `Vyhraje ${team}`, atBook: at };
    case 'DNB':
      return { title: `Vyhraje ${team} (bez remízy)`, atBook: at };
    case 'AH':
      return { title: `${team} ${signed(sel === 'HOME' ? line : -line)} (handicap ${unit})`, atBook: at };
    case 'AH_SETS':
      return { title: `${team} ${signed(sel === 'HOME' ? line : -line)} setu`, atBook: at };
    case 'OU':
      return { title: `${sel === 'OVER' ? 'Více' : 'Méně'} než ${line} ${unit}` };
    case 'OU_SETS':
      return { title: `${sel === 'OVER' ? 'Více' : 'Méně'} než ${line} setů` };
    case 'OU_HOME':
      return { title: `${a.home}: ${sel === 'OVER' ? 'více' : 'méně'} než ${line} ${unit}` };
    case 'OU_AWAY':
      return { title: `${a.away}: ${sel === 'OVER' ? 'více' : 'méně'} než ${line} ${unit}` };
    case 'BTTS':
      return { title: `Oba dají gól – ${sel === 'YES' ? 'ano' : 'ne'}` };
    case 'OE':
      return { title: sel === 'ODD' ? `Lichý počet ${unit}` : `Sudý počet ${unit}` };
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
