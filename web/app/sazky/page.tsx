'use client';
// Přehled sázek: všechno, co jsem uložil tlačítkem „Vsadil jsem“ (detail arbu) nebo z kalkulačky.
// Po skončení zápasu se u sázky vybere, která noha vyhrála → skutečný zisk/ztráta a průběžný součet.
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { Sport } from '@core/types';
import { api, formatDateTime, formatKc, formatKc2, marketKind, SPORT_LABEL } from '@/lib/format';
import { pushToast, useLive } from '@/lib/live';
import { BookmakerName, ModeBadge } from '@/components/Badges';
import { LineChart } from '@/components/LineChart';
import { Icon } from '@/components/Icon';

interface BetLeg {
  bookmaker: string;
  title?: string;
  stake?: number;
  actualOdds?: number;
}

interface Bet {
  id: number;
  ts: number;
  arbId: string | null;
  eventName: string;
  marketKey: string | null;
  sport: string | null;
  mode: 'PREMATCH' | 'LIVE' | 'PAUSED' | null;
  isSim: boolean;
  stake: number;
  margin: number | null;
  legs: BetLeg[];
  expectedProfit: number | null;
  result: 'won' | 'void' | 'manual' | null;
  winningLeg: number | null;
  profit: number | null;
  settledAt: number | null;
  note: string | null;
}

const PERIODS = [
  { days: 7, label: '7 dní' },
  { days: 30, label: '30 dní' },
  { days: 90, label: '90 dní' },
  { days: 3650, label: 'vše' },
];

/** Skutečný výsledek, jinak (nevyhodnocená sázka) očekávaný jistý zisk. */
function effectiveProfit(b: Bet): number {
  return b.profit ?? b.expectedProfit ?? 0;
}

function signedKc(x: number): string {
  return `${x > 0 ? '+' : ''}${formatKc2(x)}`;
}

function tone(x: number | null): string | undefined {
  if (x === null) return undefined;
  return x > 0 ? 'var(--good-text)' : x < 0 ? 'var(--critical)' : 'var(--ink-2)';
}

