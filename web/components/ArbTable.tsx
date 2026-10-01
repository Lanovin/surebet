'use client';
import { useEffect, useMemo, useState } from 'react';
import type { BookmakerId, Mode, Sport } from '@core/types';
import { BOOKMAKERS, MODES, SPORTS } from '@core/types';
import { useLive, type ArbRow } from '@/lib/live';
import { SPORT_LABEL, clockLabel, describeLeg, formatCountdown, formatDuration, formatKc, bkName, marketKind } from '@/lib/format';
import { BookmakerChip, BookmakerName, ModeBadge } from './Badges';
import { Icon } from './Icon';
import { useNow } from './useNow';

/** Detail arbu (kalkulačka, kde a co vsadit) v nové záložce – dá se přetáhnout na druhý monitor. */
export function arbHref(id: string): string {
  return `/arb/${id}`;
}
export function openArb(id: string): void {
  window.open(arbHref(id), `arb-${id}`);
}

type SortKey = 'margin' | 'lifetime' | 'age';

interface Filters {
  modes: Mode[];
  /** skryté sporty (ukládá se výčet skrytých, aby nově přidané sporty byly vidět) */
  hiddenSports: Sport[];
  minMargin: number;
  bookmakers: BookmakerId[];
  sort: SortKey;
  hideMuted: boolean;
}

const DEFAULT_FILTERS: Filters = { modes: [...MODES], hiddenSports: [], minMargin: 0, bookmakers: [...BOOKMAKERS], sort: 'margin', hideMuted: false };

function loadFilters(): Filters {
  try {
    const stored = JSON.parse(localStorage.getItem('surebet:filters') ?? '{}');
    delete stored.sports; // starý formát (výčet zobrazených) by skryl nově přidané sporty
    return { ...DEFAULT_FILTERS, ...stored };
  } catch {
    return DEFAULT_FILTERS;
  }
}

