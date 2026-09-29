'use client';
// Vodorovné pruhy (≤ 24 px, zaoblený konec, hodnota na konci) a skládaný histogram se 2px mezerou.
import { useState } from 'react';

export function HBars({ rows, format = String, color = 'var(--accent)' }: { rows: { label: string; value: number; extra?: string }[]; format?: (v: number) => string; color?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="space-y-1.5">
      {rows.map((r) => (
        <div key={r.label} className="grid grid-cols-[140px_1fr] items-center gap-2 text-xs" title={`${r.label}: ${format(r.value)}${r.extra ? ` · ${r.extra}` : ''}`}>
          <div className="truncate text-ink-2">{r.label}</div>
          <div className="flex items-center gap-2">
            <div className="h-3.5 rounded-r" style={{ width: `${(r.value / max) * 78}%`, minWidth: 2, background: color }} />
            <span className="num text-ink">{format(r.value)}</span>
            {r.extra && <span className="num text-muted">{r.extra}</span>}
          </div>
        </div>
      ))}
      {!rows.length && <div className="text-muted">Zatím bez dat</div>}
    </div>
  );
}

export interface StackSeries {
  key: string;
  label: string;
  color: string;
}

export function StackedColumns({
  bins,
  series,
  height = 200,
  ariaLabel,
}: {
  bins: { label: string; values: Record<string, number> }[];
  series: StackSeries[];
  height?: number;
  ariaLabel: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const totals = bins.map((b) => series.reduce((s, x) => s + (b.values[x.key] ?? 0), 0));
  const max = Math.max(1, ...totals);
  const ih = height - 34;
  return (
    <div className="relative" role="img" aria-label={ariaLabel}>
      <div className="flex items-end gap-2 border-b" style={{ height: ih, borderColor: 'var(--axis)' }}>
        {bins.map((b, i) => (
          <div
            key={b.label}
            className="relative flex h-full flex-1 flex-col-reverse items-center"
            onPointerEnter={() => setHover(i)}
            onPointerLeave={() => setHover(null)}
          >
            <div className="flex w-full max-w-[24px] flex-col-reverse gap-[2px]" style={{ height: `${(totals[i] / max) * 100}%` }}>
              {series.map((s, si) => {
                const v = b.values[s.key] ?? 0;
                if (!v) return null;
                const top = series.slice(si + 1).every((x) => !(b.values[x.key] ?? 0));
                return (
                  <div
                    key={s.key}
                    style={{ flexGrow: v, background: s.color, borderTopLeftRadius: top ? 4 : 0, borderTopRightRadius: top ? 4 : 0, opacity: hover === null || hover === i ? 1 : 0.55 }}
                  />
                );
              })}
            </div>
            {totals[i] > 0 && <span className="absolute -top-4 text-[10px] num text-ink-2" style={{ bottom: `${(totals[i] / max) * 100}%`, top: 'auto' }}>{totals[i]}</span>}
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-2">
        {bins.map((b) => (
          <div key={b.label} className="flex-1 text-center text-[10px] text-muted num">
            {b.label}
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-3 text-xs text-ink-2">
        {series.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} aria-hidden />
            {s.label}
          </span>
        ))}
      </div>
      {hover !== null && (
        <div className="pointer-events-none absolute left-2 top-0 rounded-md border border-line bg-surface-2 px-2 py-1.5 text-xs shadow">
          <div className="text-muted">{bins[hover].label}</div>
          {series.map((s) => (
            <div key={s.key} className="flex items-center gap-2">
              <span className="inline-block h-0.5 w-3" style={{ background: s.color }} />
              <b className="num">{bins[hover].values[s.key] ?? 0}</b>
              <span className="text-ink-2">{s.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