export default function BetsPage() {
  const [days, setDays] = useState(30);
  const [showSim, setShowSim] = useState(false);
  const source = useLive((s) => s.dataSource);
  // při běhu na testovacích datech ukázat i testovací sázky (jinak by byl přehled prázdný)
  useEffect(() => {
    if (source === 'sim') setShowSim(true);
  }, [source]);
  const [bets, setBets] = useState<Bet[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api<Bet[]>(`/bets?days=${days}`)
      .then((b) => (setBets(b), setError(null)))
      .catch((e) => setError((e as Error).message));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  const list = useMemo(() => (bets ?? []).filter((b) => showSim || !b.isSim), [bets, showSim]);
  const sum = useMemo(() => {
    const settled = list.filter((b) => b.result !== null);
    return {
      n: list.length,
      staked: list.reduce((s, b) => s + b.stake, 0),
      expected: list.reduce((s, b) => s + (b.expectedProfit ?? 0), 0),
      real: settled.reduce((s, b) => s + (b.profit ?? 0), 0),
      settled: settled.length,
      open: list.length - settled.length,
      total: list.reduce((s, b) => s + effectiveProfit(b), 0),
    };
  }, [list]);
  const curve = useMemo(() => {
    let cum = 0;
    return [...list].sort((a, b) => a.ts - b.ts).map((b) => ({ x: b.ts, y: Math.round((cum += effectiveProfit(b)) * 100) / 100 }));
  }, [list]);

  const replace = (b: Bet) => setBets((xs) => (xs ? xs.map((x) => (x.id === b.id ? b : x)) : xs));
  const settle = async (b: Bet, body: Record<string, unknown>) => {
    try {
      replace(await api<Bet>(`/bets/${b.id}`, { method: 'PATCH', body: JSON.stringify(body) }));
    } catch (e) {
      pushToast(`Vyhodnocení selhalo: ${(e as Error).message}`, 'bad');
    }
  };
  const remove = async (b: Bet) => {
    if (!confirm(`Smazat sázku „${b.eventName}“ (${formatKc(b.stake)})?`)) return;
    try {
      await api(`/bets/${b.id}`, { method: 'DELETE' });
      setBets((xs) => xs?.filter((x) => x.id !== b.id) ?? xs);
    } catch (e) {
      pushToast(`Smazání selhalo: ${(e as Error).message}`, 'bad');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-4 text-xl font-semibold">Přehled sázek</h1>
        <div className="seg" role="group" aria-label="Období">
          {PERIODS.map((p) => (
            <button key={p.days} aria-pressed={days === p.days} onClick={() => setDays(p.days)}>
              {p.label}
            </button>
          ))}
        </div>
        <label className="ml-2 flex items-center gap-1.5 text-sm text-ink-2">
          <input type="checkbox" checked={showSim} onChange={(e) => setShowSim(e.target.checked)} />
          včetně testovacích dat
        </label>
        <Link href="/kalkulacka" className="btn ml-auto">
          <Icon name="calc" /> Přidat sázku ručně
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Tile label="Sázek" value={String(sum.n)} sub={sum.open ? `${sum.open} nevyhodnoceno` : 'vše vyhodnoceno'} />
        <Tile label="Vsazeno celkem" value={formatKc(sum.staked)} />
        <Tile label="Očekávaný zisk" value={signedKc(sum.expected)} color={tone(sum.expected)} sub="jistý zisk podle vkladů a kurzů" />
        <Tile label="Skutečně vyděláno" value={signedKc(sum.real)} color={tone(sum.real)} sub={`z ${sum.settled} vyhodnocených`} />
        <Tile label="Celkem +/-" value={signedKc(sum.total)} color={tone(sum.total)} sub="vyhodnocené + očekávané u ostatních" big />
      </div>

      {curve.length > 1 && (
        <div className="card p-4">
          <h2 className="mb-1 text-sm font-semibold text-ink-2">Průběžný zisk</h2>
          <LineChart
            ariaLabel="Průběžný součet zisku ze sázek"
            height={180}
            series={[{ key: 'p', label: 'zisk', color: sum.total >= 0 ? 'var(--good)' : 'var(--critical)', points: curve, step: true }]}
            xFormat={(x) => formatDateTime(x)}
            yFormat={(y) => formatKc(y)}
            refY={{ y: 0, label: '0' }}
          />
        </div>
      )}

      {error && <div className="card px-4 py-3 text-critical">Nepodařilo se načíst sázky: {error}</div>}

      <div className="card overflow-x-auto">
        <table className="data w-full text-sm">
          <thead>
            <tr>
              <th>Kdy</th>
              <th>Zápas a trh</th>
              <th>Kde, na co, kolik</th>
              <th className="text-right">Vsazeno</th>
              <th className="text-right">Očekávaný zisk</th>
              <th>Výsledek</th>
              <th className="text-right">Zisk / ztráta</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((b) => (
              <BetRow key={b.id} b={b} onSettle={(body) => void settle(b, body)} onDelete={() => void remove(b)} />
            ))}
            {bets && !list.length && (
              <tr>
                <td colSpan={8} className="py-10 text-center text-muted">
                  Zatím žádné sázky. V detailu arbu klikni na „Vsadil jsem – uložit sázku“, nebo přidej sázku ručně v kalkulačce.
                </td>
              </tr>
            )}
            {!bets && !error && (
              <tr>
                <td colSpan={8} className="py-10 text-center text-muted">
                  Načítám…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BetRow({ b, onSettle, onDelete }: { b: Bet; onSettle: (body: Record<string, unknown>) => void; onDelete: () => void }) {
  const mk = b.marketKey ? marketKind(b.marketKey, (b.sport ?? undefined) as Sport | undefined) : null;
  const [manual, setManual] = useState(b.result === 'manual' ? String(b.profit ?? '') : '');
  const value = b.result === 'won' ? `won:${b.winningLeg}` : (b.result ?? '');
  const pick = (v: string) => {
    if (v === '') onSettle({ result: null });
    else if (v === 'void') onSettle({ result: 'void' });
    else if (v === 'manual') {
      setManual(String(b.expectedProfit ?? 0));
      onSettle({ result: 'manual', profit: b.expectedProfit ?? 0 });
    } else onSettle({ result: 'won', winningLeg: Number(v.split(':')[1]) });
  };
  return (
    <tr className={b.result ? '' : 'bg-surface-2/40'}>
      <td className="whitespace-nowrap align-top num text-ink-2">
        {formatDateTime(b.ts)}
        {b.mode && (
          <div className="mt-1">
            <ModeBadge mode={b.mode} />
          </div>
        )}
      </td>
      <td className="max-w-[280px] align-top">
        <div className="font-semibold">
          {b.arbId ? (
            <Link href={`/arb/${b.arbId}`} target={`arb-${b.arbId}`} className="hover:underline">
              {b.eventName}
            </Link>
          ) : (
            b.eventName
          )}
          {b.isSim && <span className="ml-1 rounded bg-surface-3 px-1 text-[10px] text-ink-2">TEST</span>}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
          {mk && <span className="market-tag text-xs">{mk.kind}</span>}
          {mk?.scope && <span>{mk.scope}</span>}
          {b.sport && <span>{SPORT_LABEL[b.sport as Sport] ?? b.sport}</span>}
          {b.margin !== null && <span className="num">· marže {b.margin.toFixed(2)} %</span>}
        </div>
        {b.note && <div className="mt-1 text-xs text-ink-2">{b.note}</div>}
      </td>
      <td className="align-top">
        <div className="space-y-1">
          {b.legs.map((l, i) => (
            <div key={i} className={`flex items-center gap-2 whitespace-nowrap ${b.result === 'won' && b.winningLeg !== i ? 'opacity-50' : ''}`}>
              <BookmakerName bk={l.bookmaker} />
              <span className="font-medium">{l.title ?? `výsledek ${i + 1}`}</span>
              <span className="num ml-auto pl-2 text-ink-2">
                {l.stake !== undefined ? formatKc(l.stake) : '–'} @ <b className="text-ink">{l.actualOdds?.toFixed(2) ?? '–'}</b>
              </span>
              {b.result === 'won' && b.winningLeg === i && (
                <span style={{ color: 'var(--good-text)' }} title="Vyhrála">
                  <Icon name="check" size={14} />
                </span>
              )}
            </div>
          ))}
          {!b.legs.length && <span className="text-muted">bez rozpisu nohou</span>}
        </div>
      </td>
      <td className="whitespace-nowrap text-right align-top num">{formatKc(b.stake)}</td>
      <td className="whitespace-nowrap text-right align-top num" style={{ color: tone(b.expectedProfit) }}>
        {b.expectedProfit !== null ? signedKc(b.expectedProfit) : '–'}
      </td>
      <td className="align-top">
        <select className="input max-w-[220px]" value={value} onChange={(e) => pick(e.target.value)} aria-label="Výsledek sázky">
          <option value="">nevyhodnoceno</option>
          {b.legs.map((l, i) => (
            <option key={i} value={`won:${i}`} disabled={l.stake === undefined || l.actualOdds === undefined}>
              vyhrála {i + 1}: {l.title ?? l.bookmaker}
            </option>
          ))}
          <option value="void">vráceno (0 Kč)</option>
          <option value="manual">zadat ručně…</option>
        </select>
        {b.result === 'manual' && (
          <div className="mt-1 flex items-center gap-1">
            <input className="input w-24 text-right" inputMode="decimal" value={manual} onChange={(e) => setManual(e.target.value)} aria-label="Zisk nebo ztráta v Kč" />
            <span className="text-xs text-muted">Kč</span>
            <button className="btn px-2 py-0.5 text-xs" onClick={() => onSettle({ result: 'manual', profit: Number(manual.replace(',', '.')) || 0 })}>
              uložit
            </button>
          </div>
        )}
      </td>
      <td className="whitespace-nowrap text-right align-top num text-[15px] font-bold" style={{ color: tone(b.profit) }}>
        {b.profit !== null ? signedKc(b.profit) : <span className="text-sm font-normal text-muted">čeká</span>}
      </td>
      <td className="align-top">
        <button className="btn px-2 py-1 text-muted" onClick={onDelete} title="Smazat sázku" aria-label="Smazat sázku">
          <Icon name="trash" size={14} />
        </button>
      </td>
    </tr>
  );
}

function Tile({ label, value, sub, color, big }: { label: string; value: string; sub?: string; color?: string; big?: boolean }) {
  return (
    <div className="card px-4 py-3" style={big ? { borderColor: color } : undefined}>
      <div className="text-xs text-muted">{label}</div>
      <div className={`num font-bold ${big ? 'text-2xl' : 'text-xl'}`} style={{ color }}>
        {value}
      </div>
      {sub && <div className="text-xs text-muted">{sub}</div>}
    </div>
  );
}
