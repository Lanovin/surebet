'use client';
// Detail arbu na celé stránce (/arb/[id], otevírá se v nové záložce): kde, na co a kolik vsadit,
// kalkulačka, uložení sázky do přehledu, herní stav, vývoj marže a predikce.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { BookmakerId } from '@core/types';
import type { ArbDTO } from '@shared/protocol';
import { useLive, pushToast, type ArbRow } from '@/lib/live';
import { api, bkName, clockLabel, describeLeg, endReasonLabel, formatDuration, formatKc2, formatTime, formatCountdown, marketKind, PAUSE_LABEL, SPORT_LABEL } from '@/lib/format';
import { BookmakerName, ModeBadge, modeColor } from './Badges';
import { LineChart } from './LineChart';
import { StakeCalculator, type CalcLeg, type CalcPlan } from './StakeCalculator';
import { Icon } from './Icon';
import { useNow } from './useNow';

type ActionKind = 'placed' | 'missed' | 'rejected' | 'odds_changed';

export function ArbDetail({ id }: { id: string }) {
  const live = useLive((s) => s.arbs.get(id));
  const ready = useLive((s) => s.ready);
  const settings = useLive((s) => s.settings);
  const now = useNow(250);
  const clockOffset = useLive((s) => s.clockOffset);
  const [history, setHistory] = useState<{ ts: number; margin: number }[]>([]);
  const [form, setForm] = useState<ActionKind | null>(null);
  const [lastA, setLastA] = useState<ArbRow | undefined>(live);
  const [fromApi, setFromApi] = useState<ArbRow | null>(null);
  const [gone, setGone] = useState<string | null>(null);
  const [plan, setPlan] = useState<CalcPlan | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (live) setLastA(live);
  }, [live]);

  useEffect(() => {
    setHistory([]);
    setForm(null);
    void api<{ arb: { event_name: string; end_reason: string | null }; active: ArbDTO | null; ticks: { ts: number; margin: number }[] }>(`/arbs/${id}`)
      .then((r) => {
        setHistory(r.ticks);
        if (r.active) setFromApi({ ...r.active, status: 'active', addedAt: Date.now(), marginDir: null, marginDirAt: 0, ticks: [] });
        else setGone(`${r.arb.event_name} – ${endReasonLabel(r.arb.end_reason ?? undefined)}`);
      })
      .catch(() => setGone('arb nenalezen'));
  }, [id]);

  const arb = live ?? lastA ?? fromApi ?? undefined;

  useEffect(() => {
    if (arb) document.title = `${arb.margin.toFixed(2)} % · ${arb.eventName}${arb.status === 'ended' ? ' (zanikl)' : ''}`;
  }, [arb?.margin, arb?.eventName, arb?.status]);

  if (!arb) {
    return (
      <div className="card mx-auto mt-10 max-w-xl p-6 text-center">
        {!ready && !gone ? (
          <div className="text-muted">Načítám arb…</div>
        ) : (
          <>
            <div className="text-lg font-semibold">Arb už není aktivní</div>
            {gone && <div className="mt-1 text-ink-2">{gone}</div>}
            <Link href="/" className="btn mt-4">
              Zpět na přehled arbů
            </Link>
          </>
        )}
      </div>
    );
  }

  const bankroll = settings?.bankroll ?? 10000;
  const unit = settings?.roundingUnit ?? 1;
  const serverNow = now + clockOffset;
  const calcLegs: CalcLeg[] = arb.legs.map((l) => {
    const d = describeLeg(l.market ?? arb.market, l.marketSelection ?? l.selection, arb, l.swapped);
    const other = l.market && l.market !== arb.market ? l.marketLabel : undefined;
    return {
      key: l.selection,
      title: d.title,
      sub: other ? `sází se na trh „${other}“` : undefined,
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
    e: arb.eventName,
  })}`;
  const ticks = mergeTicks(history, arb.ticks);
  const st = arb.state;
  const ended = arb.status === 'ended';
  const age = (ended ? (arb.endedAt ?? now) : now) - arb.firstSeen;
  const threshold = settings?.modes[arb.mode].minMarginPct;
  const mk = marketKind(arb.market, arb.sport);

  return (
    <div className="space-y-4">
      {/* hlavička: zápas, na co se sází, marže */}
      <header className="card flex flex-wrap items-start gap-4 px-5 py-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <ModeBadge mode={arb.mode} />
            <span className="text-sm text-muted">
              {SPORT_LABEL[arb.sport]} · {arb.competition}
            </span>
            {arb.isSim && <span className="rounded bg-surface-3 px-1.5 text-[11px] text-ink-2">TESTOVACÍ DATA</span>}
          </div>
          <h1 className="mt-1 text-2xl font-bold leading-snug break-words">{arb.eventName}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="market-tag text-lg">{mk.kind}</span>
            {mk.scope && <span className="market-tag text-lg">{mk.scope}</span>}
            {mk.detail && <span className="text-ink-2">{mk.detail}</span>}
          </div>
        </div>
        <div className="text-right">
          <div className="num text-4xl font-bold" style={{ color: ended ? 'var(--muted)' : 'var(--good-text)' }} title="Marže arbu = jistý výnos z celkového vkladu">
            {arb.margin.toFixed(2)} %
          </div>
          <div className="text-xs text-muted num">
            max {arb.maxMargin.toFixed(2)} · při detekci {arb.marginAtDetection.toFixed(2)} · stáří {formatDuration(age)}
          </div>
        </div>
      </header>

      {ended && (
        <div className="card flex items-center gap-2 px-4 py-3" style={{ borderLeft: '4px solid var(--critical)' }}>
          <Icon name="stop" size={16} />
          Arb zanikl: <b>{endReasonLabel(arb.endReason)}</b> po {formatDuration((arb.endedAt ?? now) - arb.firstSeen)} – kurzy níže už nemusí platit.
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        {/* kde, na co a kolik vsadit */}
        <section className="card space-y-4 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">Kde, na co a kolik vsadit</h2>
            <span className="text-sm text-muted">
              {arb.legs.map((l) => bkName(l.bookmaker)).join(' + ')}
            </span>
            <Link href={calcHref} target="_blank" className="ml-auto inline-flex items-center gap-1 text-sm text-accent hover:underline" title="Otevřít kurzy v samostatné kalkulačce (nová záložka)">
              <Icon name="calc" size={14} /> samostatná kalkulačka
            </Link>
          </div>
          <StakeCalculator legs={calcLegs} total={bankroll} unit={unit} onPlan={setPlan} />

          <div className="border-t border-line pt-3">
            {form ? (
              <ActionForm
                arb={arb}
                kind={form}
                legs={calcLegs}
                plan={plan}
                onDone={(ok) => {
                  setForm(null);
                  if (ok && form === 'placed') setSaved(true);
                }}
              />
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <button className="btn btn-primary px-4 py-2 text-base" onClick={() => setForm('placed')}>
                  <Icon name="check" /> Vsadil jsem – uložit sázku
                </button>
                <button className="btn" onClick={() => void sendAction({ arbId: arb.id, action: 'missed', shownAt: arb.addedAt, marginAtClick: arb.margin })}>
                  Nestihl
                </button>
                <button className="btn" onClick={() => setForm('rejected')}>
                  Odmítnuto…
                </button>
                <button className="btn" onClick={() => setForm('odds_changed')}>
                  Změna kurzu…
                </button>
                {saved && (
                  <Link href="/sazky" target="_blank" className="ml-auto inline-flex items-center gap-1 text-sm text-accent hover:underline">
                    <Icon name="wallet" size={14} /> uloženo – Přehled sázek
                  </Link>
                )}
              </div>
            )}
          </div>
        </section>

        <div className="space-y-4">
          {/* herní stav */}
          <section className="card space-y-2 p-4 text-sm">
            <h3 className="font-semibold text-ink-2">Zápas</h3>
            {arb.mode !== 'PREMATCH' && (
              <div className="grid grid-cols-3 gap-2">
                <Stat label="Skóre" value={st?.score ? `${st.score[0]} : ${st.score[1]}` : '–'} />
                <Stat label="Perioda" value={st?.period ? `${st.period}.${st.statusText ? ` (${st.statusText})` : ''}` : (st?.statusText ?? '–')} />
                <Stat
                  label={arb.sport === 'tennis' ? 'Gemy' : 'Čas'}
                  value={arb.sport === 'tennis' ? (st?.games ? `${st.games[0]}:${st.games[1]} ${st.points ?? ''}` : '–') : (clockLabel(st) ?? '–')}
                />
              </div>
            )}
            {arb.mode === 'PAUSED' && arb.pause && (
              <div className="rounded-md px-3 py-2" style={{ background: 'var(--surface-2)', borderLeft: `3px solid ${modeColor('PAUSED')}` }}>
                Přestávka: <b>{PAUSE_LABEL[arb.pause.type] ?? arb.pause.type}</b> · uplynulo {formatDuration(now - arb.pause.startedAt)} z ~
                {formatDuration(arb.pause.expectedSec * 1000)} · zbývá{' '}
                <b className="num">{formatDuration(Math.max(0, arb.pause.expectedSec * 1000 - (now - arb.pause.startedAt)))}</b>
                <span className="text-muted"> ({arb.pause.source === 'feed' ? 'z feedu' : 'odhad z hodin'})</span>
                {arb.risky && (
                  <div className="mt-1 flex items-center gap-1" style={{ color: 'var(--warning)' }}>
                    <Icon name="warn" size={14} /> Riziko: predikovaná životnost arbu přesahuje zbývající čas přestávky.
                  </div>
                )}
              </div>
            )}
            {arb.mode === 'PREMATCH' && (
              <div className="text-ink-2">
                Výkop {new Date(arb.startTime).toLocaleString('cs-CZ')} · za {formatCountdown(Math.round((arb.startTime - now) / 1000))}
              </div>
            )}
          </section>

          {/* vývoj marže */}
          <section className="card p-4">
            <h3 className="mb-1 text-sm font-semibold text-ink-2">Vývoj marže</h3>
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
          <section className="card p-4 text-sm">
            <h3 className="mb-1 font-semibold text-ink-2">Predikce životnosti</h3>
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
      </div>
    </div>
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

async function sendAction(body: Record<string, unknown>): Promise<boolean> {
  try {
    await api('/actions', { method: 'POST', body: JSON.stringify(body) });
    pushToast(body.action === 'placed' ? 'Sázka uložena do Přehledu sázek' : 'Akce uložena', 'good');
    return true;
  } catch (e) {
    pushToast(`Uložení selhalo: ${(e as Error).message}`, 'bad');
    return false;
  }
}

interface LegInput {
  stake: string;
  odds: string;
}

function ActionForm({ arb, kind, legs, plan, onDone }: { arb: ArbRow; kind: ActionKind; legs: CalcLeg[]; plan: CalcPlan | null; onDone: (ok: boolean) => void }) {
  const books = arb.legs.map((l) => l.bookmaker);
  const [bk, setBk] = useState<BookmakerId>(books[0]);
  const [inputs, setInputs] = useState<LegInput[]>(() => legs.map((l, i) => ({ stake: String(plan?.stakes[i] ?? 0), odds: String(l.shownOdds ?? l.odds) })));
  const [odds, setOdds] = useState<string>('');
  const [acc, setAcc] = useState<string>('');
  const [note, setNote] = useState('');
  const num = (s: string) => Number(s.replace(',', '.'));
  const total = inputs.reduce((s, x) => s + (num(x.stake) || 0), 0);
  const profits = inputs.map((x) => (num(x.stake) || 0) * (num(x.odds) || 0) - total);
  const upd = (i: number, p: Partial<LegInput>) => setInputs((xs) => xs.map((x, j) => (j === i ? { ...x, ...p } : x)));

  const submit = async () => {
    const body: Record<string, unknown> = { arbId: arb.id, action: kind, shownAt: arb.addedAt, marginAtClick: arb.margin, note: note || undefined };
    if (kind === 'placed') {
      body.stake = total;
      body.legs = arb.legs.map((l, i) => ({ bookmaker: l.bookmaker, title: legs[i]?.title, stake: num(inputs[i].stake) || 0, actualOdds: num(inputs[i].odds) || undefined }));
      body.eventName = arb.eventName;
      body.marketKey = arb.market;
      body.sport = arb.sport;
      if (acc) body.acceptanceMs = Math.round(Number(acc) * 1000);
    } else {
      body.bookmaker = bk;
      if (kind === 'odds_changed' && odds) body.actualOdds = Number(odds);
    }
    onDone(await sendAction(body));
  };

  if (kind === 'placed')
    return (
      <div className="space-y-3">
        <div className="text-sm text-ink-2">Zkontroluj, kolik a za jaký kurz jsi skutečně vsadil (předvyplněno z kalkulačky):</div>
        <div className="space-y-2">
          {legs.map((l, i) => (
            <div key={l.key} className="flex flex-wrap items-center gap-2 rounded-md bg-surface-2 px-3 py-2">
              {l.bookmaker && <BookmakerName bk={l.bookmaker} />}
              <span className="min-w-0 flex-1 font-medium">{l.title}</span>
              <label className="flex items-center gap-1 text-sm text-muted">
                vklad
                <input className="input w-24 text-right" inputMode="decimal" value={inputs[i].stake} onChange={(e) => upd(i, { stake: e.target.value })} />
                Kč
              </label>
              <label className="flex items-center gap-1 text-sm text-muted">
                kurz
                <input className="input w-20 text-right" inputMode="decimal" value={inputs[i].odds} onChange={(e) => upd(i, { odds: e.target.value })} />
              </label>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <div>
            <div className="text-xs text-muted">Vsazeno celkem</div>
            <div className="num text-lg font-bold">{formatKc2(total)}</div>
          </div>
          <div>
            <div className="text-xs text-muted">Jistý zisk</div>
            <div className="num text-lg font-bold" style={{ color: Math.min(...profits) >= 0 ? 'var(--good-text)' : 'var(--critical)' }}>
              {Math.min(...profits) > 0 ? '+' : ''}
              {formatKc2(Math.min(...profits))}
            </div>
          </div>
          <label className="flex flex-col gap-0.5">
            <span className="text-xs text-muted">Přijetí trvalo (s)</span>
            <input className="input w-20" type="number" step={0.5} value={acc} onChange={(e) => setAcc(e.target.value)} />
          </label>
          <label className="flex min-w-40 flex-1 flex-col gap-0.5">
            <span className="text-xs text-muted">Poznámka</span>
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <button className="btn btn-primary px-4 py-2" disabled={total <= 0} onClick={() => void submit()}>
            Uložit do přehledu sázek
          </button>
          <button className="btn py-2" onClick={() => onDone(false)}>
            Zpět
          </button>
        </div>
      </div>
    );

  return (
    <div className="flex flex-wrap items-end gap-2 text-sm">
      <label className="flex flex-col gap-0.5">
        <span className="text-xs text-muted">{kind === 'rejected' ? 'Odmítla sázkovka' : 'Sázkovka'}</span>
        <select className="input" value={bk} onChange={(e) => setBk(e.target.value as BookmakerId)}>
          {books.map((b) => (
            <option key={b} value={b}>
              {bkName(b)}
            </option>
          ))}
        </select>
      </label>
      {kind === 'odds_changed' && (
        <label className="flex flex-col gap-0.5">
          <span className="text-xs text-muted">Nový kurz</span>
          <input className="input w-20" type="number" step={0.01} value={odds} onChange={(e) => setOdds(e.target.value)} />
        </label>
      )}
      <label className="flex flex-1 flex-col gap-0.5">
        <span className="text-xs text-muted">Poznámka</span>
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <button className="btn btn-primary" onClick={() => void submit()}>
        Uložit
      </button>
      <button className="btn" onClick={() => onDone(false)}>
        Zpět
      </button>
    </div>
  );
}
