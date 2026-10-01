'use client';
// Zvuk (WebAudio, bez souborů) a browser notifikace (Notification API).
import type { ArbDTO } from '@shared/protocol';
import type { Mode } from '@core/types';

let ctx: AudioContext | null = null;

export function unlockAudio(): void {
  if (!ctx && typeof window !== 'undefined') ctx = new AudioContext();
  void ctx?.resume();
}

export function playAlert(mode: Mode): void {
  try {
    if (!ctx) ctx = new AudioContext();
    const tones = mode === 'LIVE' ? [880, 1175] : mode === 'PAUSED' ? [740, 988] : [660];
    let t = ctx.currentTime;
    for (const f of tones) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.18, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.18);
      t += 0.14;
    }
  } catch {
    /* audio není povolené, dokud uživatel neklikne */
  }
}

export async function requestNotifications(): Promise<NotificationPermission | 'unsupported'> {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission === 'default') return Notification.requestPermission();
  return Notification.permission;
}

export function notifyArb(arb: ArbDTO): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(`${arb.margin.toFixed(2)} % ${arb.mode} · ${arb.eventName}`, {
      body: `${arb.marketLabel}\n${arb.legs.map((l) => `${l.bookmaker} ${l.selectionLabel} @ ${l.odds}`).join(' · ')}`,
      tag: arb.id,
      silent: true,
    });
    n.onclick = () => {
      window.open(`/arb/${arb.id}`, `arb-${arb.id}`);
      n.close();
    };
  } catch {
    /* ignore */
  }
}
