import type { Mode } from '@core/types';
import { bkColor, bkName } from '@/lib/format';

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

export function StateBadge({ state }: { state: 'OK' | 'DEGRADED' | 'BLOCKED' | string }) {
  const map: Record<string, [string, string]> = {
    OK: ['var(--good)', '✓'],
    DEGRADED: ['var(--warning)', '⚠'],
    BLOCKED: ['var(--critical)', '⛔'],
  };
  const [c, i] = map[state] ?? ['var(--muted)', '?'];
  return (
    <span className="inline-flex items-center gap-1 rounded bg-surface-2 px-1.5 py-0.5 text-[11px] font-semibold">
      <span style={{ color: c }} aria-hidden>
        {i}
      </span>
      {state}
    </span>
  );
}
