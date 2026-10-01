// Tipsport.cz / Chance.cz – čisté funkce: zachycený JSON z /rest/… → RawEvent[].
// Prematch: POST /rest/offer/v2/offer (type SUPERSPORT) – zápasy s participantHome / participantVisiting,
// kurzy výchozí záložky „Zápas“ v oppRows[].oppsTab[] (label „1/10/0/02/2“, odd, bettingEnabled), starší
// tvar eventTables[].boxes[].cells[]. Parser hledá zápasy kdekoli ve stromu JSON a mapuje jen jednoznačné
// hlavní trhy (common/main-markets.ts). Live: viz parseTipsportLive (ověřeno na živých datech 2026-10-01).
import type { GameState, MarketScope, MarketType, RawEvent, RawMarket, RawSelection, SelectionKey, Sport } from '../../core/types.js';
import { marketKey } from '../../core/markets.js';
import { walkObjects, type ParseContext } from '../common/camoufox-replay.js';
import { labelToKey, mainMarketsFromRow, PARTIAL_PERIOD_RX, str, toEpochMs, toOdds, VIRTUAL_RX, type LabeledOdd } from '../common/main-markets.js';

/** superSportId → sport (ověřeno z /rest/offer/v6/sports a live entit, 2026-10-01). */
export const SUPERSPORT_IDS: Record<number, Sport> = {
  16: 'football',
  23: 'hockey',
  43: 'tennis',
  7: 'basketball',
  40: 'table_tennis',
  20: 'handball',
  47: 'volleyball',
  6: 'baseball',
  2: 'american_football',
  208: 'mma', // „Bojové sporty“ (UFC, Oktagon …)
  11: 'boxing',
  37: 'snooker',
  42: 'darts',
};

export function sportFromName(name: string | undefined): Sport | undefined {
  if (!name) return undefined;
  const n = name.toLowerCase();
  if (/plážov|plazov|futsal|malá kopaná|mala kopana|pozemní|pozemni|in-line|inline|esport/.test(n)) return undefined;
  if (/americk/.test(n)) return 'american_football';
  if (/stolní tenis|stolni tenis/.test(n)) return 'table_tennis';
  if (/fotbal/.test(n)) return 'football';
  if (/tenis/.test(n)) return 'tennis';
  if (/hokej/.test(n)) return 'hockey';
  if (/házen|hazen/.test(n)) return 'handball';
  if (/volejbal/.test(n)) return 'volleyball';
  if (/basket/.test(n)) return 'basketball';
  if (/baseball/.test(n)) return 'baseball';
  if (/snooker/.test(n)) return 'snooker';
  if (/šipky|sipky/.test(n)) return 'darts';
  if (/^box/.test(n)) return 'boxing';
  if (/bojové sporty|bojove sporty|\bmma\b/.test(n)) return 'mma';
  return undefined;
}

function sportOf(o: Record<string, unknown>, fallback?: Sport): Sport | undefined {
  const id = Number(o.idSuperSport ?? o.superSportId);
  if (SUPERSPORT_IDS[id]) return SUPERSPORT_IDS[id];
  const name = str(o.nameSuperSport) ?? str(o.superSportName) ?? str(o.superSport) ?? str(o.nameSport) ?? str(o.sportName);
  // známé ID / název mimo naše sporty (e-sporty, dostihy …) → nebrat sport stránky
  if (Number.isFinite(id) || name) return sportFromName(name);
  return fallback;
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
  const root = (json ?? {}) as Record<string, unknown>;
  if (root.entities && root.odds) return parseTipsportLive(root.entities, root.odds, ctx);
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
// ---------------------------------------------------------------------------------------------------
// Live: GET /rest/offer/v1/live/in-play/entities (zápasy, soutěže, superSporty) +
//       GET /rest/offer/v1/live/in-play/event-groups/odds (kurzy po skupinách eventGroupId).
// Obě odpovědi mají tvar { patches: [{ version, value }] }; strategie je stáhne jako jeden cíl
// s částmi `entities` a `odds`.

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj) : []);

/** Hodnoty ze všech patchů (u plné odpovědi je patch jeden). */
function patchValues(v: unknown): Obj[] {
  return arr(obj(v).patches).map((p) => obj(p.value));
}

interface LiveGroupDef {
  type: MarketType;
  scope: MarketScope;
  kind: 'RESULT' | 'OU' | 'BTTS';
  sports: readonly Sport[];
}

/**
 * eventGroupId → trh. Výsledkové skupiny WINNER_3W_* jdou přes mainMarketsFromRow (tvar výběrů + sport).
 * Totaly jen tam, kde je rozsah jasný: fotbal (90 min), basket „WITH_OVERTIME“, tenis gamy, snooker framy;
 * hokej/házená „WHOLE_MATCH“ vynechány (není jasné, zda vč. prodloužení), setové totaly taky.
 */
const LIVE_GROUPS: Record<string, LiveGroupDef> = {
  WINNER_HALFTIME: { type: '1X2', scope: 'H1', kind: 'RESULT', sports: ['football'] },
  ASIAN_TOTAL_WHOLE_MATCH_GOALS: { type: 'OU', scope: 'REG', kind: 'OU', sports: ['football'] },
  ASIAN_TOTAL_HALFTIME_GOALS: { type: 'OU', scope: 'H1', kind: 'OU', sports: ['football'] },
  ASIAN_TOTAL_WHOLE_MATCH_WITH_OVERTIME_POINTS: { type: 'OU', scope: 'MATCH', kind: 'OU', sports: ['basketball'] },
  ASIAN_TOTAL_WHOLE_MATCH_GAMS: { type: 'OU', scope: 'MATCH', kind: 'OU', sports: ['tennis'] },
  ASIAN_TOTAL_WHOLE_MATCH_FRAMES: { type: 'OU', scope: 'MATCH', kind: 'OU', sports: ['snooker'] },
  BOTH_SHOOT_GOALS: { type: 'BTTS', scope: 'REG', kind: 'BTTS', sports: ['football'] },
};

