'use client';
// Kalkulačka vkladů: pro každou nohu jasně „kde – na co – kolik“, souhrn jistého zisku a ROI.
// Sdílí ji detail arbu i samostatná stránka /kalkulacka. Výpočet je stejný jako v detektoru (@core/arb).
import { useEffect, useMemo, useState } from 'react';
import { arbMargin, computeStakes, computeStakesFixed } from '@core/arb';
import { pushToast } from '@/lib/live';
import { formatDuration, formatKc, formatKc2, formatPct } from '@/lib/format';
import { BookmakerChip } from './Badges';
import { Icon } from './Icon';

export interface CalcLeg {
  key: string;
  /** co vsadit, např. „Více než 2.5“, „1 · Sparta Praha“ */
  title: string;
  /** upozornění k výběru u sázkovky (prohozené pořadí týmů apod.) */
  hint?: string;
  bookmaker?: string;
  url?: string;
  /** kurz pro výpočet (po případném poplatku sázkovky) */
  odds: number;
  /** kurz, jak ho ukazuje sázkovka (když se liší od `odds` kvůli poplatku) */
  shownOdds?: number;
  /** před jakou dobou sázkovka kurz naposledy potvrdila */
  confirmedAgoMs?: number | null;
}

const PRESETS = [1000, 5000, 10000, 20000];
const UNITS = [1, 5, 10, 50, 100];

