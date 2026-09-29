import type { Metadata } from 'next';
import './globals.css';
import { Header } from '@/components/Header';
import { Toasts } from '@/components/Toasts';
import { LatencyBadge } from '@/components/LatencyBadge';

export const metadata: Metadata = {
  title: 'Surebet – živé arby',
  description: 'Detekce arbitrážních příležitostí napříč českými sázkovkami',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="cs">
      <body className="min-h-screen">
        <Header />
        <main className="mx-auto max-w-[1800px] px-4 pb-10 pt-4">{children}</main>
        <Toasts />
        <LatencyBadge />
      </body>
    </html>
  );
}
