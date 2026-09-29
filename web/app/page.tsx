'use client';
import { useEffect, useState } from 'react';
import { ArbTable } from '@/components/ArbTable';
import { ArbDetail } from '@/components/ArbDetail';
import { HealthPanel } from '@/components/HealthPanel';

export default function Home() {
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    const h = (e: Event) => setOpen((e as CustomEvent<string>).detail);
    window.addEventListener('surebet:open-arb', h);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(null);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('surebet:open-arb', h);
      window.removeEventListener('keydown', esc);
    };
  }, []);
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_400px]">
      <ArbTable onOpen={setOpen} selectedId={open} />
      <HealthPanel compact />
      {open && <ArbDetail id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