export function StakeCalculator({ legs, total: total0, unit: unit0 }: { legs: CalcLeg[]; total: number; unit: number }) {
  const [total, setTotal] = useState(total0);
  const [unit, setUnit] = useState(unit0);
  const [fixed, setFixed] = useState<{ index: number; stake: number } | null>(null);

  useEffect(() => setTotal(total0), [total0]);
  useEffect(() => setUnit(unit0), [unit0]);
  useEffect(() => setFixed(null), [legs.length]);

  const odds = legs.map((l) => l.odds);
  const valid = odds.length >= 2 && odds.every((o) => o > 1);
  const plan = useMemo(() => {
    if (!valid) return null;
    if (fixed && fixed.stake > 0 && fixed.index < odds.length) return computeStakesFixed(odds, fixed.index, fixed.stake, unit);
    return computeStakes(odds, total, unit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [odds.join(','), total, unit, fixed?.index, fixed?.stake, valid]);
  const margin = valid ? arbMargin(odds) * 100 : null;

  const copy = async (v: number) => {
    try {
      await navigator.clipboard.writeText(String(v));
      pushToast(`Vklad ${v} Kč zkopírován`, 'good');
    } catch {
      pushToast('Kopírování se nepovedlo', 'warn');
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-x-5 gap-y-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">Celkový vklad</span>
          <span className="flex items-center gap-1.5">
            <input
              className="input w-28 text-right"
              type="number"
              min={10}
              step={100}
              value={total}
              onChange={(e) => (setFixed(null), setTotal(Number(e.target.value) || 0))}
            />
            Kč
          </span>
        </label>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted">Rychlá volba</span>
          <div className="seg" role="group" aria-label="Rychlá volba vkladu">
            {PRESETS.map((p) => (
              <button key={p} aria-pressed={!fixed && total === p} onClick={() => (setFixed(null), setTotal(p))}>
                {p / 1000}k
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted">Zaokrouhlit vklady na</span>
          <div className="seg" role="group" aria-label="Zaokrouhlení vkladů">
            {UNITS.map((u) => (
              <button key={u} aria-pressed={unit === u} onClick={() => setUnit(u)}>
                {u} Kč
              </button>
            ))}
          </div>
        </div>
      </div>

      {!valid && <div className="rounded-md bg-surface-2 px-3 py-2 text-sm text-muted">Zadej kurzy všech výsledků (větší než 1).</div>}

      <ol className="space-y-2">
        {legs.map((l, i) => {
          const stake = plan?.stakes[i] ?? 0;
          const isFixed = fixed?.index === i;
          return (
            <li key={l.key} className="rounded-lg border border-line bg-surface-2 px-3 py-2.5">
              <div className="flex items-start gap-3">
                <span className="step" aria-hidden>
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {l.bookmaker && <BookmakerChip bk={l.bookmaker} />}
                    {l.url && (
                      <a href={l.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-accent hover:underline">
                        otevřít zápas <Icon name="external" size={12} />
                      </a>
                    )}
                    {l.confirmedAgoMs != null && <span className="text-[11px] text-muted">kurz ověřen před {formatDuration(l.confirmedAgoMs)}</span>}
                  </div>
                  <div className="mt-0.5 font-medium">{l.title}</div>
                  {l.hint && (
                    <div className="mt-0.5 flex items-center gap-1 text-xs" style={{ color: 'var(--warning)' }}>
                      <Icon name="swap" size={12} /> {l.hint}
                    </div>
                  )}
                </div>
                <div className="text-right">
                  <div className="text-[11px] text-muted">kurz</div>
                  <div className="num text-lg font-semibold leading-tight">{fmtOdds(l.shownOdds ?? l.odds)}</div>
                  {l.shownOdds !== undefined && l.odds > 1 && l.shownOdds !== l.odds && <div className="num text-[11px] text-muted">po poplatku {l.odds.toFixed(3)}</div>}
                </div>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 pl-9">
                <span className="text-sm text-ink-2">Vsaď</span>
                <input
                  className="input w-28 text-right text-base font-semibold"
                  type="number"
                  min={0}
                  value={stake}
                  onChange={(e) => setFixed({ index: i, stake: Number(e.target.value) || 0 })}
                  aria-label={`Vklad na výběr ${i + 1}`}
                  title="Přepsáním vkladu se ostatní nohy dopočítají"
                />
                <span className="text-sm text-ink-2">Kč</span>
                <button className="btn px-2 py-1" onClick={() => void copy(stake)} title="Zkopírovat vklad" aria-label="Zkopírovat vklad">
                  <Icon name="copy" size={14} />
                </button>
                {isFixed && (
                  <span className="inline-flex items-center gap-1 rounded bg-surface-3 px-1.5 py-0.5 text-[11px] text-ink-2" title="Vklad zadaný ručně – ostatní nohy se dopočítaly">
                    <Icon name="lock" size={11} /> pevný
                  </span>
                )}
                <span className="ml-auto text-xs text-muted">
                  výplata <b className="num text-ink">{plan ? formatKc2(plan.payouts[i]) : '–'}</b>
                </span>
              </div>
            </li>
          );
        })}
      </ol>

      {plan && (
        <div className="space-y-2">
          <div className="grid grid-cols-3 gap-2">
            <Summary label="Vsadíš celkem" value={formatKc(plan.total)} />
            <Summary label="Jistý zisk" value={`${plan.minProfit > 0 ? '+' : ''}${formatKc2(plan.minProfit)}`} tone={plan.positive ? 'good' : 'bad'} />
            <Summary label="Výnos (ROI)" value={formatPct(plan.roi * 100)} sub={margin !== null ? `marže arbu ${formatPct(margin)}` : undefined} />
          </div>
          {new Set(plan.profits).size > 1 && (
            <div className="text-xs text-muted">
              Zisk podle výsledku:{' '}
              {plan.profits.map((p, i) => (
                <span key={legs[i].key} className="num">
                  {i > 0 && ' · '}
                  {i + 1}: {p > 0 ? '+' : ''}
                  {formatKc2(p)}
                </span>
              ))}
            </div>
          )}
          {!plan.positive && (
            <div className="text-sm" style={{ color: 'var(--critical)' }}>
              {margin !== null && margin <= 0 ? '⚠ Kurzy netvoří arbitráž – v některém výsledku proděláš.' : '⚠ Zaokrouhlení nevychází do zisku – zkus menší zaokrouhlení nebo jiný vklad.'}
            </div>
          )}
          <div className="flex items-center gap-2 text-xs text-muted">
            <span>Přepíšeš-li vklad u jedné sázkovky (např. přijala méně), ostatní se dopočítají.</span>
            {fixed && (
              <button className="btn ml-auto px-2 py-0.5 text-xs" onClick={() => setFixed(null)}>
                zpět na celkový vklad
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function fmtOdds(o: number): string {
  return Number.isFinite(o) && o > 1 ? o.toFixed(2) : '–';
}

function Summary({ label, value, tone, sub }: { label: string; value: string; tone?: 'good' | 'bad'; sub?: string }) {
  return (
    <div className="rounded-md bg-surface-2 px-2.5 py-2">
      <div className="text-[11px] text-muted">{label}</div>
      <div className="num text-base font-semibold" style={tone ? { color: tone === 'good' ? 'var(--good-text)' : 'var(--critical)' } : undefined}>
        {value}
      </div>
      {sub && <div className="num text-[11px] text-muted">{sub}</div>}
    </div>
  );
}
