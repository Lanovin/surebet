'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { BookmakerId } from '@core/types';
import { computeStakes } from '@core/arb';
import { useLive, pushToast } from '@/lib/live';
import { api, bkName, clockLabel, describeLeg, endReasonLabel, formatDuration, formatTime, formatCountdown, PAUSE_LABEL, SPORT_LABEL } from '@/lib/format';
import { ModeBadge, modeColor } from './Badges';
import { LineChart } from './LineChart';
import { StakeCalculator, type CalcLeg } from './StakeCalculator';
import { Icon } from './Icon';
import { useNow } from './useNow';

type ActionKind = 'placed' | 'missed' | 'rejected' | 'odds_changed';

export function ArbDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const a = useLive((s) => s.arbs.get(id));
  const settings = useLive((s) => s.settings);
  const now = useNow(250);
  const clockOffset = useLive((s) => s.clockOffset);
  const [history, setHistory] = useState<{ ts: number; margin: number }[]>([]);
  const [form, setForm] = useState<ActionKind | null>(null);
  const [lastA, setLastA] = useState(a);

  useEffect(() => {
    if (a) setLastA(a);
  }, [a]);
  const arb = a ?? lastA;

  useEffect(() => {
    setHistory([]);
    setForm(null);
    void api<{ ticks: { ts: number; margin: number }[] }>(`/arbs/${id}`)
      .then((r) => setHistory(r.ticks))
      .catch(() => {});
  }, [id]);

  const bankroll = settings?.bankroll ?? 10000;
  const unit = settings?.roundingUnit ?? 1;
  const odds = arb?.legs.map((l) => l.effOdds) ?? [];
  // výchozí plán pro formulář „Vsadil“ (kalkulačka si drží vlastní úpravy)
  const plan = useMemo(
    () => (odds.length ? computeStakes(odds, bankroll, unit) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [odds.join(','), bankroll, unit],
  );

  if (!arb) return null;
  const serverNow = now + clockOffset;
  const calcLegs: CalcLeg[] = arb.legs.map((l) => {
    const d = describeLeg(arb, l.selection, l.swapped);
    return {
      key: l.selection,
      title: d.title,
      hint: d.atBook,
      bookmaker: l.bookmaker,
      url: l.url,
      odds: l.effOdds,
      shownOdds: l.odds,
      confirmedAgoMs: arb.status === 'ended' ? null : Math.max(0, serverNow - l.seenAt),
    };
  });
  const calcHref = `/kalkulacka?${new URLSearchParams({
    o: arb.legs.map((l) => l.odds).join(','),
    b: arb.legs.map((l) => l.bookmaker).join(','),
    l: calcLegs.map((l) => l.title).join('|'),
    t: String(bankroll),
  })}`;
  const ticks = mergeTicks(history, arb.ticks);
  const st = arb.state;
  const ended = arb.status === 'ended';
  const age = (ended ? (arb.endedAt ?? now) : now) - arb.firstSeen;
  const threshold = settings?.modes[arb.mode].minMarginPct;

  return (
    <aside className="card fixed bottom-4 right-4 top-16 z-20 flex w-[560px] max-w-[95vw] flex-col overflow-hidden shadow-2xl">
      <div className="flex items-start gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <ModeBadge mode={arb.mode} />
            <span className="text-xs text-muted">
              {SPORT_LABEL[arb.sport]} · {arb.competition}
            </span>
            {arb.isSim && <span className="rounded bg-surface-3 px-1 text-[10px] text-ink-2">SIM</span>}
          </div>
          <h2 className="mt-1 text-lg font-semibold leading-snug break-words">{arb.eventName}</h2>
          <div className="text-ink-2">{arb.marketLabel}</div>
        </div>
        <div className="text-right">
          <div className="num text-2xl font-semibold" title="Marže arbu = jistý výnos z celkového vkladu">
            {arb.margin.toFixed(2)} %
          </div>
          <div className="text-xs text-muted num">
            max {arb.maxMargin.toFixed(2)} · při detekci {arb.marginAtDetection.toFixed(2)}
          </div>
          <div className="text-xs text-muted num">stáří {formatDuration(age)}</div>
        </div>
        <button className="btn px-2" onClick={onClose} aria-label="Zavřít">
          ✕
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3">
        {ended && (
          <div className="rounded-md bg-surface-2 px-3 py-2 text-sm">
            Arb zanikl: <b>{endReasonLabel(arb.endReason)}</b> po {formatDuration((arb.endedAt ?? now) - arb.firstSeen)}
          </div>
        )}

        {/* herní stav */}
        <section className="grid grid-cols-3 gap-2 text-sm">
          {arb.mode !== 'PREMATCH' && (
            <>
              <Stat label="Skóre" value={st?.score ? `${st.score[0]} : ${st.score[1]}` : '–'} />
              <Stat label="Perioda" value={st?.period ? `${st.period}.${st.statusText ? ` (${st.statusText})` : ''}` : (st?.statusText ?? '–')} />
              <Stat
                label={arb.sport === 'tennis' ? 'Gemy' : 'Čas'}
                value={arb.sport === 'tennis' ? (st?.games ? `${st.games[0]}:${st.games[1]} ${st.points ?? ''}` : '–') : (clockLabel(st) ?? '–')}
              />
            </>
          )}
          {arb.mode === 'PAUSED' && arb.pause && (
            <div className="col-span-3 rounded-md px-3 py-2" style={{ background: 'var(--surface-2)', borderLeft: `3px solid ${modeColor('PAUSED')}` }}>
              Přestávka: <b>{PAUSE_LABEL[arb.pause.type] ?? arb.pause.type}</b> · uplynulo {formatDuration(now - arb.pause.startedAt)} z ~
              {formatDuration(arb.pause.expectedSec * 1000)} · zbývá{' '}
              <b className="num">{formatDuration(Math.max(0, arb.pause.expectedSec * 1000 - (now - arb.pause.startedAt)))}</b>
              <span className="text-muted"> ({arb.pause.source === 'feed' ? 'z feedu' : 'odhad z hodin'})</span>
              {arb.risky && <div style={{ color: 'var(--warning)' }}>⚠ Riziko: predikovaná životnost arbu přesahuje zbývající čas přestávky.</div>}
            </div>
          )}
          {arb.mode === 'PREMATCH' && (
            <div className="col-span-3 text-ink-2">
              Výkop {new Date(arb.startTime).toLocaleString('cs-CZ')} · za {formatCountdown(Math.round((arb.startTime - now) / 1000))}
            </div>
          )}
        </section>

        {/* kalkulačka vkladů */}
        <section>
          <div className="mb-2 flex items-center gap-2">
            <h3 className="text-sm font-medium">Kde, na co a kolik vsadit</h3>
            <Link href={calcHref} className="ml-auto inline-flex items-center gap-1 text-xs text-accent hover:underline" title="Otevřít kurzy v samostatné kalkulačce">
              <Icon name="calc" size={13} /> otevřít v kalkulačce
            </Link>
          </div>
          <StakeCalculator legs={calcLegs} total={bankroll} unit={unit} />
        </section>

        {/* vývoj marže */}
        <section>
          <h3 className="mb-1 text-sm font-medium text-ink-2">Vývoj marže</h3>
          <LineChart
            ariaLabel="Vývoj marže arbu v čase"
            height={170}
            series={[{ key: 'm', label: 'marže', color: modeColor(arb.mode), points: [...ticks.map((t) => ({ x: t.ts, y: t.margin })), ...(ended ? [] : [{ x: now, y: arb.margin }])], step: true }]}
            xFormat={(x) => formatTime(x)}
            yFormat={(y) => `${y.toFixed(2)} %`}
            refY={threshold !== undefined ? { y: threshold, label: `práh ${threshold} %` } : undefined}
          />
        </section>

        {/* predikce */}
        <section className="text-sm">
          <h3 className="mb-1 font-medium text-ink-2">Predikce životnosti</h3>
          {arb.prediction ? (
            <div className="grid grid-cols-4 gap-2">
              <Stat label="Medián" value={formatDuration(arb.prediction.medianMs)} />
              <Stat label="P25–P75" value={`${formatDuration(arb.prediction.p25Ms)} – ${formatDuration(arb.prediction.p75Ms)}`} />
              <Stat label={`P(> ${formatDuration(arb.prediction.neededMs)})`} value={arb.prediction.pNeeded === null ? '–' : `${(arb.prediction.pNeeded * 100).toFixed(0)} %`} />
              <Stat label="Vzorků" value={`${arb.prediction.n} (${arb.prediction.source === 'model' ? 'model' : 'KM'})`} />
              {([5, 10, 30, 60] as const).map((t) => (
                <Stat key={t} label={`P(> ${t} s)`} value={`${(arb.prediction!.pOver[t] * 100).toFixed(0)} %`} />
              ))}
              <div className="col-span-4 text-xs text-muted">
                segment {arb.prediction.segment} · potřebná doba = reakce + max. zpoždění přijetí sázkovek
                {arb.muted && ' · ztlumeno (nízká šance, že arb vydrží)'}
              </div>
            </div>
          ) : (
            <div className="text-muted">Zatím málo ukončených arbů pro predikci.</div>
          )}
        </section>
      </div>

      {/* akce */}
      <div className="border-t border-line px-4 py-3">
        {form ? (
          <ActionForm arbId={arb.id} kind={form} legs={arb.legs.map((l) => l.bookmaker)} total={plan?.total ?? 0} shownAt={arb.addedAt} margin={arb.margin} onDone={() => setForm(null)} />
        ) : (
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-primary" onClick={() => setForm('placed')}>
              ✓ Vsadil
            </button>
            <button className="btn" onClick={() => void sendAction(arb.id, { action: 'missed', shownAt: arb.addedAt, marginAtClick: arb.margin })}>
              Nestihl
            </button>
            <button className="btn" onClick={() => setForm('rejected')}>
              Odmítnuto…
            </button>
            <button className="btn" onClick={() => setForm('odds_changed')}>
              Změna kurzu…
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-surface-2 px-2.5 py-1.5">
      <div className="text-[11px] text-muted">{label}</div>
      <div className="num font-semibold">{value}</div>
    </div>
  );
}

function mergeTicks(a: { ts: number; margin: number }[], b: { ts: number; margin: number }[]) {
  const m = new Map<number, number>();
  for (const t of [...a, ...b]) m.set(t.ts, t.margin);
  return [...m.entries()].sort((x, y) => x[0] - y[0]).map(([ts, margin]) => ({ ts, margin }));
}

async function sendAction(arbId: string, body: Record<string, unknown>) {
  try {
    await api('/actions', { method: 'POST', body: JSON.stringify({ arbId, ...body }) });
    pushToast('Akce uložena', 'good');
  } catch (e) {
    pushToast(`Uložení selhalo: ${(e as Error).message}`, 'bad');
  }
}

function ActionForm({
  arbId,
  kind,
  legs,
  total,
  shownAt,
  margin,
  onDone,
}: {
  arbId: string;
  kind: ActionKind;
  legs: BookmakerId[];
  total: number;
  shownAt: number;
  margin: number;
  onDone: () => void;
}) {
  const [stake, setStake] = useState(total);
  const [bk, setBk] = useState<BookmakerId>(legs[0]);
  const [odds, setOdds] = useState<string>('');
  const [acc, setAcc] = useState<string>('');
  const [note, setNote] = useState('');
  const submit = async () => {
    const body: Record<string, unknown> = { action: kind, shownAt, marginAtClick: margin, note: note || undefined };
    if (kind === 'placed') {
      body.stake = stake;
      if (acc) body.acceptanceMs = Math.round(Number(acc) * 1000);
      if (odds) {
        body.actualOdds = Number(odds);
        body.bookmaker = bk;
      }
    } else {
      body.bookmaker = bk;
      if (kind === 'odds_changed' && odds) body.actualOdds = Number(odds);
    }
    await sendAction(arbId, body);
    onDone();
  };
  return (
    <div className="flex flex-wrap items-end gap-2 text-sm">
      {kind === 'placed' && (
        <label className="flex flex-col gap-0.5">
          <span className="text-xs text-muted">Skutečný vklad celkem</span>
          <input className="input w-28" type="number" value={stake} onChange={(e) => setStake(Number(e.target.value))} />
        </label>
      )}
      <label className="flex flex-col gap-0.5">
        <span className="text-xs text-muted">{kind === 'rejected' ? 'Odmítla sázkovka' : 'Sázkovka'}</span>
        <select className="input" value={bk} onChange={(e) => setBk(e.target.value as BookmakerId)}>
          {legs.map((b) => (
            <option key={b} value={b}>
              {bkName(b)}
            </option>
          ))}
        </select>
      </label>
      {(kind === 'placed' || kind === 'odds_changed') && (
        <label className="flex flex-col gap-0.5">
          <span className="text-xs text-muted">{kind === 'placed' ? 'Skutečný kurz (volit.)' : 'Nový kurz'}</span>
          <input className="input w-20" type="number" step={0.01} value={odds} onChange={(e) => setOdds(e.target.value)} />
        </label>
      )}
      {kind === 'placed' && (
        <label className="flex flex-col gap-0.5">
          <span className="text-xs text-muted">Přijetí trvalo (s)</span>
          <input className="input w-20" type="number" step={0.5} value={acc} onChange={(e) => setAcc(e.target.value)} />
        </label>
      )}
      <label className="flex flex-1 flex-col gap-0.5">
        <span className="text-xs text-muted">Poznámka</span>
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <button className="btn btn-primary" onClick={() => void submit()}>
        Uložit
      </button>
      <button className="btn" onClick={onDone}>
        Zpět
      </button>
    </div>
  );
}
