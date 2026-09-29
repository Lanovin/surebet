'use client';
import { useEffect, useState } from 'react';

/** Aktuální čas přepočítávaný v intervalu (živě běžící stáří arbů, odpočty). */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
