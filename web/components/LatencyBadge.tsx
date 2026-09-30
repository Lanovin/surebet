'use client';
import { useLive } from '@/lib/live';

/** Latence detekce → zobrazení (cíl < 200 ms), v rohu dashboardu. */
export function LatencyBadge() {
  const l = useLive((s) => s.latency);
  const ok = l.p95 === null || l.p95 < 200;
  return (
    <div
      className="fixed bottom-3 right-3 z-40 hidden rounded-lg border border-line bg-surface px-3 py-1.5 text-xs shadow-lg sm:block"
      title="Latence od detekce arbu po vykreslení v prohlížeči (p50 / p95 z posledních 200 zpráv). e2e = od stažení kurzů."
    >
      <span className="text-muted">latence </span>
      <span className="num font-semibold" style={{ color: ok ? 'var(--ink)' : 'var(--critical)' }}>
        {l.p50 ?? '–'} / {l.p95 ?? '–'} ms
      </span>
      <span className="text-muted"> · poslední </span>
      <span className="num">{l.last ?? '–'} ms</span>
      <span className="text-muted"> · e2e </span>
      <span className="num">{l.e2e ?? '–'} ms</span>
      {!ok && <span className="ml-1 text-critical">⚠ nad 200 ms</span>}
    </div>
  );
}
