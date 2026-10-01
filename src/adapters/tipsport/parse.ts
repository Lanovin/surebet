// Tipsport.cz – čisté funkce: zachycený JSON z /rest/… → RawEvent[].
// Tvar podle archivních odpovědí (2024) a veřejného swaggeru (EventTableApiTO): zápasy s
// homeParticipant / visitingParticipant, kurzy v oppRows[].oppsTab[] (label „1/0/2/10/02/12“, odd)
// nebo v eventTables[].boxes[].cells[] (name, odd, active). Aktuální v3/v6 se může lišit, proto parser
// hledá zápasy kdekoli ve stromu JSON a mapuje jen jednoznačné hlavní trhy (common/main-markets.ts).
import type { RawEvent, RawMarket, Sport } from '../../core/types.js';
import { walkObjects, type ParseContext } from '../common/camoufox-replay.js';
import { mainMarketsFromRow, PARTIAL_PERIOD_RX, str, toEpochMs, VIRTUAL_RX, type LabeledOdd } from '../common/main-markets.js';

/** idSuperSport → sport (16 a 43 ověřeno z archivu; ostatní se berou z názvu sportu). */
const SUPERSPORT_IDS: Record<number, Sport> = { 16: 'football', 43: 'tennis' };

export function sportFromName(name: string | undefined): Sport | undefined {
  if (!name) return undefined;
  const n = name.toLowerCase();
  if (/plážov|plazov|futsal|malá kopaná|mala kopana|pozemní|pozemni|in-line|inline/.test(n)) return undefined;
  if (/americk/.test(n)) return 'american_football';
  if (/stolní tenis|stolni tenis/.test(n)) return 'table_tennis';
  if (/fotbal/.test(n)) return 'football';
  if (/tenis/.test(n)) return 'tennis';
  if (/hokej/.test(n)) return 'hockey';
  if (/házen|hazen/.test(n)) return 'handball';
  if (/volejbal/.test(n)) return 'volleyball';
  if (/basket/.test(n)) return 'basketball';
  return undefined;
}

function sportOf(o: Record<string, unknown>, fallback?: Sport): Sport | undefined {
  const id = Number(o.idSuperSport ?? o.superSportId);
  if (SUPERSPORT_IDS[id]) return SUPERSPORT_IDS[id];
  return sportFromName(str(o.nameSuperSport) ?? str(o.superSportName) ?? str(o.superSport) ?? str(o.nameSport) ?? str(o.sportName)) ?? fallback;
}

function participants(o: Record<string, unknown>): [string, string] | undefined {
  const h = str(o.homeParticipant) ?? str(o.participantHome);
  const a = str(o.visitingParticipant) ?? str(o.participantVisiting) ?? str(o.participantAway);
  if (h && a) return [h, a];
  const name = str(o.name);
  const m = name ? /^(.+?)\s+(?:-|–)\s+(.+)$/.exec(name) : null;
  return m ? [m[1].trim(), m[2].trim()] : undefined;
}

function rowsOf(o: Record<string, unknown>): { name: string; sels: LabeledOdd[] }[] {
  const rows: { name: string; sels: LabeledOdd[] }[] = [];
  if (Array.isArray(o.oppRows)) {
    for (const r of o.oppRows) {
      const row = (r ?? {}) as Record<string, unknown>;
      const tab = Array.isArray(row.oppsTab) ? row.oppsTab : [];
      rows.push({
        name: str(row.name) ?? '',
        sels: tab.map((x) => {
          const c = (x ?? {}) as Record<string, unknown>;
          return { label: str(c.label) ?? str(c.name) ?? '', odds: c.odd, open: c.bettingEnabled !== false && c.active !== false };
        }),
      });
    }
  }
  if (Array.isArray(o.eventTables)) {
    for (const t of o.eventTables) {
      const table = (t ?? {}) as Record<string, unknown>;
      const cells = (Array.isArray(table.boxes) ? table.boxes : []).flatMap((b) => {
        const box = (b ?? {}) as Record<string, unknown>;
        return Array.isArray(box.cells) ? box.cells : [];
      });
      rows.push({
        name: str(table.name) ?? '',
        sels: cells.map((x) => {
          const c = (x ?? {}) as Record<string, unknown>;
          return { label: str(c.oppNumber) ?? str(c.name) ?? '', odds: c.odd, open: c.active !== false };
        }),
      });
    }
  }
  return rows;
}

export function parseTipsport(json: unknown, ctx: ParseContext): RawEvent[] {
  const out: RawEvent[] = [];
  walkObjects(json, (o) => {
    if (!Array.isArray(o.oppRows) && !Array.isArray(o.eventTables)) return;
    const id = o.id ?? o.idMatch ?? o.matchId;
    if (id == null) return;
    const names = participants(o);
    if (!names) return;
    const sport = sportOf(o, ctx.sport);
    if (!sport) return;
    const competition = str(o.nameCompetition) ?? str(o.competitionName) ?? str(o.competition) ?? str(o.nameFullCompetition) ?? '';
    if (VIRTUAL_RX.test(`${competition} ${str(o.name) ?? ''}`)) return;
    const startTime = toEpochMs(o.datetimeClosed ?? o.dateClosed ?? o.datetimeStart ?? o.dateStart);
    if (!startTime) return;
    const markets: RawMarket[] = [];
    for (const row of rowsOf(o)) {
      if (PARTIAL_PERIOD_RX.test(row.name)) continue;
      for (const m of mainMarketsFromRow(sport, row.sels, { rawName: row.name || undefined })) {
        if (!markets.some((x) => x.key === m.key)) markets.push(m);
      }
    }
    if (!markets.length) return;
    const url = str(o.matchUrl) ?? str(o.url);
    out.push({
      sourceId: String(id),
      sport,
      competition,
      home: names[0],
      away: names[1],
      startTime,
      live: ctx.scope === 'live' || o.live === true || o.isLive === true,
      markets,
      url: url ? (url.startsWith('http') ? url : ctx.origin + url) : undefined,
    });
  });
  return out;
}