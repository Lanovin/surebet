'use client';
import { useEffect, useState } from 'react';
import type { Settings } from '@core/settings';
import { BOOKMAKERS, MODES, SPORTS } from '@core/types';
import { api, bkName, SPORT_LABEL, PAUSE_LABEL } from '@/lib/format';
import { pushToast, useLive } from '@/lib/live';
import { ModeBadge } from '@/components/Badges';

type Path = (string | number)[];

function setIn<T>(obj: T, path: Path, value: unknown): T {
  const copy = structuredClone(obj) as Record<string | number, unknown>;
  let cur = copy;
  for (let i = 0; i < path.length - 1; i++) cur = cur[path[i]] as Record<string | number, unknown>;
  cur[path[path.length - 1]] = value;
  return copy as T;
}

export default function SettingsPage() {
  const live = useLive((s) => s.settings);
  const [s, setS] = useState<Settings | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [measured, setMeasured] = useState<{ reactionMs: number; measuredReactionMs: number | null } | null>(null);

  useEffect(() => {
    if (live && !dirty) setS(live);
  }, [live, dirty]);
  useEffect(() => {
    void api<{ detector: { predictor?: { reactionMs: number; measuredReactionMs: number | null } } | null }>('/meta').then((m) => setMeasured(m.detector?.predictor ?? null));
  }, []);

  if (!s) return <div className="text-muted">Načítám nastavení…</div>;
  const upd = (path: Path, v: unknown) => {
    setS(setIn(s, path, v));
    setDirty(true);
  };
  const num = (path: Path, v: number, props: { step?: number; min?: number; max?: number; w?: string } = {}) => (
    <input
      className={`input ${props.w ?? 'w-24'} text-right`}
      type="number"
      step={props.step ?? 1}
      min={props.min}
      max={props.max}
      value={v}
      onChange={(e) => upd(path, Number(e.target.value))}
    />
  );
  const save = async () => {
    setSaving(true);
    try {
      const r = await api<{ settings: Settings }>('/settings', { method: 'PATCH', body: JSON.stringify(s) });
      setS(r.settings);
      setDirty(false);
      pushToast('Nastavení uloženo – platí okamžitě bez restartu', 'good');
    } catch (e) {
      pushToast(`Neuloženo: ${(e as Error).message}`, 'bad');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-5xl space-y-4">
      <div className="sticky top-14 z-10 flex items-center gap-3 bg-page py-2">
        <h1 className="text-lg font-semibold">Nastavení</h1>
        <span className="text-sm text-muted">Změny platí okamžitě ve všech službách.</span>
        <div className="ml-auto flex gap-2">
          <button className="btn" disabled={!dirty} onClick={() => (setS(live), setDirty(false))}>
            Zahodit
          </button>
          <button className="btn btn-primary" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? 'Ukládám…' : 'Uložit'}
          </button>
        </div>
      </div>

      <section className="card p-4">
        <h2 className="mb-3 font-medium">Režimy</h2>
        <table className="data w-full text-sm">
          <thead>
            <tr>
              <th>Režim</th>
              <th className="text-right">Min. marže %</th>
              <th className="text-right">Sběr od (ms)</th>
              <th className="text-right">Sběr do (ms)</th>
              <th className="text-right">Max stáří nohy (ms)</th>
              <th>Websocket</th>
            </tr>
          </thead>
          <tbody>
            {MODES.map((m) => (
              <tr key={m}>
                <td>
                  <ModeBadge mode={m} />
                </td>
                <td className="text-right">{num(['modes', m, 'minMarginPct'], s.modes[m].minMarginPct, { step: 0.1, min: 0 })}</td>
                <td className="text-right">{num(['modes', m, 'pollMinMs'], s.modes[m].pollMinMs, { step: 100, min: 200, w: 'w-28' })}</td>
                <td className="text-right">{num(['modes', m, 'pollMaxMs'], s.modes[m].pollMaxMs, { step: 100, min: 200, w: 'w-28' })}</td>
                <td className="text-right">{num(['modes', m, 'maxLegAgeMs'], s.modes[m].maxLegAgeMs, { step: 500, min: 500, w: 'w-28' })}</td>
                <td>
                  <input type="checkbox" checked={s.modes[m].preferPush} onChange={(e) => upd(['modes', m, 'preferPush'], e.target.checked)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card grid grid-cols-1 gap-4 p-4 md:grid-cols-2">
        <div className="space-y-2">
          <h2 className="font-medium">Vklady</h2>
          <label className="flex items-center justify-between gap-2 text-sm">
            Bankroll (Kč) {num(['bankroll'], s.bankroll, { step: 100, min: 10, w: 'w-32' })}
          </label>
          <label className="flex items-center justify-between gap-2 text-sm">
            Zaokrouhlení vkladů (Kč) {num(['roundingUnit'], s.roundingUnit, { min: 1 })}
          </label>
          <h2 className="pt-2 font-medium">Reakční doba</h2>
          <label className="flex items-center justify-between gap-2 text-sm">
            Moje reakční doba (ms) {num(['reactionTimeMs'], s.reactionTimeMs, { step: 500, min: 0, w: 'w-28' })}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={s.useMeasuredReaction} onChange={(e) => upd(['useMeasuredReaction'], e.target.checked)} />
            používat naměřenou z user_actions
            <span className="text-muted">
              ({measured?.measuredReactionMs != null ? `naměřeno ${Math.round(measured.measuredReactionMs)} ms` : 'zatím málo dat'})
            </span>
          </label>
        </div>
        <div className="space-y-2">
          <h2 className="font-medium">Zvuk a notifikace</h2>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={s.alerts.sound} onChange={(e) => upd(['alerts', 'sound'], e.target.checked)} /> zvuk
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={s.alerts.notifications} onChange={(e) => upd(['alerts', 'notifications'], e.target.checked)} /> browser notifikace
          </label>
          <label className="flex items-center justify-between gap-2 text-sm">
            Práh marže pro zvuk/notifikaci (%) {num(['alerts', 'minMarginPct'], s.alerts.minMarginPct, { step: 0.1, min: 0 })}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={s.alerts.muteLowSurvival} onChange={(e) => upd(['alerts', 'muteLowSurvival'], e.target.checked)} />
            ztlumit arby s nízkou šancí přežít reakci + přijetí
          </label>
          <label className="flex items-center justify-between gap-2 text-sm">
            Min. pravděpodobnost přežití {num(['alerts', 'minSurvivalProb'], s.alerts.minSurvivalProb, { step: 0.05, min: 0, max: 1 })}
          </label>
        </div>
      </section>

      <section className="card p-4">
        <h2 className="mb-3 font-medium">Sázkovky</h2>
        <table className="data w-full text-sm">
          <thead>
            <tr>
              <th>Sázkovka</th>
              <th>Aktivní</th>
              <th className="text-right">Poplatek z vkladu %</th>
              <th className="text-right">Přijetí prematch (ms)</th>
              <th className="text-right">Přijetí live (ms)</th>
            </tr>
          </thead>
          <tbody>
            {BOOKMAKERS.map((b) => (
              <tr key={b}>
                <td>{bkName(b)}</td>
                <td>
                  <input type="checkbox" checked={s.bookmakers[b].enabled} onChange={(e) => upd(['bookmakers', b, 'enabled'], e.target.checked)} />
                </td>
                <td className="text-right">{num(['bookmakers', b, 'feePct'], s.bookmakers[b].feePct, { step: 0.5, min: 0 })}</td>
                <td className="text-right">{num(['bookmakers', b, 'acceptanceDelayMs', 'prematch'], s.bookmakers[b].acceptanceDelayMs.prematch, { step: 500, min: 0, w: 'w-28' })}</td>
                <td className="text-right">{num(['bookmakers', b, 'acceptanceDelayMs', 'live'], s.bookmakers[b].acceptanceDelayMs.live, { step: 500, min: 0, w: 'w-28' })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card grid grid-cols-1 gap-4 p-4 md:grid-cols-2">
        <div className="space-y-2">
          <h2 className="font-medium">Přestávky – očekávaná délka (s)</h2>
          {(Object.keys(s.pause.expectedSec) as (keyof Settings['pause']['expectedSec'])[]).map((k) => (
            <label key={k} className="flex items-center justify-between gap-2 text-sm">
              {PAUSE_LABEL[k] ?? k} {num(['pause', 'expectedSec', k], s.pause.expectedSec[k], { step: 10, min: 0 })}
            </label>
          ))}
          <h2 className="pt-2 font-medium">Fallback detekce: hodiny stojí déle než (s)</h2>
          {SPORTS.map((sp) => (
            <label key={sp} className="flex items-center justify-between gap-2 text-sm">
              {SPORT_LABEL[sp]} {num(['pause', 'fallbackSec', sp], s.pause.fallbackSec[sp], { step: 5, min: 5 })}
            </label>
          ))}
        </div>
        <div className="space-y-2">
          <h2 className="font-medium">Párování</h2>
          <label className="flex items-center justify-between gap-2 text-sm">
            Automaticky spárovat od skóre {num(['matching', 'autoAccept'], s.matching.autoAccept, { step: 0.01, min: 0.5, max: 1 })}
          </label>
          <label className="flex items-center justify-between gap-2 text-sm">
            Do fronty k potvrzení od skóre {num(['matching', 'review'], s.matching.review, { step: 0.01, min: 0.3, max: 1 })}
          </label>
          <label className="flex items-center justify-between gap-2 text-sm">
            Tolerance začátku (min) {num(['matching', 'startToleranceMin'], s.matching.startToleranceMin, { min: 0 })}
          </label>
          <h2 className="pt-2 font-medium">Konsenzus</h2>
          <label className="flex items-center justify-between gap-2 text-sm">
            Max. odchylka od ostatních sázkovek (%) {num(['consensus', 'maxDeviationPct'], s.consensus.maxDeviationPct, { min: 1 })}
          </label>
          <label className="flex items-center justify-between gap-2 text-sm">
            Min. počet ostatních sázkovek {num(['consensus', 'minBooks'], s.consensus.minBooks, { min: 2, max: 8 })}
          </label>
        </div>
      </section>
    </div>
  );
}
