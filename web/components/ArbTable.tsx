'use client';
import { useEffect, useMemo, useState } from 'react';
import type { BookmakerId, Mode, Sport } from '@core/types';
import { BOOKMAKERS, MODES, SPORTS } from '@core/types';
import { useLive, type ArbRow } from '@/lib/live';
import { SPORT_LABEL, clockLabel, formatCountdown, formatDuration, formatKc, bkName } from '@/lib/format';
import { BookmakerChip, ModeBadge } from './Badges';
import { useNow } from './useNow';

type SortKey = 'margin' | 'lifetime' | 'age';

interface Filters {
  modes: Mode[];
  sports: Sport[];
  minMargin: number;
  bookmakers: BookmakerId[];
  sort: SortKey;
  hideMuted: boolean;
}

const DEFAULT_FILTERS: Filters = { modes: [...MODES], sports: [...SPORTS], minMargin: 0, bookmakers: [...BOOKMAKERS], sort: 'margin', hideMuted: false };

function loadFilters(): Filters {
  try {
    return { ...DEFAULT_FILTERS, ...JSON.parse(localStorage.getItem('surebet:filters') ?? '{}') };
  } catch {
    return DEFAULT_FILTERS;
  }
}

export function ArbTable({ onOpen, selectedId }: { onOpen: (id: string) => void; selectedId: string | null }) {
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
        f.sports.includes(a.sport) &&
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
        <div className="flex items-center gap-1">
          {SPORTS.map((s) => (
            <button
              key={s}
              className={`rounded px-2 py-0.5 ${f.sports.includes(s) ? 'bg-surface-3 text-ink' : 'text-muted'}`}
              onClick={() => update({ sports: toggle(f.sports, s) })}
              aria-pressed={f.sports.includes(s)}
            >
              {SPORT_LABEL[s]}
            </button>
          ))}
        </div>
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
              <th>Sport</th>
              <th>Zápas</th>
              <th>Trh</th>
              <th className="text-right">Marže</th>
              <th className="text-right">Stáří</th>
              <th className="text-right" title="Medián predikované životnosti a P(přežije > 10 s)">
                Predikce
              </th>
              <th>Sázkovky</th>
              <th className="text-right">Zisk</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <Row key={a.id} a={a} now={now} selected={a.id === selectedId} onOpen={onOpen} />
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={9} className="py-10 text-center text-muted">
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

function Row({ a, now, selected, onOpen }: { a: ArbRow; now: number; selected: boolean; onOpen: (id: string) => void }) {
  const isNew = a.status === 'active' && now - a.addedAt < 3200;
  const arrowFresh = a.marginDir && now - a.marginDirAt < 5000;
  const cls = [a.status === 'ended' ? 'row-ended' : '', isNew ? 'row-new' : '', a.muted && a.status === 'active' ? 'row-muted' : '', selected ? 'bg-surface-2' : '', 'cursor-pointer hover:bg-surface-2']
    .filter(Boolean)
    .join(' ');
  const st = a.state;
  const age = (a.status === 'ended' ? (a.endedAt ?? now) : now) - a.firstSeen;
  return (
    <tr className={cls} onClick={() => onOpen(a.id)}>
      <td>
        <ModeBadge mode={a.mode} />
      </td>
      <td className="text-ink-2">{SPORT_LABEL[a.sport]}</td>
      <td className="max-w-[340px]">
        <div className="truncate font-medium">{a.eventName}</div>
        <div className="truncate text-xs text-muted">
          {a.competition}
          {st?.score && ` · ${st.score[0]}:${st.score[1]}`}
          {a.mode !== 'PREMATCH' && clockLabel(st) && ` · ${clockLabel(st)}`}
          {a.mode === 'PAUSED' && a.pause && ` · pauza ${formatDuration(Math.max(0, a.pause.expectedSec * 1000 - (now - a.pause.startedAt)))} zbývá`}
          {a.mode === 'PREMATCH' && ` · výkop za ${formatCountdown(Math.round((a.startTime - now) / 1000))}`}
        </div>
      </td>
      <td className="whitespace-nowrap text-ink-2">{a.marketLabel}</td>
      <td className="whitespace-nowrap text-right num font-semibold">
        {arrowFresh && (
          <span className="mr-1" style={{ color: a.marginDir === 'up' ? 'var(--good)' : 'var(--critical)' }} aria-label={a.marginDir === 'up' ? 'marže roste' : 'marže klesá'}>
            {a.marginDir === 'up' ? '▲' : '▼'}
          </span>
        )}
        {a.margin.toFixed(2)} %
      </td>
      <td className="text-right num text-ink-2">{formatDuration(age)}</td>
      <td className="whitespace-nowrap text-right num">
        {a.prediction ? (
          <span title={`segment ${a.prediction.segment} · n=${a.prediction.n}`}>
            {formatDuration(a.prediction.medianMs)}
            <span className="text-muted"> · {(a.prediction.pOver[10] * 100).toFixed(0)} %</span>
          </span>
        ) : (
          <span className="text-muted">málo dat</span>
        )}
        {a.risky && (
          <span className="ml-1" style={{ color: 'var(--warning)' }} title="Predikovaná životnost přesahuje zbývající čas přestávky">
            ⚠
          </span>
        )}
        {a.muted && a.status === 'active' && (
          <span className="ml-1 text-muted" title="Nízká pravděpodobnost, že arb vydrží reakční dobu + přijetí sázky">
            🔇
          </span>
        )}
      </td>
      <td>
        <div className="flex flex-wrap gap-1">
          {a.legs.map((l) => (
            <span key={l.selection} className="inline-flex items-center gap-1 rounded bg-surface-2 px-1.5 py-0.5 text-xs">
              <span className="text-muted" title={l.market && l.market !== a.market ? `sází se na trh ${l.marketLabel}` : undefined}>
                {l.selectionLabel}
                {l.market && l.market !== a.market && '*'}
              </span>
              <span className="num font-semibold">{l.odds.toFixed(2)}</span>
              <BookmakerChip bk={l.bookmaker} small />
            </span>
          ))}
        </div>
      </td>
      <td className="whitespace-nowrap text-right num" style={{ color: a.positive ? 'var(--good-text)' : 'var(--muted)' }}>
        {a.positive ? '+' : ''}
        {formatKc(a.minProfit)}
      </td>
    </tr>
  );
}
