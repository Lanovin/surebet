// Betano.cz (Kaizen Gaming) – zatím bez funkční strategie, viz docs/bookmakers/betano.md.
// Cloudflare bot management vrací na všechny cesty 403 „Betano Splash Screen“ (blokační stránka,
// ne landing page): plain HTTP (TLS otisk) i výchozí headless Chromium (HeadlessChrome v UA/sec-ch-ua);
// i s běžným UA se relace zablokuje hned po doběhnutí JS detekce Cloudflare. Obejít to by znamenalo
// skrývat automatizaci (stealth) – mimo pravidla projektu. Registry adaptér bez strategií přeskočí.
// S Fortunou platformu nesdílí (Fortuna = FEG „ufo“, Betano = Kaizen danae-webapi/SignalR).
import type { AdapterFactory } from '../types.js';

const factory: AdapterFactory = () => ({
  bookmaker: 'betano',
  strategies: [],
});

export default factory;
