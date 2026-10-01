'use client';
import { HealthPanel } from '@/components/HealthPanel';
import { useLive } from '@/lib/live';
import { bkName, formatDuration } from '@/lib/format';
import { StateBadge } from '@/components/Badges';
import { useNow } from '@/components/useNow';

export default function HealthPage() {
  const health = useLive((s) => s.health);
  const now = useNow(1000);
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_480px]">
      <div className="space-y-3">
        {health.map((h) => (
          <div key={h.bookmaker} className="card p-3">
            <div className="mb-2 flex items-center gap-3">
              <h2 className="text-base font-semibold">{bkName(h.bookmaker)}</h2>
              {h.source === 'none' ? <span className="text-muted">adaptér zatím není</span> : <StateBadge state={h.state} />}
              <span className="text-xs text-muted">
                zdroj: {h.source}
                {!h.enabled && ' · vypnuto'}
              </span>
              <span className="ml-auto text-xs text-muted">
                spárováno {h.matchedEvents} · nespárováno {h.unmatchedEvents}
              </span>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {h.scopes.map((s) => (
                <div key={s.scope} className="rounded-md bg-surface-2 p-2 text-xs">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <b>{s.scope}</b>
                    <StateBadge state={s.state} />
                    <span className="text-muted">
                      interval {formatDuration(s.intervalMs)} · latence {s.lastLatencyMs ?? '–'} ms · {s.events} událostí · data před{' '}
                      {s.lastDataAt ? formatDuration(now - s.lastDataAt) : '–'}
                    </span>
                  </div>
                  <table className="data w-full">
                    <tbody>
                      {s.strategies.map((x) => (
                        <tr key={x.name} className={x.name === s.active ? 'font-semibold' : ''}>
                          <td>L{x.level}</td>
                          <td>
                            {x.name}
                            {x.name === s.active && ' (aktivní)'}
                          </td>
                          <td>{x.status}</td>
                          <td className="num">{x.failures ? `${x.failures}× chyba` : ''}</td>
                          <td className="max-w-[260px] truncate text-muted" title={x.lastError}>
                            {x.lastError}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          </div>
        ))}
        {!health.length && <div className="text-muted">Čekám na data z ingestu…</div>}
      </div>
      <HealthPanel />
    </div>
  );
}
