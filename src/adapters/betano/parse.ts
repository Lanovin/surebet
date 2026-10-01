// Betano (Kaizen „danae“) – čisté funkce: zachycený JSON → RawEvent[].
// Formát běžných trhů se před blokací nepodařilo nahrát (docs/bookmakers/betano.md), proto parser
// hledá události kdekoli ve stromu JSON podle tvaru a mapuje jen jednoznačné hlavní trhy
// (common/main-markets.ts). Po prvním úspěšném běhu: `try-adapter betano prematch --save` a zpřesnit.
import type { RawEvent, RawMarket, Sport } from '../../core/types.js';
import { walkObjects, type ParseContext } from '../common/camoufox-replay.js';
import { mainMarket, PARTIAL_PERIOD_RX, str, toEpochMs, VIRTUAL_RX } from '../common/main-markets.js';

/** Kódy sportů Kaizen (kb-config: supportedSportIds). */
const SPORT_CODES: Record<string, Sport> = {
  FOOT: 'football',
  TENN: 'tennis',
  ICEH: 'hockey',
  BASK: 'basketball',
  HAND: 'handball',
  VOLL: 'volleyball',
  BASE: 'baseball',
  AMFO: 'american_football',
  MMAF: 'mma',
  BOXI: 'boxing',
  DART: 'darts',
  SNOO: 'snooker',
  TABL: 'table_tennis',
};

function sportOf(o: Record<string, unknown>, fallback?: Sport): Sport | undefined {
  for (const k of ['sportId', 'sportCode', 'sport']) {
    const v = o[k];
    if (typeof v === 'string' && SPORT_CODES[v.toUpperCase()]) return SPORT_CODES[v.toUpperCase()];
  }
  return fallback;
}

function participants(o: Record<string, unknown>): [string, string] | undefined {
  const p = o.participants;
  if (Array.isArray(p) && p.length === 2) {
    const names = p.map((x) => (x && typeof x === 'object' ? str((x as Record<string, unknown>).name) : str(x)));
    if (names[0] && names[1]) return [names[0], names[1]];
  }
  const name = str(o.name) ?? str(o.shortName);
  const m = name ? /^(.+?)\s+(?:-|–|vs\.?|v)\s+(.+)$/.exec(name) : null;
  return m ? [m[1].trim(), m[2].trim()] : undefined;
}

function selectionsOf(m: Record<string, unknown>) {
  const sels = Array.isArray(m.selections) ? m.selections : Array.isArray(m.outcomes) ? m.outcomes : null;
  if (!sels) return null;
  return sels.map((s) => {
    const x = (s ?? {}) as Record<string, unknown>;
    return {
      label: str(x.name) ?? str(x.shortName) ?? str(x.label) ?? '',
      odds: x.price ?? x.originalPrice ?? x.odds ?? x.odd,
      open: !(x.isSuspended === true || x.suspended === true || x.isActive === false),
    };
  });
}

function marketsOf(o: Record<string, unknown>, sport: Sport): RawMarket[] {
  const out: RawMarket[] = [];
  const raw = Array.isArray(o.markets) ? o.markets : [];
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue;
    const mm = m as Record<string, unknown>;
    const name = str(mm.name) ?? str(mm.fullName) ?? '';
    if (PARTIAL_PERIOD_RX.test(name)) continue;
    const sels = selectionsOf(mm);
    if (!sels) continue;
    const mk = mainMarket(sport, sels, { sourceId: mm.id != null ? String(mm.id) : undefined, rawName: name || str(mm.type) });
    if (!mk) continue;
    if (mm.isSuspended === true || mm.suspended === true) mk.open = false;
    if (!out.some((x) => x.key === mk.key)) out.push(mk);
  }
  return out;
}

export function parseBetano(json: unknown, ctx: ParseContext): RawEvent[] {
  const out: RawEvent[] = [];
  walkObjects(json, (o) => {
    if (!Array.isArray(o.markets) || !o.markets.length) return;
    const id = o.id ?? o.eventId;
    if (id == null) return;
    const names = participants(o);
    if (!names) return;
    const sport = sportOf(o, ctx.sport);
    if (!sport) return;
    const competition = str(o.leagueName) ?? str(o.leagueDescription) ?? str(o.league) ?? '';
    if (VIRTUAL_RX.test(`${competition} ${str(o.name) ?? ''}`) || o.isVirtual === true) return;
    const startTime = toEpochMs(o.startTime ?? o.eventStartDate ?? o.startDate);
    if (!startTime) return;
    const markets = marketsOf(o, sport);
    if (!markets.length) return;
    const url = str(o.url);
    out.push({
      sourceId: String(id),
      sport,
      competition,
      country: str(o.regionName),
      home: names[0],
      away: names[1],
      startTime,
      live: ctx.scope === 'live' || o.liveNow === true || o.isLive === true,
      markets,
      url: url ? (url.startsWith('http') ? url : ctx.origin + url) : undefined,
    });
  });
  return out;
}