'use client';
// Ruční kalkulačka surebetu: zadáš kurzy 2–3 výsledků (volitelně sázkovku kvůli poplatku) a dostaneš
// vklady zaokrouhlené na celé koruny tak, aby zisk vyšel ve všech výsledcích. Z detailu arbu se
// otevírá předvyplněná (?o=kurzy&b=sázkovky&l=popisky&t=vklad).
import { useEffect, useState } from 'react';
import { BOOKMAKERS } from '@core/types';
import { effectiveOdds, impliedSum } from '@core/arb';
import Link from 'next/link';
import { api, bkName, formatPct } from '@/lib/format';
import { pushToast, useLive } from '@/lib/live';
import { StakeCalculator, type CalcLeg, type CalcPlan } from '@/components/StakeCalculator';
import { Icon } from '@/components/Icon';

interface Row {
  label: string;
  odds: string;
  bookmaker: string;
}

const LABELS: Record<2 | 3, string[]> = { 2: ['1', '2'], 3: ['1', 'X', '2'] };
const empty = (n: 2 | 3): Row[] => LABELS[n].map((label) => ({ label, odds: '', bookmaker: '' }));

function parseOdds(s: string): number {
  const v = Number(s.replace(',', '.').trim());
  return Number.isFinite(v) ? v : NaN;
}