interface LiveCell {
  label: string;
  odds: unknown;
  open: boolean;
}

function liveCells(group: Obj): LiveCell[] | null {
  const cells = arr(group.cells).map((c) => obj(c.info));
  if (!cells.length || cells.some((c) => !Object.keys(c).length)) return null; // prázdná buňka = trh teď není
  return cells.map((c) => ({ label: str(c.label) ?? '', odds: c.odd, open: c.bettingEnabled !== false }));
}

function liveGroupMarket(def: LiveGroupDef, cells: LiveCell[], sourceId?: string, rawName?: string): RawMarket | null {
  const sels: RawSelection[] = [];
  let line: number | undefined;
  for (const c of cells) {
    let key: SelectionKey | undefined;
    if (def.kind === 'RESULT') {
      const k = labelToKey(c.label);
      key = k === 'HOME' || k === 'DRAW' || k === 'AWAY' ? k : undefined;
    } else if (def.kind === 'OU') {
      const m = /^([+-])\s*(\d+(?:[.,]\d+)?)$/.exec(c.label.trim());
      if (m) {
        key = m[1] === '+' ? 'OVER' : 'UNDER';
        const l = Number(m[2].replace(',', '.'));
        if (line !== undefined && line !== l) return null;
        line = l;
      }
    } else {
      key = /^ano$/i.test(c.label) ? 'YES' : /^ne$/i.test(c.label) ? 'NO' : undefined;
    }
    const odds = toOdds(c.odds);
    if (!key || odds === undefined || sels.some((s) => s.key === key)) return null;
    sels.push({ key, odds, open: c.open, rawName: c.label });
  }
  if (sels.length !== (def.kind === 'RESULT' ? 3 : 2)) return null;
  if (def.kind === 'OU' && !(line !== undefined && line > 0)) return null;
  return {
    key: marketKey(def.type, def.scope, def.kind === 'OU' ? line : undefined),
    open: sels.some((s) => s.open !== false),
    selections: sels,
    sourceId,
    rawName,
  };
}

function liveState(score: Obj, sport: Sport): GameState | undefined {
  const st: GameState = {};
  const text = str(score.statusOffer);
  if (text) st.statusText = text;
  const m = /^(\d+):(\d+)$/.exec(str(score.scoreOffer) ?? '');
  // u tenisu/stolního tenisu/šipek/snookeru/volejbalu není jisté, co scoreOffer počítá (sety/legy/framy)
  if (m && (sport === 'football' || sport === 'hockey' || sport === 'handball' || sport === 'basketball' || sport === 'american_football' || sport === 'baseball')) {
    st.score = [Number(m[1]), Number(m[2])];
  }
  return Object.keys(st).length ? st : undefined;
}

export function parseTipsportLive(entities: unknown, odds: unknown, ctx: ParseContext): RawEvent[] {
  const ent = patchValues(entities);
  const competitions = new Map<number, string>();
  const matches: Obj[] = [];
  for (const v of ent) {
    for (const c of arr(v.competitions)) if (str(c.name)) competitions.set(Number(c.id), str(c.name)!);
    matches.push(...arr(v.matches));
  }
  const groupsByMatch = new Map<number, Obj[]>();
  for (const v of patchValues(odds)) {
    for (const g of arr(v.matchEventGroups)) groupsByMatch.set(Number(g.matchId), arr(g.eventGroups));
  }

  const out: RawEvent[] = [];
  for (const m of matches) {
    if (m.ended === true) continue;
    const sport = SUPERSPORT_IDS[Number(m.superSportId)];
    if (!sport) continue;
    const names = participants({ name: m.nameFull });
    if (!names) continue;
    const competition = competitions.get(Number(m.competitionId)) ?? '';
    if (VIRTUAL_RX.test(`${competition} ${str(m.nameFull) ?? ''}`)) continue;
    const startTime = toEpochMs(m.dateStart);
    if (!startTime) continue;
    const markets: RawMarket[] = [];
    const push = (mk: RawMarket | null) => {
      if (mk && !markets.some((x) => x.key === mk.key)) markets.push(mk);
    };
    for (const g of groupsByMatch.get(Number(m.id)) ?? []) {
      const gid = str(g.eventGroupId) ?? '';
      const cells = liveCells(g);
      if (!cells) continue;
      if (/^WINNER_3W_/.test(gid)) {
        const sels: LabeledOdd[] = cells.map((c) => ({ label: c.label, odds: c.odds, open: c.open }));
        for (const mk of mainMarketsFromRow(sport, sels, { rawName: gid })) push(mk);
        continue;
      }
      const def = LIVE_GROUPS[gid];
      if (def && def.sports.includes(sport)) push(liveGroupMarket(def, cells, undefined, gid));
    }
    if (!markets.length) continue;
    const url = str(m.url);
    const ev: RawEvent = {
      sourceId: String(m.id),
      sport,
      competition,
      home: names[0],
      away: names[1],
      startTime,
      live: m.notStarted !== true,
      markets,
      url: url ? (url.startsWith('http') ? url : ctx.origin + url) : undefined,
    };
    const state = liveState(obj(m.score), sport);
    if (state) ev.state = state;
    out.push(ev);
  }
  return out;
}
