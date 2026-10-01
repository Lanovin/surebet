'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLive, setLocalPref } from '@/lib/live';
import { requestNotifications, unlockAudio, playAlert } from '@/lib/alerts';
import { Icon, type IconName } from './Icon';

interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  hint: string;
}

const NAV: NavItem[] = [
  { href: '/', label: 'Arby', icon: 'bolt', hint: 'Živý přehled arbitráží' },
  { href: '/kalkulacka', label: 'Kalkulačka', icon: 'calc', hint: 'Ruční výpočet vkladů ze zadaných kurzů' },
  { href: '/sazky', label: 'Sázky', icon: 'wallet', hint: 'Přehled uložených sázek a kolik jsem v plusu / mínusu' },
  { href: '/stats', label: 'Statistiky', icon: 'chart', hint: 'Historie arbů, životnost, výsledky sázek' },
  { href: '/unmatched', label: 'Párování', icon: 'link', hint: 'Zápasy, které se nepodařilo automaticky spárovat' },
  { href: '/health', label: 'Sázkovky', icon: 'pulse', hint: 'Stav stahování kurzů ze sázkovek' },
  { href: '/settings', label: 'Nastavení', icon: 'cog', hint: 'Prahy, vklady, sázkovky, upozornění' },
];

export function Header() {
  const path = usePathname();
  const connected = useLive((s) => s.connected);
  const source = useLive((s) => s.dataSource);
  const unmatched = useLive((s) => s.unmatched);
  const counts = useLive((s) => {
    let all = 0;
    let live = 0;
    for (const a of s.arbs.values()) {
      if (a.status !== 'active') continue;
      all++;
      if (a.mode !== 'PREMATCH') live++;
    }
    return `${all}|${live}`;
  });
  const troubled = useLive((s) => s.health.filter((h) => h.enabled && h.source !== 'none' && h.state !== 'OK').length);
  const soundOn = useLive((s) => s.soundOn);
  const notifyOn = useLive((s) => s.notifyOn);
  const [active, live] = counts.split('|').map(Number);

  const badge = (href: string) => {
    if (href === '/' && active > 0)
      return (
        <span className="badge" title={`${active} aktivních arbů, z toho ${live} live/přestávka`}>
          {active}
          {live > 0 && <span className="ml-1" style={{ color: 'var(--mode-live)' }}>· {live} live</span>}
        </span>
      );
    if (href === '/unmatched' && unmatched > 0)
      return (
        <span className="badge" title={`${unmatched} zápasů čeká na ruční potvrzení`}>
          {unmatched}
        </span>
      );
    if (href === '/health' && troubled > 0)
      return <span className="inline-block h-2 w-2 rounded-full" style={{ background: 'var(--warning)' }} title={`${troubled} sázkovek má problém se stahováním`} />;
    return null;
  };

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-page/95 backdrop-blur">
      <div className="mx-auto flex max-w-[1800px] items-center gap-3 px-4 py-2">
        <Link href="/" className="flex items-center gap-2 pr-2 font-semibold" title={connected ? 'Připojeno k serveru – data chodí živě' : 'Spojení se serverem přerušeno – zkouším znovu'}>
          <span className="relative inline-flex h-2.5 w-2.5">
            {connected && <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-40" style={{ background: 'var(--good)' }} />}
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full" style={{ background: connected ? 'var(--good)' : 'var(--critical)' }} />
          </span>
          Surebet
          {!connected && <span className="text-xs font-normal" style={{ color: 'var(--critical)' }}>odpojeno</span>}
          {source === 'sim' && (
            <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[11px] font-medium text-ink-2" title="Data ze simulátoru – testovací kurzy">
              TESTOVACÍ DATA
            </span>
          )}
        </Link>
        <nav className="-mx-1 flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto px-1" aria-label="Hlavní menu">
          {NAV.map((n) => {
            const current = n.href === '/' ? path === '/' : path.startsWith(n.href);
            return (
              <Link key={n.href} href={n.href} className="nav-item" aria-current={current ? 'page' : undefined} title={n.hint}>
                <Icon name={n.icon} />
                <span>{n.label}</span>
                {badge(n.href)}
              </Link>
            );
          })}
        </nav>
        <div className="flex items-center gap-1.5" role="group" aria-label="Upozornění na nové arby">
          <button
            className="btn px-2.5"
            aria-pressed={soundOn}
            title={soundOn ? 'Zvuk pro nové arby nad prahem je zapnutý (kliknutím vypneš)' : 'Zvuk je vypnutý (kliknutím zapneš)'}
            onClick={() => {
              unlockAudio();
              setLocalPref({ soundOn: !soundOn });
              if (!soundOn) playAlert('PREMATCH');
            }}
            style={soundOn ? undefined : { color: 'var(--muted)' }}
          >
            <Icon name={soundOn ? 'bell' : 'bellOff'} />
            <span className="hidden lg:inline">{soundOn ? 'Zvuk' : 'Zvuk vyp.'}</span>
          </button>
          <button
            className="btn px-2.5"
            aria-pressed={notifyOn}
            title={notifyOn ? 'Notifikace prohlížeče jsou zapnuté (kliknutím vypneš)' : 'Notifikace jsou vypnuté (kliknutím zapneš)'}
            onClick={async () => {
              if (!notifyOn) await requestNotifications();
              setLocalPref({ notifyOn: !notifyOn });
            }}
            style={notifyOn ? undefined : { color: 'var(--muted)' }}
          >
            <Icon name={notifyOn ? 'message' : 'messageOff'} />
            <span className="hidden lg:inline">{notifyOn ? 'Notifikace' : 'Notifikace vyp.'}</span>
          </button>
        </div>
      </div>
    </header>
  );
}
