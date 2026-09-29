'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, formatDateTime, SPORT_LABEL } from '@/lib/format';
import { pushToast, useLive } from '@/lib/live';
import { BookmakerChip } from '@/components/Badges';
import type { Sport } from '@core/types';

interface Row {
  id: number;
  bookmaker: string;
  source_event_id: string;
  sport: Sport;
  competition: string | null;
  raw_home: string;
  raw_away: string;
  start_time: string;
  candidate_event_id: number | null;
  candidate_label: string | null;
  candidate_start: string | null;
  score: number | null;
  swapped: boolean;
  reasons: { home?: number; away?: number; deltaMin?: number } | null;
  status: string;
}

interface Cand {
  id: number;
  home: string;
  away: string;
  start_time: string;
  competition: string | null;
  books: string[] | null;
}

export default function UnmatchedPage() {
  const [status, setStatus] = useState<'pending' | 'confirmed' | 'rejected'>('pending');
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const pending = useLive((s) => s.unmatched);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await api<Row[]>(`/unmatched?status=${status}`));
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load, pending]);

  const act = async (r: Row, action: 'confirm' | 'reject', body?: Record<string, unknown>) => {
    try {
      await api(`/unmatched/${r.id}/${action}`, { method: 'POST', body: JSON.stringify(body ?? {}) });
      setRows((x) => x.filter((y) => y.id !== r.id));
      pushToast(action === 'confirm' ? `Spárováno a uloženo jako alias: ${r.raw_home} – ${r.raw_away}` : 'Zamítnuto – vznikne samostatná událost', 'good');
    } catch (e) {
      pushToast(`Chyba: ${(e as Error).message}`, 'bad');
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h1 className="text-lg font-semibold">Nepárované zápasy</h1>
        <span className="text-sm text-muted">Nejisté páry se do arbů nepoužívají, dokud je nepotvrdíš. Potvrzení se uloží jako alias.</span>
        <div className="ml-auto flex gap-1">
          {(['pending', 'confirmed', 'rejected'] as const).map((s) => (
            <button key={s} className={`btn ${status === s ? 'bg-surface-3' : ''}`} onClick={() => setStatus(s)}>
              {s === 'pending' ? `Čeká (${pending})` : s === 'confirmed' ? 'Potvrzené' : 'Zamítnuté'}
            </button>
          ))}
        </div>
      </div>
      <div className="card overflow-x-auto">
        <table className="data w-full text-sm">
          <thead>
            <tr>
              <th>Sázkovka</th>
              <th>Sport</th>
              <th>Zápas u sázkovky</th>
              <th>Kandidát (kanonická událost)</th>
              <th className="text-right">Shoda</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <UnmatchedRow key={r.id} r={r} status={status} onAct={act} />
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={6} className="py-8 text-center text-muted">
                  {loading ? 'Načítám…' : 'Nic ke kontrole.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function UnmatchedRow({ r, status, onAct }: { r: Row; status: string; onAct: (r: Row, a: 'confirm' | 'reject', b?: Record<string, unknown>) => Promise<void> }) {
  const [swapped, setSwapped] = useState(r.swapped);
  const [cands, setCands] = useState<Cand[] | null>(null);
  const [choice, setChoice] = useState<number | null>(null);
  const delta = r.reasons?.deltaMin;
  return (
    <>
      <tr>
        <td>
          <BookmakerChip bk={r.bookmaker} />
        </td>
        <td className="text-ink-2">{SPORT_LABEL[r.sport]}</td>
        <td>
          <div className="font-medium">
            {r.raw_home} – {r.raw_away}
          </div>
          <div className="text-xs text-muted">
            {r.competition} · {formatDateTime(new Date(r.start_time).getTime())}
          </div>
        </td>
        <td>
          <div className="font-medium">{r.candidate_label ?? '–'}</div>
          <div className="text-xs text-muted">
            {r.candidate_start && formatDateTime(new Date(r.candidate_start).getTime())}
            {delta !== undefined && delta !== 0 && ` · posun ${delta > 0 ? '+' : ''}${delta} min`}
            {r.swapped && ' · prohozené pořadí'}
          </div>
        </td>
        <td className="text-right num">
          {r.score !== null ? `${(r.score * 100).toFixed(0)} %` : '–'}
          {r.reasons && (
            <div className="text-xs text-muted">
              {((r.reasons.home ?? 0) * 100).toFixed(0)} / {((r.reasons.away ?? 0) * 100).toFixed(0)}
            </div>
          )}
        </td>
        <td className="whitespace-nowrap text-right">
          {status === 'pending' && (
            <div className="flex items-center justify-end gap-2">
              <label className="flex items-center gap-1 text-xs text-ink-2" title="Sázkovka uvádí týmy v opačném pořadí">
                <input type="checkbox" checked={swapped} onChange={(e) => setSwapped(e.target.checked)} />
                prohozeno
              </label>
              <button className="btn btn-primary" disabled={!r.candidate_event_id} onClick={() => void onAct(r, 'confirm', { swapped })}>
                Potvrdit
              </button>
              <button className="btn" onClick={() => void onAct(r, 'reject')}>
                Zamítnout
              </button>
              <button
                className="btn"
                onClick={async () => setCands(cands ? null : await api<Cand[]>(`/unmatched/${r.id}/candidates`))}
                title="Vybrat jinou kanonickou událost"
              >
                Jiná…
              </button>
            </div>
          )}
        </td>
      </tr>
      {cands && (
        <tr>
          <td colSpan={6} className="bg-surface-2">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <select className="input min-w-[420px]" value={choice ?? ''} onChange={(e) => setChoice(Number(e.target.value))}>
                <option value="">— vyber událost —</option>
                {cands.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.home} – {c.away} · {formatDateTime(new Date(c.start_time).getTime())} · {c.competition ?? ''} ({(c.books ?? []).length} sázkovek)
                  </option>
                ))}
              </select>
              <button className="btn btn-primary" disabled={!choice} onClick={() => void onAct(r, 'confirm', { eventId: choice, swapped })}>
                Spárovat s vybranou
              </button>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
