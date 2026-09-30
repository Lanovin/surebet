// SYNOT TIP – minimální dekodér protobufu pro prematch odpovědi (GetWebStandardEvents).
//
// Web (platforma eBet, React bundle /reactw/js/app.min.js) posílá `ReturnValue` jako base64
// protobuf a dekóduje ho staticky generovaným kódem protobufjs. Schéma níže je výřez z tohoto
// kódu (číslo pole → název, typ) – jen zprávy, které adaptér potřebuje; ostatní pole se přeskočí.
// Knihovnu protobufjs nepotřebujeme: wire formát je jednoduchý a zpráv je pár.

type Prim = 'int32' | 'int64' | 'bool' | 'string' | 'float';
/** [název, typ (primitivum nebo jméno zprávy), opakované?] */
type Field = [name: string, type: Prim | MessageName, repeated?: true];
type MessageName =
  | 'GetWebStandardEventsResponse'
  | 'FirstLevelCategory'
  | 'SecondLevelCategory'
  | 'ThirdLevelCategory'
  | 'FourthLevelCategory'
  | 'CategoryBase'
  | 'Event'
  | 'Timestamp'
  | 'Competitor'
  | 'GameGroup'
  | 'Game'
  | 'Detail'
  | 'Odds';

const R = true as const;
const SCHEMA: Record<MessageName, Record<number, Field>> = {
  GetWebStandardEventsResponse: { 1: ['EventTree', 'FirstLevelCategory'], 3: ['UnpaginatedEventCount', 'int32'] },
  FirstLevelCategory: { 1: ['Categories', 'SecondLevelCategory', R] },
  SecondLevelCategory: { 1: ['Base', 'CategoryBase'], 4: ['Categories', 'ThirdLevelCategory', R], 5: ['IsVirtual', 'bool'] },
  ThirdLevelCategory: { 1: ['Base', 'CategoryBase'], 2: ['Categories', 'FourthLevelCategory', R] },
  FourthLevelCategory: { 1: ['Base', 'CategoryBase'] },
  CategoryBase: { 1: ['Id', 'string'], 2: ['Name', 'string'], 3: ['ParentId', 'string'], 5: ['Events', 'Event', R] },
  Event: {
    1: ['Id', 'int32'],
    2: ['Name', 'string'],
    4: ['Date', 'Timestamp'],
    6: ['GameGroups', 'GameGroup', R],
    7: ['CategoryId', 'string'],
    9: ['Competitors', 'Competitor', R],
    13: ['CategoryPath', 'string'],
    14: ['IsLive', 'bool'],
  },
  Timestamp: { 1: ['Value', 'int64'] },
  Competitor: { 1: ['Id', 'int32'], 2: ['Name', 'string'] },
  GameGroup: { 1: ['ID', 'int32'], 2: ['Name', 'string'], 3: ['Games', 'Game', R] },
  Game: { 1: ['ID', 'string'], 2: ['Name', 'string'], 6: ['Details', 'Detail', R] },
  Detail: { 1: ['ID', 'int32'], 2: ['Name', 'string'], 4: ['OddsList', 'Odds', R], 9: ['State', 'int32'], 10: ['Suspended', 'bool'] },
  Odds: { 1: ['TipID', 'string'], 2: ['Name', 'string'], 3: ['Rate', 'float'], 6: ['State', 'int32'] },
};

// ---------- dekódované typy (tvar shodný s JSON live feedem, kde to jde) ----------