export function ArbTable() {
  const arbs = useLive((s) => s.arbs);
  const [f, setF] = useState<Filters>(DEFAULT_FILTERS);
  const now = useNow(500);
  useEffect(() => setF(loadFilters()), []);
  const update = (p: Partial<Filters>) => {
    const next = { ...f, ...p };
    setF(next);
    try {
      localStorage.setItem('surebet:filters', JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };

  const rows = useMemo(() => {
    const list = [...arbs.values()].filter(
      (a) =>
        f.modes.includes(a.mode) &&
        !f.hiddenSports.includes(a.sport) &&
        a.margin >= f.minMargin &&
        a.legs.every((l) => f.bookmakers.includes(l.bookmaker)) &&
        (!f.hideMuted || !a.muted || a.status === 'ended'),
    );
    const life = (a: ArbRow) => a.prediction?.medianMs ?? (a.prediction ? Infinity : -1);
    list.sort((a, b) => {
      if (f.sort === 'margin') return b.margin - a.margin;
      if (f.sort === 'lifetime') return life(b) - life(a);
      return a.firstSeen - b.firstSeen;
    });
    return list;
  }, [arbs, f]);

  const toggle = <T,>(arr: T[], v: T) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  const sportCounts = useMemo(() => {
    const c: Partial<Record<Sport, number>> = {};
    for (const a of arbs.values()) if (a.status === 'active') c[a.sport] = (c[a.sport] ?? 0) + 1;
    return c;
  }, [arbs]);

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-line px-3 py-2 text-sm">
        <div className="flex items-center gap-1">
          {MODES.map((m) => (
            <button key={m} className={`rounded px-1.5 py-0.5 ${f.modes.includes(m) ? '' : 'opacity-40'}`} onClick={() => update({ modes: toggle(f.modes, m) })} aria-pressed={f.modes.includes(m)}>
              <ModeBadge mode={m} />
            </button>
          ))}
        </div>
        <SportFilter hidden={f.hiddenSports} counts={sportCounts} onChange={(hiddenSports) => update({ hiddenSports })} />
        <label className="flex items-center gap-1.5 text-ink-2">
          min. marže
          <input
            className="input w-16"
            type="number"
            step={0.1}
            min={0}
            value={f.minMargin}
            onChange={(e) => update({ minMargin: Number(e.target.value) || 0 })}
          />
          %
        </label>
        <label className="flex items-center gap-1.5 text-ink-2">
          řadit
          <select className="input" value={f.sort} onChange={(e) => update({ sort: e.target.value as SortKey })}>
            <option value="margin">marže</option>
            <option value="lifetime">predikovaná životnost</option>
            <option value="age">stáří</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-ink-2">
          <input type="checkbox" checked={f.hideMuted} onChange={(e) => update({ hideMuted: e.target.checked })} />
          skrýt ztlumené
        </label>
        <div className="flex flex-wrap items-center gap-1">
          {BOOKMAKERS.map((b) => (
            <button key={b} className={f.bookmakers.includes(b) ? '' : 'opacity-35'} onClick={() => update({ bookmakers: toggle(f.bookmakers, b) })} aria-pressed={f.bookmakers.includes(b)} title={bkName(b)}>
              <BookmakerChip bk={b} small />
            </button>
          ))}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="data w-full text-sm">
          <thead>
            <tr>
              <th>Režim</th>
              <th>Zápas</th>
              <th>Na co se sází</th>
              <th>Kde a co vsadit</th>
              <th className="text-right">Marže</th>
              <th className="text-right">Zisk</th>
              <th className="text-right">Stáří</th>
              <th className="text-right" title="Medián predikované životnosti a P(přežije > 10 s)">
                Predikce
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <Row key={a.id} a={a} now={now} />
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={8} className="py-10 text-center text-muted">
                  {arbs.size ? 'Žádný arb neodpovídá filtrům.' : 'Zatím žádné aktivní arby – jakmile se objeví, naskočí sem živě.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Row({ a, now }: { a: ArbRow; now: number }) {
  const isNew = a.status === 'active' && now - a.addedAt < 3200;
  const arrowFresh = a.marginDir && now - a.marginDirAt < 5000;
  const cls = [a.status === 'ended' ? 'row-ended' : '', isNew ? 'row-new' : '', a.muted && a.status === 'active' ? 'row-muted' : '', 'cursor-pointer hover:bg-surface-2']
    .filter(Boolean)
    .join(' ');
  const st = a.state;
  const age = (a.status === 'ended' ? (a.endedAt ?? now) : now) - a.firstSeen;
  const mk = marketKind(a.market, a.sport);
  return (
    <tr className={cls} onClick={() => openArb(a.id)} title="Otevřít detail s kalkulačkou v nové záložce">
      <td className="align-top">
        <ModeBadge mode={a.mode} />
        <div className="mt-1 text-xs text-muted">{SPORT_LABEL[a.sport]}</div>
      </td>
      <td className="max-w-[300px] align-top">
        <a href={arbHref(a.id)} target={`arb-${a.id}`} onClick={(e) => e.stopPropagation()} className="block truncate text-[15px] font-semibold hover:underline">
          {a.eventName}
        </a>
        <div className="truncate text-xs text-muted">
          {a.competition}
          {st?.score && ` · ${st.score[0]}:${st.score[1]}`}
          {a.mode !== 'PREMATCH' && clockLabel(st) && ` · ${clockLabel(st)}`}
          {a.mode === 'PAUSED' && a.pause && ` · pauza ${formatDuration(Math.max(0, a.pause.expectedSec * 1000 - (now - a.pause.startedAt)))} zbývá`}
          {a.mode === 'PREMATCH' && ` · výkop za ${formatCountdown(Math.round((a.startTime - now) / 1000))}`}
        </div>
      </td>
      <td className="align-top">
        <span className="market-tag text-[15px]">{mk.kind}</span>
        {(mk.detail || mk.scope) && (
          <div className="mt-1 text-xs text-ink-2">
            {mk.scope && <b className="text-ink">{mk.scope} · </b>}
            {mk.detail}
          </div>
        )}
      </td>
      <td className="align-top">
        <div className="space-y-1">
          {a.legs.map((l) => {
            const d = describeLeg(l.market ?? a.market, l.marketSelection ?? l.selection, a, l.swapped);
            return (
              <div key={l.selection} className="flex items-center gap-2 whitespace-nowrap">
                <BookmakerName bk={l.bookmaker} />
                <span className="text-muted">
                  <Icon name="arrowRight" size={13} />
                </span>
                <span className="font-medium" title={l.market && l.market !== a.market ? `sází se na trh ${l.marketLabel}` : undefined}>
                  {d.title}
                  {l.market && l.market !== a.market && <span className="text-muted"> *</span>}
                </span>
                <span className="num ml-auto pl-2 text-[15px] font-bold">{l.odds.toFixed(2)}</span>
              </div>
            );
          })}
        </div>
      </td>
      <td className="whitespace-nowrap text-right align-top num text-[15px] font-semibold">
        {arrowFresh && (
          <span className="mr-1 inline-flex align-middle" style={{ color: a.marginDir === 'up' ? 'var(--good)' : 'var(--critical)' }} aria-label={a.marginDir === 'up' ? 'marže roste' : 'marže klesá'}>
            <Icon name={a.marginDir === 'up' ? 'up' : 'down'} size={13} />
          </span>
        )}
        {a.margin.toFixed(2)} %
      </td>
      <td className="whitespace-nowrap text-right align-top num font-semibold" style={{ color: a.positive ? 'var(--good-text)' : 'var(--muted)' }}>
        {a.positive ? '+' : ''}
        {formatKc(a.minProfit)}
      </td>
      <td className="text-right align-top num text-ink-2">{formatDuration(age)}</td>
      <td className="whitespace-nowrap text-right align-top num">
        {a.prediction ? (
          <span title={`segment ${a.prediction.segment} · n=${a.prediction.n}`}>
            {formatDuration(a.prediction.medianMs)}
            <span className="text-muted"> · {(a.prediction.pOver[10] * 100).toFixed(0)} %</span>
          </span>
        ) : (
          <span className="text-muted">málo dat</span>
        )}
        {a.risky && (
          <span className="ml-1 inline-flex align-middle" style={{ color: 'var(--warning)' }} title="Predikovaná životnost přesahuje zbývající čas přestávky">
            <Icon name="warn" size={14} />
          </span>
        )}
        {a.muted && a.status === 'active' && (
          <span className="ml-1 inline-flex align-middle text-muted" title="Ztlumeno: nízká pravděpodobnost, že arb vydrží reakční dobu + přijetí sázky">
            <Icon name="mute" size={14} />
          </span>
        )}
      </td>
    </tr>
  );
}

/** Výběr sportů: rozbalovací seznam se zaškrtávátky a počtem aktivních arbů (13 sportů by lištu zahltilo). */
function SportFilter({ hidden, counts, onChange }: { hidden: Sport[]; counts: Partial<Record<Sport, number>>; onChange: (hidden: Sport[]) => void }) {
  const shown = SPORTS.length - hidden.length;
  return (
    <details className="relative">
      <summary className="btn cursor-pointer list-none py-1 text-sm">
        Sporty: {hidden.length ? `${shown} z ${SPORTS.length}` : 'všechny'} <Icon name="chevDown" size={14} />
      </summary>
      <div className="card absolute left-0 z-30 mt-1 w-56 space-y-0.5 p-2 shadow-xl">
        <div className="mb-1 flex gap-2 text-xs">
          <button className="text-accent hover:underline" onClick={() => onChange([])}>
            všechny
          </button>
          <button className="text-accent hover:underline" onClick={() => onChange([...SPORTS])}>
            žádný
          </button>
        </div>
        {SPORTS.map((sp) => (
          <label key={sp} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-surface-2">
            <input type="checkbox" checked={!hidden.includes(sp)} onChange={() => onChange(hidden.includes(sp) ? hidden.filter((x) => x !== sp) : [...hidden, sp])} />
            <span className="flex-1">{SPORT_LABEL[sp]}</span>
            {counts[sp] ? <span className="badge">{counts[sp]}</span> : null}
          </label>
        ))}
      </div>
    </details>
  );
}