export default function CalculatorPage() {
  const settings = useLive((s) => s.settings);
  const [n, setN] = useState<2 | 3>(2);
  const [rows, setRows] = useState<Row[]>(empty(2));
  const [total, setTotal] = useState<number | null>(null);
  const [event, setEvent] = useState('');
  const [plan, setPlan] = useState<CalcPlan | null>(null);
  const [saved, setSaved] = useState(false);

  // předvyplnění z URL (z detailu arbu)
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const o = (q.get('o') ?? '').split(',').filter(Boolean);
    if (o.length === 2 || o.length === 3) {
      const b = (q.get('b') ?? '').split(',');
      const l = (q.get('l') ?? '').split('|');
      const k = o.length as 2 | 3;
      setN(k);
      setRows(o.map((odds, i) => ({ odds, bookmaker: BOOKMAKERS.includes(b[i] as never) ? b[i] : '', label: l[i] || LABELS[k][i] })));
    }
    const t = Number(q.get('t'));
    if (t > 0) setTotal(t);
    setEvent(q.get('e') ?? '');
  }, []);

  const setCount = (k: 2 | 3) => {
    if (k === n) return;
    setN(k);
    // 2 → 3: doprostřed přibude remíza; 3 → 2: remíza odpadne
    setRows((r) => (k === 3 ? [r[0], { label: 'X', odds: '', bookmaker: '' }, r[1]] : [r[0], r[2]]));
  };
  const upd = (i: number, p: Partial<Row>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...p } : x)));

  const fee = (bk: string) => (bk ? (settings?.bookmakers[bk as keyof typeof settings.bookmakers]?.feePct ?? 0) : 0);
  const legs: CalcLeg[] = rows.map((r, i) => {
    const shown = parseOdds(r.odds);
    const eff = shown > 1 ? effectiveOdds(shown, fee(r.bookmaker)) : NaN;
    return { key: String(i), title: r.label || `Výsledek ${i + 1}`, bookmaker: r.bookmaker || undefined, odds: eff, shownOdds: shown };
  });
  const valid = legs.every((l) => l.odds > 1);
  const sum = valid ? impliedSum(legs.map((l) => l.odds)) : null;
  const margin = sum ? (1 / sum - 1) * 100 : null;

  // ruční sázka do přehledu (bez arbu): popis zápasu + nohy s vklady z kalkulačky
  const save = async () => {
    if (!plan) return;
    try {
      await api('/actions', {
        method: 'POST',
        body: JSON.stringify({
          action: 'placed',
          stake: plan.total,
          marginAtClick: margin ?? undefined,
          eventName: event.trim() || 'Ruční sázka',
          legs: rows.map((r, i) => ({
            bookmaker: r.bookmaker || undefined,
            title: r.label || `Výsledek ${i + 1}`,
            stake: plan.stakes[i],
            actualOdds: parseOdds(r.odds),
          })),
        }),
      });
      setSaved(true);
      pushToast('Sázka uložena do Přehledu sázek', 'good');
    } catch (e) {
      pushToast(`Uložení selhalo: ${(e as Error).message}`, 'bad');
    }
  };
  const canSave = !!plan && valid && rows.every((r) => r.bookmaker);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Kalkulačka vkladů</h1>
        <span className="text-sm text-muted">Zadej kurzy všech výsledků – spočítám, kolik vsadit u které sázkovky.</span>
      </div>

      <section className="card space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-ink-2">Počet výsledků</span>
          <div className="seg" role="group" aria-label="Počet výsledků">
            <button aria-pressed={n === 2} onClick={() => setCount(2)}>
              2 (vítěz, více/méně, handicap)
            </button>
            <button aria-pressed={n === 3} onClick={() => setCount(3)}>
              3 (1X2)
            </button>
          </div>
          <button className="btn ml-auto" onClick={() => setRows(empty(n))}>
            Vymazat
          </button>
        </div>
        <div className="space-y-2 text-sm">
          <div className="hidden grid-cols-[28px_1fr_190px_110px] gap-3 px-0.5 text-xs text-muted sm:grid">
            <span>#</span>
            <span>Výsledek (popisek)</span>
            <span>Sázkovka</span>
            <span className="text-right">Kurz</span>
          </div>
          {rows.map((r, i) => (
            // mobil: číslo | popisek | kurz, sázkovka na druhém řádku; desktop: vše v jednom řádku
            <div key={i} className="grid grid-cols-[28px_1fr_96px] items-center gap-2 sm:grid-cols-[28px_1fr_190px_110px] sm:gap-3">
              <span className="step">{i + 1}</span>
              <input className="input w-full min-w-0" value={r.label} onChange={(e) => upd(i, { label: e.target.value })} aria-label={`Popisek výsledku ${i + 1}`} />
              <select
                className="input order-last col-span-2 col-start-2 min-w-0 sm:order-none sm:col-span-1 sm:col-start-auto"
                value={r.bookmaker}
                onChange={(e) => upd(i, { bookmaker: e.target.value })}
                aria-label={`Sázkovka výsledku ${i + 1}`}
              >
                <option value="">– libovolná sázkovka –</option>
                {BOOKMAKERS.map((b) => (
                  <option key={b} value={b}>
                    {bkName(b)}
                    {fee(b) > 0 ? ` (poplatek ${fee(b)} %)` : ''}
                  </option>
                ))}
              </select>
              <input
                className="input w-full min-w-0 text-right text-base font-semibold"
                inputMode="decimal"
                placeholder="2.10"
                value={r.odds}
                onChange={(e) => upd(i, { odds: e.target.value })}
                aria-label={`Kurz výsledku ${i + 1}`}
              />
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-muted">
            Součet pravděpodobností Σ 1/kurz: <b className="num text-ink">{sum ? sum.toFixed(4) : '–'}</b>
          </span>
          {margin !== null && (
            <span
              className="rounded px-2 py-0.5 font-semibold num"
              style={{ background: 'var(--surface-3)', color: margin > 0 ? 'var(--good-text)' : 'var(--critical)' }}
            >
              {margin > 0 ? `Arbitráž +${formatPct(margin)}` : `Není arb (${formatPct(margin)})`}
            </span>
          )}
        </div>
      </section>

      <section className="card p-4">
        <h2 className="mb-3 font-medium">Vklady</h2>
        <StakeCalculator legs={legs} total={total ?? settings?.bankroll ?? 10000} unit={settings?.roundingUnit ?? 1} onPlan={setPlan} />
      </section>

      <section className="card flex flex-wrap items-end gap-3 p-4">
        <label className="flex min-w-60 flex-1 flex-col gap-1">
          <span className="text-xs text-muted">Zápas (popis do přehledu sázek)</span>
          <input className="input" value={event} placeholder="např. Sparta – Slavia, více/méně 2.5" onChange={(e) => (setEvent(e.target.value), setSaved(false))} />
        </label>
        <button className="btn btn-primary px-4 py-2" disabled={!canSave} onClick={() => void save()} title={canSave ? undefined : 'Vyplň kurzy a u každého výsledku sázkovku'}>
          <Icon name="check" /> Vsadil jsem – uložit sázku
        </button>
        {saved && (
          <Link href="/sazky" className="inline-flex items-center gap-1 text-sm text-accent hover:underline">
            <Icon name="wallet" size={14} /> Přehled sázek
          </Link>
        )}
      </section>

      <p className="text-xs text-muted">
        Vklady se zaokrouhlují tak, aby zisk zůstal kladný ve všech výsledcích. U sázkovky s poplatkem z vkladu (Nastavení → Sázkovky) se počítá s
        kurzem po poplatku. Arb s celou linií (např. handicap 0 nebo více/méně 3.0) může skončit vrácením vkladů.
      </p>
    </div>
  );
}
