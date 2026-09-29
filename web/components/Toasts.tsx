'use client';
import { useLive } from '@/lib/live';

const TONE: Record<string, string> = { info: 'var(--accent)', warn: 'var(--warning)', bad: 'var(--critical)', good: 'var(--good)' };
const ICON: Record<string, string> = { info: 'ℹ', warn: '⚠', bad: '⛔', good: '✓' };

export function Toasts() {
  const toasts = useLive((s) => s.toasts);
  return (
    <div className="fixed bottom-14 right-3 z-50 flex w-96 flex-col gap-2" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="card flex items-start gap-2 px-3 py-2 text-sm shadow-lg" style={{ borderLeft: `3px solid ${TONE[t.tone]}` }}>
          <span aria-hidden>{ICON[t.tone]}</span>
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}
