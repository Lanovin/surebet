'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLive, setLocalPref } from '@/lib/live';
import { requestNotifications, unlockAudio, playAlert } from '@/lib/alerts';

const NAV = [
  { href: '/', label: 'Arby' },
  { href: '/stats', label: 'Statistiky' },
  { href: '/unmatched', label: 'Nepárované' },
  { href: '/health', label: 'Adaptéry' },
  { href: '/settings', label: 'Nastavení' },
];

export function Header() {
  const path = usePathname();
  const connected = useLive((s) => s.connected);
  const source = useLive((s) => s.dataSource);
  const unmatched = useLive((s) => s.unmatched);
  const active = useLive((s) => [...s.arbs.values()].filter((a) => a.status === 'active').length);
  const soundOn = useLive((s) => s.soundOn);
  const notifyOn = useLive((s) => s.notifyOn);

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-page/95 backdrop-blur">
      <div className="mx-auto flex max-w-[1800px] items-center gap-4 px-4 py-2">
        <div className="flex items-center gap-2 font-semibold">
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: connected ? 'var(--good)' : 'var(--critical)' }} aria-hidden />
          Surebet
          {source === 'sim' && (
            <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[11px] font-medium text-ink-2" title="Data ze simulátoru – testovací kurzy">
              TESTOVACÍ DATA
            </span>
          )}
        </div>
        <nav className="flex items-center gap-1">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={`rounded-md px-3 py-1.5 ${path === n.href ? 'bg-surface-3 text-ink' : 'text-ink-2 hover:bg-surface-2'}`}
            >
              {n.label}
              {n.href === '/' && active > 0 && <span className="ml-1.5 num text-muted">{active}</span>}
              {n.href === '/unmatched' && unmatched > 0 && (
                <span className="ml-1.5 rounded-full bg-surface-3 px-1.5 num text-[11px] text-ink">{unmatched}</span>
              )}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <button
            className="btn"
            aria-pressed={soundOn}
            title="Zvuk pro nové arby nad prahem"
            onClick={() => {
              unlockAudio();
              setLocalPref({ soundOn: !soundOn });
              if (!soundOn) playAlert('PREMATCH');
            }}
          >
            {soundOn ? '🔔 Zvuk' : '🔕 Zvuk vyp.'}
          </button>
          <button
            className="btn"
            aria-pressed={notifyOn}
            title="Browser notifikace pro nové arby nad prahem"
            onClick={async () => {
              if (!notifyOn) await requestNotifications();
              setLocalPref({ notifyOn: !notifyOn });
            }}
          >
            {notifyOn ? '💬 Notifikace' : '🚫 Notifikace vyp.'}
          </button>
        </div>
      </div>
    </header>
  );
}
