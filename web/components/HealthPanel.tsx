'use client';
import { useLive } from '@/lib/live';
import { bkName, formatDuration, formatTime } from '@/lib/format';
import { BookmakerChip, StateBadge } from './Badges';
import { useNow } from './useNow';

const LEVEL: Record<number, string> = { 0: 'sim', 1: 'API', 2: 'JSON', 3: 'WS', 4: 'HTML', 5: 'PW' };

export function HealthPanel({ compact }: { compact?: boolean }) {
  const health = useLive((s) => s.health);
  const log = useLive((s) => s.healthLog);
  const now = useNow(1000);
  return (
    <div className="space-y-3">
      <div className="card overflow-hidden">
        <div className="border-b border-line px-3 py-2 text-sm font-medium">Zdraví adaptérů</div>
        <table className="data w-full text-xs">
          <thead>
            <tr>
              <th>Sázkovka</th>
              <th>Stav</th>
              <th>Strategie</th>
              <th className="text-right">Stáří dat</th>
              <th className="text-right">Událostí</th>
            </tr>
          </thead>
          <tbody>
            {health.map((h) => {
              const lastData = Math.max(0, ...h.scopes.map((s) => s.lastDataAt ?? 0));
              const events = h.scopes.reduce((n, s) => n + s.events, 0);
              return (
                <tr key={h.bookmaker} className={h.enabled ? '' : 'opacity-40'}>
                  <td>
                    <BookmakerChip bk={h.bookmaker} small />
                  </td>
                  <td>{h.source === 'none' ? <span className="text-muted">bez adaptéru</span> : <StateBadge state={h.state} />}</td>
                  <td className="text-ink-2">
                    {h.scopes.map((s) => (
                      <div key={s.scope} className="whitespace-nowrap" title={s.lastError ?? ''}>
                        <span className="text-muted">{s.scope === 'prematch' ? 'pre' : 'live'}:</span> {s.active ?? '–'}
                        {s.activeLevel !== null && <span className="text-muted"> L{s.activeLevel} {LEVEL[s.activeLevel] ?? ''}</span>}
                        {s.push && <span className="text-muted"> push</span>}
                      </div>
                    ))}
                  </td>
                  <td className="text-right num" style={{ color: lastData && now - lastData > 120_000 ? 'var(--warning)' : undefined }}>
                    {lastData ? formatDuration(now - lastData) : '–'}
                  </td>
                  <td className="text-right num">
                    {events}
                    {h.unmatchedEvents > 0 && <span className="text-muted" title="nespárováno"> +{h.unmatchedEvents}?</span>}
                  </td>
                </tr>
              );
            })}
            {!health.length && (
              <tr>
                <td colSpan={5} className="py-4 text-center text-muted">
                  Čekám na ingest…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="card overflow-hidden">
        <div className="border-b border-line px-3 py-2 text-sm font-medium">Přepínání strategií</div>
        <ul className={`divide-y divide-[var(--grid)] overflow-y-auto text-xs ${compact ? 'max-h-64' : 'max-h-[70vh]'}`}>
          {log
            .filter((l) => l.event !== 'probe')
            .slice(0, compact ? 30 : 200)
            .map((l) => (
              <li key={l.id} className="px-3 py-1.5">
                <div className="flex items-center gap-2">
                  <span className="num text-muted">{formatTime(l.ts)}</span>
                  <span className="font-medium">{bkName(l.bookmaker)}</span>
                  <span className="text-muted">{l.scope}</span>
                  {l.state && <StateBadge state={l.state} />}
                </div>
                <div className="text-ink-2">
                  {l.event === 'strategy_switch' && `${l.prevStrategy ?? '?'} → ${l.strategy} (L${l.level})`}
                  {l.event === 'state_change' && `${l.prevState ?? '?'} → ${l.state}`}
                  {l.event === 'diagnostic' && `diagnostika ${l.strategy}`}
                  {l.reason && <span className="text-muted"> · {l.reason}</span>}
                </div>
              </li>
            ))}
          {!log.length && <li className="px-3 py-3 text-muted">Zatím bez změn.</li>}
        </ul>
      </div>
    </div>
  );
}