export interface PbOdds {
  TipID?: string;
  Name?: string;
  Rate?: number;
  /** 0 None, 1 Created, 2 Opened, 3 Suspended, 4 Closed */
  State?: number;
}
export interface PbDetail {
  ID?: number;
  Name?: string;
  OddsList?: PbOdds[];
  State?: number;
  Suspended?: boolean;
}
export interface PbGame {
  ID?: string;
  Name?: string;
  Details?: PbDetail[];
  /** Jen live JSON (stav trhu, 2 = Opened); protobuf zpráva Game toto pole nemá. */
  State?: number;
}
export interface PbGameGroup {
  ID?: number;
  Name?: string;
  Games?: PbGame[];
}
export interface PbEvent {
  Id?: number;
  Name?: string;
  Date?: { Value?: number };
  GameGroups?: PbGameGroup[];
  CategoryId?: string;
  Competitors?: { Id?: number; Name?: string }[];
  CategoryPath?: string;
  IsLive?: boolean;
}
export interface PbCategoryBase {
  Id?: string;
  Name?: string;
  ParentId?: string;
  Events?: PbEvent[];
}
export interface PbCategory {
  Base?: PbCategoryBase;
  Categories?: PbCategory[];
  IsVirtual?: boolean;
}
export interface PbEventsResponse {
  EventTree?: { Categories?: PbCategory[] };
  UnpaginatedEventCount?: number;
}

// ---------- wire formát ----------

class Reader {
  pos = 0;
  constructor(readonly buf: Buffer) {}

  /** Varint jako Number; nad 2^53 přes BigInt (záporné int32/int64 se kódují na 10 bajtů). */
  varint(): number {
    let result = 0;
    let mul = 1;
    for (let i = 0; i < 7; i++) {
      const b = this.buf[this.pos++];
      if (b === undefined) throw new Error('protobuf: unexpected end of buffer');
      result += (b & 0x7f) * mul;
      if (!(b & 0x80)) return result;
      mul *= 128;
    }
    let big = BigInt(result);
    let shift = 49n;
    for (;;) {
      const b = this.buf[this.pos++];
      if (b === undefined) throw new Error('protobuf: unexpected end of buffer');
      big |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7n;
    }
    return Number(BigInt.asIntN(64, big));
  }

  skip(wireType: number): void {
    if (wireType === 0) this.varint();
    else if (wireType === 1) this.pos += 8;
    else if (wireType === 2) {
      const len = this.varint(); // nejdřív přečíst délku (posune pos), pak přeskočit
      this.pos += len;
    }
    else if (wireType === 5) this.pos += 4;
    else throw new Error(`protobuf: unsupported wire type ${wireType}`);
  }
}

function decodeMessage(r: Reader, end: number, type: MessageName): Record<string, unknown> {
  const fields = SCHEMA[type];
  const out: Record<string, unknown> = {};
  while (r.pos < end) {
    const tag = r.varint();
    const no = Math.floor(tag / 8);
    const wt = tag & 7;
    const f = fields[no];
    if (!f) {
      r.skip(wt);
      continue;
    }
    const [name, t, repeated] = f;
    let v: unknown;
    if (t === 'string') {
      const len = r.varint();
      v = r.buf.toString('utf8', r.pos, r.pos + len);
      r.pos += len;
    } else if (t === 'float') {
      if (wt !== 5) {
        r.skip(wt);
        continue;
      }
      v = r.buf.readFloatLE(r.pos);
      r.pos += 4;
    } else if (t === 'int32' || t === 'int64' || t === 'bool') {
      if (wt !== 0) {
        r.skip(wt);
        continue;
      }
      const n = r.varint();
      v = t === 'bool' ? n !== 0 : t === 'int32' ? n | 0 : n;
    } else {
      if (wt !== 2) {
        r.skip(wt);
        continue;
      }
      const len = r.varint();
      v = decodeMessage(r, r.pos + len, t);
    }
    if (repeated) ((out[name] ??= []) as unknown[]).push(v);
    else out[name] = v;
  }
  if (r.pos !== end) throw new Error(`protobuf: ${type} overran its length`);
  return out;
}

/** `ReturnValue` z GetWebStandardEvents (base64) → strom kategorií s událostmi. */
export function decodeEventsResponse(base64: string): PbEventsResponse {
  const buf = Buffer.from(base64, 'base64');
  const r = new Reader(buf);
  return decodeMessage(r, buf.length, 'GetWebStandardEventsResponse') as PbEventsResponse;
}
