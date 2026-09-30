'use client';
import { useEffect, useState } from 'react';
import { api, bkName, endReasonLabel, formatDuration, formatKc, formatPct, SPORT_LABEL } from '@/lib/format';
import { useLive } from '@/lib/live';
import { HBars, StackedColumns } from '@/components/Bars';
import { LineChart } from '@/components/LineChart';
import { modeColor } from '@/components/Badges';
import type { Mode, Sport } from '@core/types';

interface Group {
  key: string | number;
  n: number;
  avg_margin: number;
  max_margin: number;
  median_ms: number | null;
}
interface KM {
  summary: { n: number; nEvents: number; medianMs: number | null; p25Ms: number | null; p75Ms: number | null; pOver: Record<string, number> };
  curve: { t: number; s: number }[];
}
interface Stats {
  totals: { arbs: number; active: number; censored: number; avg_margin: number | null };
  bySport: Group[];
  byMode: Group[];
  byMarket: Group[];
  byPair: Group[];
  byHour: Group[];
  endReasons: { key: string; n: number }[];
  histogram: { lo: number; hi: number | null; ended: number; censored: number }[];
  kmByMode: Record<Mode, KM | null>;
  kmBySport: Partial<Record<Sport, KM | null>>;
  actions: {
    total: number;
    placed: number;
    successRate: number | null;
    byAction: { key: string; n: number; avg_reaction_ms: number }[];
    slippage: { bookmaker: string; n: number; avg_slippage_pct: number }[];
    rejections: { key: string; n: number }[];
  };
  profit: { day: string; n: number; staked: number; profit: number; cumulative: number }[];
}

const SPORT_COLORS: Record<Sport, string> = {
  football: 'var(--s1)',
  tennis: 'var(--s2)',
  basketball: 'var(--s3)',
  hockey: 'var(--s4)',
  handball: '#8b5cf6',
  volleyball: '#0ea5e9',
  baseball: '#a3a3a3',
  american_football: '#b45309',
  mma: '#e11d48',
  boxing: '#be123c',
  darts: '#16a34a',
  snooker: '#15803d',
  table_tennis: '#db2777',
};
const ACTION_LABEL: Record<string, string> = { placed: 'Vsadil', missed: 'Nestihl', rejected: 'Odmítnuto', odds_changed: 'Změna kurzu' };

