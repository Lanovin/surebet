import type { Mode } from '@core/types';
import { bkColor, bkName } from '@/lib/format';
import { Icon, type IconName } from './Icon';

const MODE_VAR: Record<Mode, string> = { PREMATCH: 'var(--mode-prematch)', PAUSED: 'var(--mode-paused)', LIVE: 'var(--mode-live)' };

export function ModeBadge({ mode }: { mode: Mode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px] font-semibold tracking-wide" style={{ background: 'var(--surface-3)' }}>
      <span className="inline-block h-2 w-2 rounded-full" style={{ background: MODE_VAR[mode] }} aria-hidden />
      {mode}
    </span>
  );
}

export function modeColor(mode: Mode): string {
  return MODE_VAR[mode];
}

export function BookmakerChip({ bk, small }: { bk: string; small?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded bg-surface-2 ${small ? 'px-1 text-[11px]' : 'px-1.5 py-0.5 text-xs'} text-ink-2`}>
      <span className="inline-block h-2 w-2 rounded-sm" style={{ background: bkColor(bk) }} aria-hidden />
      {bkName(bk)}
    </span>
  );
}

/** Výrazný název sázkovky (barevný pruh vlevo) – „kde vsadit“ musí být vidět na první pohled. */
export function BookmakerName({ bk, size = 'md' }: { bk: string; size?: 'md' | 'lg' }) {
  return (
    <span
      className={`inline-flex items-center rounded-md font-bold uppercase tracking-wide text-ink ${size === 'lg' ? 'px-2.5 py-1 text-base' : 'px-2 py-0.5 text-[13px]'}`}
      style={{ background: 'var(--surface-3)', borderLeft: `4px solid ${bkColor(bk)}` }}
    >
      {bkName(bk)}
    </span>
  );
}

export function StateBadge({ state }: { state: 'OK' | 'DEGRADED' | 'BLOCKED' | string }) {
  const map: Record<string, [string, IconName]> = {
    OK: ['var(--good)', 'check'],
    DEGRADED: ['var(--warning)', 'warn'],
    BLOCKED: ['var(--critical)', 'stop'],
  };
  const [c, i] = map[state] ?? ['var(--muted)', 'info'];
  return (
    <span className="inline-flex items-center gap-1 rounded bg-surface-2 px-1.5 py-0.5 text-[11px] font-semibold">
      <span style={{ color: c }} className="inline-flex">
        <Icon name={i} size={12} />
      </span>
      {state}
    </span>
  );
}