export default function StatsPage() {
  const source = useLive((s) => s.dataSource);
  // zdroj vybraný uživatelem, jinak ten, ze kterého právě běží ingest
  const [picked, setPicked] = useState<'sim' | 'real' | null>(null);
  const src = picked ?? (source === 'sim' || source === 'real' ? source : null);
  const [days, setDays] = useState(7);
  const [data, setData] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!src) return; // počkat, až gateway řekne zdroj dat
    setLoading(true);
    void api<Stats>(`/stats?source=${src}&days=${days}`)
      .then(setData)
      .finally(() => setLoading(false));
  }, [src, days]);

  const grp = (g: Group[], label: (k: string | number) => string = String) =>
    g.map((x) => ({ label: label(x.key), value: x.n, extra: `Ø ${x.avg_margin?.toFixed(2)} % · med ${formatDuration(x.median_ms)}` }));

  return (
    <div className={`space-y-4 ${loading && data ? 'opacity-60' : ''}`}>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-4 text-lg font-semibold">Statistiky</h1>
        {[1, 7, 30, 90].map((d) => (
          <button key={d} className={`btn ${days === d ? 'bg-surface-3' : ''}`} onClick={() => setDays(d)}>
            {d === 1 ? 'dnes' : `${d} dní`}
          </button>
        ))}
        <span className="mx-2 h-5 w-px bg-[var(--grid)]" />
        {(['sim', 'real'] as const).map((s) => (
          <button key={s} className={`btn ${src === s ? 'bg-surface-3' : ''}`} onClick={() => setPicked(s)}>
            {s === 'sim' ? 'testovací data' : 'skutečná data'}
          </button>
        ))}
      </div>
      {!data ? (
        <div className="text-muted">Načítám…</div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Tile label="Arbů celkem" value={String(data.totals.arbs)} />
            <Tile label="Průměrná marže" value={formatPct(data.totals.avg_margin)} />
            <Tile label="Cenzurováno" value={String(data.totals.censored)} />
            <Tile label="Úspěšnost (vsazeno / akcí)" value={data.actions.successRate === null ? '–' : `${(data.actions.successRate * 100).toFixed(0)} %`} />
            <Tile label="Zisk (očekávaný)" value={formatKc(data.profit.at(-1)?.cumulative ?? 0)} />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card title="Kaplan–Meier podle režimu" sub="P(arb stále trvá) v čase od detekce; cenzurované (restart, konec pauzy…) se nepočítají jako zánik">
              <LineChart
                ariaLabel="Křivky přežití podle režimu"
                height={240}
                yMin={0}
                yMax={1}
                xMin={0}
                series={(Object.entries(data.kmByMode) as [Mode, KM | null][])
                  .filter(([, v]) => v)
                  .map(([m, v]) => ({ key: m, label: `${m} (n=${v!.summary.n})`, color: modeColor(m), step: true, points: v!.curve.map((p) => ({ x: p.t / 1000, y: p.s })) }))}
                xFormat={(x) => `${Math.round(x)} s`}
                yFormat={(y) => `${Math.round(y * 100)} %`}
              />
              <KmTable rows={Object.entries(data.kmByMode) as [string, KM | null][]} />
            </Card>
            <Card title="Rozdělení životnosti" sub="počet arbů podle doby trvání">
              <StackedColumns
                ariaLabel="Histogram životnosti arbů"
                bins={data.histogram.map((h) => ({ label: h.hi === null ? `${h.lo}+ s` : `<${h.hi} s`, values: { ended: h.ended, censored: h.censored } }))}
                series={[
                  { key: 'ended', label: 'zanikl', color: 'var(--s1)' },
                  { key: 'censored', label: 'cenzurováno', color: 'var(--s2)' },
                ]}
              />
            </Card>
            <Card title="Kaplan–Meier podle sportu">
              <LineChart
                ariaLabel="Křivky přežití podle sportu"
                height={220}
                yMin={0}
                yMax={1}
                xMin={0}
                series={(Object.entries(data.kmBySport) as [Sport, KM | null][])
                  .filter(([, v]) => v)
                  .map(([s, v]) => ({ key: s, label: SPORT_LABEL[s], color: SPORT_COLORS[s], step: true, points: v!.curve.map((p) => ({ x: p.t / 1000, y: p.s })) }))}
                xFormat={(x) => `${Math.round(x)} s`}
                yFormat={(y) => `${Math.round(y * 100)} %`}
              />
            </Card>
            <Card title="Důvody zániku">
              <HBars rows={data.endReasons.map((r) => ({ label: endReasonLabel(r.key), value: r.n }))} />
            </Card>
            <Card title="Podle sportu">
              <HBars rows={grp(data.bySport, (k) => SPORT_LABEL[k as Sport] ?? String(k))} />
            </Card>
            <Card title="Podle režimu">
              <HBars rows={grp(data.byMode)} />
            </Card>
            <Card title="Podle typu trhu">
              <HBars rows={grp(data.byMarket)} />
            </Card>
            <Card title="Podle páru sázkovek">
              <HBars rows={grp(data.byPair, (k) => String(k).split('|').map(bkName).join(' + '))} />
            </Card>
            <Card title="Podle hodiny (Praha)">
              <HBars rows={[...data.byHour].sort((a, b) => Number(a.key) - Number(b.key)).map((x) => ({ label: `${x.key}:00`, value: x.n }))} />
            </Card>
            <Card title="Reálná úspěšnost a slippage" sub="z tlačítek v detailu arbu">
              <HBars rows={data.actions.byAction.map((a) => ({ label: ACTION_LABEL[a.key] ?? a.key, value: a.n, extra: `reakce Ø ${formatDuration(a.avg_reaction_ms)}` }))} />
              <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
                <div>
                  <div className="mb-1 text-muted">Slippage (skutečný vs. detekovaný kurz)</div>
                  {data.actions.slippage.map((s) => (
                    <div key={s.bookmaker} className="flex justify-between">
                      <span>{bkName(s.bookmaker)}</span>
                      <span className="num">
                        {s.avg_slippage_pct.toFixed(2)} % (n={s.n})
                      </span>
                    </div>
                  ))}
                  {!data.actions.slippage.length && <div className="text-muted">bez dat</div>}
                </div>
                <div>
                  <div className="mb-1 text-muted">Odmítnutí podle sázkovky</div>
                  {data.actions.rejections.map((s) => (
                    <div key={s.key} className="flex justify-between">
                      <span>{bkName(s.key)}</span>
                      <span className="num">{s.n}</span>
                    </div>
                  ))}
                  {!data.actions.rejections.length && <div className="text-muted">bez dat</div>}
                </div>
              </div>
            </Card>
            <Card title="Zisk v čase" sub="kumulativně: vsazené arby × marže při kliknutí">
              <LineChart
                ariaLabel="Kumulativní zisk v čase"
                height={200}
                series={[{ key: 'p', label: 'zisk', color: 'var(--good)', points: data.profit.map((p) => ({ x: new Date(p.day).getTime(), y: p.cumulative })) }]}
                xFormat={(x) => new Date(x).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric' })}
                yFormat={(y) => formatKc(y)}
              />
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="card px-3 py-2.5">
      <div className="text-xs text-muted">{label}</div>
      <div className="text-xl font-semibold">{value}</div>
    </div>
  );
}

function Card({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section className="card p-4">
      <h2 className="font-medium">{title}</h2>
      {sub && <div className="mb-2 text-xs text-muted">{sub}</div>}
      <div className={sub ? '' : 'mt-2'}>{children}</div>
    </section>
  );
}

function KmTable({ rows }: { rows: [string, KM | null][] }) {
  return (
    <table className="data mt-2 w-full text-xs">
      <thead>
        <tr>
          <th>Režim</th>
          <th className="text-right">n / zaniklo</th>
          <th className="text-right">Medián</th>
          <th className="text-right">P25–P75</th>
          <th className="text-right">P(&gt;5 s)</th>
          <th className="text-right">P(&gt;10 s)</th>
          <th className="text-right">P(&gt;30 s)</th>
          <th className="text-right">P(&gt;60 s)</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k}>
            <td>{k}</td>
            {v ? (
              <>
                <td className="text-right num">
                  {v.summary.n} / {v.summary.nEvents}
                </td>
                <td className="text-right num">{formatDuration(v.summary.medianMs)}</td>
                <td className="text-right num">
                  {formatDuration(v.summary.p25Ms)} – {formatDuration(v.summary.p75Ms)}
                </td>
                {['5', '10', '30', '60'].map((t) => (
                  <td key={t} className="text-right num">
                    {Math.round(v.summary.pOver[t] * 100)} %
                  </td>
                ))}
              </>
            ) : (
              <td colSpan={7} className="text-muted">
                málo dat
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
