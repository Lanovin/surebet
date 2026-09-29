# Sazka / Allwyn (`sazka`)

Web: <https://www.sazka.cz/kurzove-sazky> → 301 → <https://www.allwyn.cz/kurzove-sazky>.
Platforma: **OpenBet "engage"** (Sportsbook API za Azure API Management `apigw.allwyn.cz`, push
`ob-push-engage-prod.allwyn.cz`), frontend Vue ("sazkabet"). Před webem i API je **Akamai**
(Bot Manager, cookies `_abck`, `bm_sz`, `ak_bmsc`) a u API ještě Cloudflare.

## Strategie

| level | název | scope | stav |
|---|---|---|---|
| 2 | `openbet-api` | prematch + live | ✅ funguje přes čistý Node fetch (bez cookies) |
| 3 | `openbet-push` | live (`subscribe()`) | ✅ REST snapshot + websocket delty |
| 5 | fetch v prohlížeči | – | ❌ vynecháno: headless Chromium dostává od Akamai 403 „Access Denied“ |

### Měření (28. 9. 2026 večer)

| | požadavky | data (raw / gzip) | latence |
|---|---|---|---|
| prematch (4 sporty, detail pro 160 nejbližších zápasů do 24 h) | 4 listing + 4 detail | ~7,5 MB / ~0,8 MB | 5–8 s (fotbalový listing 2–6 s) |
| live (≈20–25 zápasů) | 1 listing + 1 detail (po 40 ID) | ~0,74 MB / ~50 kB | 0,8 s |
| push | 1 websocket; REST listing á 10 s, plný resync á 60 s, detail „dirty“ zápasů á ≥2 s | ~1 200 zpráv / min při 20 zápasech | emit ≤ 250 ms po změně |

Prematch výsledek: ~820 zápasů (fotbal ~420, tenis ~250, hokej ~110, basket ~50), ~4 100 trhů.

## Endpointy

Základ `https://apigw.allwyn.cz/openbet`, hlavičky (bez cookies):

```
Ocp-Apim-Subscription-Key: 6fdc6e24bfcb438bac06efb0f1488534   # veřejný, z HTML: appSettings["Integrations:SAG:SubscriptionKey"]
X-Accept-Language: cs-CZ
x-ob-channel: I
Origin: https://www.allwyn.cz            # (CORS; bez něj taky funguje)
```

| účel | URL |
|---|---|
| listing prematch sportu | `/orchestrations/sazkaEventsDrilldownList?drilldownTagIds=<sportId>&eventState=OPEN_EVENT` |
| listing fotbal + DNB | `…&marketGroupTypesIncluded=CUSTOM_GROUP,DRAW_NO_BET&marketsSortsIncluded=MR,HL,--,DC,DN` |
| listing live (všechny 4 sporty) | `/orchestrations/sazkaEventsDrilldownList?drilldownTagIds=11,12,5,8&liveNowOrSoon=true&_=<ms>` |
| detail (všechny trhy, víc zápasů) | `/orchestrations/sazkaEventsDrilldownDetail?eventIds=<id,id,…>` (≤ 40–50 ID) |
| strom sportů/lig | `/content-service/q/sazka-drilldown-nodes` |
| počty live po sportech (health) | `/content-service/q/sazka-sports?eventState=LIVE_EVENT` |

Sport ID (drilldown level 2): fotbal `11`, tenis `12`, basket `5`, lední hokej `8` (kód `ice-hockey`;
kód `hockey` je **pozemní hokej**, ID 30 – ignorujeme). E-sporty mají vlastní sport `esports`.

`marketGroupTypesIncluded` bere OpenBet *market group* kódy (`CUSTOM_GROUP`, `DRAW_NO_BET`,
`DOUBLE_CHANCE`, …), ne `groupCode` trhu; neplatný kód → HTTP 500 `errorCode 72`. Bez parametru
listing vrací „hlavní“ trhy (CUSTOM_GROUP). Parametr `groupedMarkets=true` vrací webem
seskupené trhy – **nepoužíváme**, bereme surové `markets[]` (mají přesné názvy vč. „(60 minut)“).

### Cache Akamai – důležité

Odpovědi API jsou **cachované podle URL ~30–60 s** (hlavička `X-Created-At` = kdy odpověď vznikla,
`Date` je aktuální). Request hlavičky `Cache-Control`/`Pragma` se ignorují. Unikátní parametr
`_=<ms>` cache obejde (ověřeno: `X-Created-At` ≈ teď). Proto:

* live listing/detail vždy s `_=<ms>`;
* prematch bez cache-busteru (šetrnější; data ≤ 60 s staré), `fetchedAt` = nejstarší `X-Created-At`.

Bez cache-busteru se live REST lišil od push stavu u ~40 % trhů; s ním 220/220 shodných.

## Formát dat

`data.events[]`: `id`, `name` („Česko - Anglie“), `startTime` (ISO), `liveNow`, `started`,
`sortCode` (`MTCH` = zápas; speciály jiné), `teams[{name, side: HOME|AWAY}]`,
`drilldownNodes[]` (level 4 = liga, 3 = země/region, 2 = sport), `commentary` (stav), `markets[]`.

Trh: `groupCode` (např. `MATCH_RESULT`, `TOTAL_GOALS_OVER/UNDER_NO_OT`), `name`, `status`
(`ACTIVE`/`SUSPENDED`), `displayed`, `outcomes[]` → `subType` (H/D/A, H=nad/L=pod), `status`,
`prices[0].decimal`, `prices[0].handicapLow/High` (linie z pohledu **daného výběru**).
`market.handicapValue` je u asijských trhů kódovaný index (10, 12…), ne linie → linie vždy z outcome.

### Mapování trhů (parse.ts `RULES`)

* **fotbal**: `MATCH_RESULT` 1X2|REG, `NO_BET_DRAW` DNB, `TOTAL_GOALS_OVER/UNDER(_ASIAN)` OU,
  `ASIAN_HANDICAP` AH, `BOTH_TEAMS_TO_SCORE` BTTS, `_HOME/_AWAY` týmové totaly, varianty
  `_1ST_HALF`/`_2ND_HALF` → H1/H2. `MATCH_RESULT_2` („Mega kurz – jen AKO 3+“) **vynechán**.
* **hokej**: `MATCH_RESULT_NO_OVERTIME` 1X2|REG, `MONEY_LINE` („do rozhodnutí“) ML|MATCH,
  `DRAW_NO_BET` DNB|REG, `TOTAL_GOALS_OVER/UNDER` = „Počet gólů **do rozhodnutí**“ → OU|MATCH,
  `TOTAL_GOALS_OVER/UNDER_NO_OT` „(60 minut)“ → OU|REG, `HANDICAP_2_WAY` „(60 minut)“ AH|REG,
  `HANDICAP_2_WAY_INC_OT_PENS` AH|MATCH, týmové totaly obojí, třetiny P1–P3 (1X2, OU, AH, DNB,
  BTTS). Rozsah se u nejasných kódů bere z názvu (`do rozhodnutí` → MATCH, `60 minut` → REG), jinak
  se trh vynechá. `BOTH_TEAMS_TO_SCORE` (celý zápas) vynechán – nejasné, zda vč. prodloužení.
* **basket**: `MONEY_LINE` ML|MATCH, `MATCH_RESULT` 1X2|REG (3-cestný), `HANDICAP_2_WAY` /
  `TOTAL_POINTS_OVER/UNDER` „(včetně prodloužení)“ → MATCH, 1. poločas / 1. čtvrtina.
* **tenis**: `MATCH_WINNER` ML, `TOTAL_GAMES_OVER/UNDER` OU (gemy), `GAME_HANDICAP` AH (gemy),
  `SET_HANDICAP` AH_SETS, `TOTAL_SETS_OVER/UNDER` OU_SETS, `SET_WINNER_NTH_SET` ML|S{n},
  `TOTAL_GAMES_OVER/UNDER_NTH_SET` OU|S{n}, týmové totaly gemů.
* Linie: jen x.0 a x.5 (čtvrtinové asijské vynechány), AH musí mít zrcadlové linie.
  Pozn.: Sazka někdy nabízí stejnou cenu pro „60 minut“ i „do rozhodnutí“ na stejné linii – to je
  jejich nabídka, ne chyba parseru.

## Live stav a přestávky (`commentary`)

`commentary.participants[{id, roleCode}]`, `facts[{type: SCORE, value, participantId}]` (skóre),
`periods[]` – každá perioda `type`, `startTime`, `status` (`FINISHED` / ""), `clock {offset,
lastUpdate, state: RUNNING|COUNTING_DOWN|STOPPED}`, `facts` (skóre periody), u tenisu vnořené `GAME`.

* **fotbal**: periody `FIRST_HALF`, `HALF_TIME`, `SECOND_HALF` (+ prodloužení/penalty).
  **Poločas** = poslední začatá perioda je `HALF_TIME` (zůstává v seznamu i po začátku 2. poločasu,
  proto rozhoduje `startTime`), nebo `SECOND_HALF` už založený, ale stojí na 0. `statusText` = typ
  periody, `breakFlag`, `clockRunning:false`. `clockSec` = 2700·(poločas−1) + offset + čas od
  `lastUpdate` (offset je u reálných zápasů relativní k poločasu, u některých feedů absolutní –
  např. 5400 po konci zápasu – vybírá se varianta bližší času od startu periody).
* **hokej / basket**: `PERIOD_1..3` / `QUARTER_1..4`, `OVERTIME`, `SHOOTOUT`; hodiny jsou
  **odpočet** – `offset` = zbývající sekundy periody k `lastUpdate`, `state` `COUNTING_DOWN` = běží
  (v push `sCLOCK` písmeno `C`), `STOPPED` = stojí (`S`) → `periodRemainingSec`, `clockRunning`.
  **Přestávka** (`breakFlag`): (a) perioda `FINISHED` a další neexistuje, (b) odpočet stojí na 0 a
  není to poslední základní perioda, (c) další perioda je už založená, ale stojí na plné délce
  (600/720/1200/300 s) a hodiny od založení nikdo neposunul (`lastUpdate` ≈ `startTime`), (d) basket: poločas je samostatná perioda `HALF_TIME` (ověřeno v push i REST).
  Ověřeno na e-basketbalu (stejná OpenBet struktura, feed eSports Battle): Q2 doběhla na 0 →
  `sCLOCK HALF_TIME` → Q3 `COUNTING_DOWN`. Reálný hokej/basket v době vývoje live nebyl.
* **tenis**: `SET` periody (`periodIndex`) nemají status → `periodScores` = gemy setů, `games` =
  aktuální set, `points` z `DISPLAY_SCORE` posledního gemu („60“ = gem dohrán → „0:0“),
  `score` = sety. **Přestávka mezi sety** = gemy aktuálního setu tvoří dohraný set (6:x o 2, 7:5,
  7:6) a zápas neskončil (`MAX_SETS`) → `breakFlag`, `statusText` „SET_n:FINISHED“.

## Push websocket (L3)

`wss://ob-push-engage-prod.allwyn.cz/websock`, subprotokol `v1.push.openbet.com`, hlavička
`Origin: https://www.allwyn.cz`, **anonymně bez tokenu**. Protokol (z bundlu webu):

```
connect      C02P0000                                    (host, prázdný token)
subscribe    S<count:4><typ(6) + "="*16 + id(10)>…!!!!!!!!!!      např. S0001SEVENT================0004245369!!!!!!!!!!
unsubscribe  U<count:4><kanály>
ping / pong  p0001 / g0001                               (každých 15 s)
zpráva       M<kanál 32><msgId 10><user "G" | "U"+10><subjekt typ 6 + id 10><size 12><JSON>
```

Kanál `SEVENT<id>` = událost se všemi potomky. Subjekty: `sPRICE` (id výběru; `potentialPayout[WIN]`
nebo `lp_num/lp_den`), `sSELCN` (výběr: `status` A/S, `displayed` Y/N, cena), `sEVMKT` (trh: `status`,
`displayed`, `names.cs`, `raw_hcap`), `sCLOCK` (id události: `period_code` (`ALL` = celý zápas – ignorujeme), `offset`, `state`
R běží / C odpočet běží / S stojí, `last_update`), `sSCORE`/`sEVENT` (formát neověřen → REST detail dané události). Neznámý
trh/výběr/perioda → „dirty“ → REST detail (cache-bust) max. 40 zápasů / 2 s. Po připojení server
pošle dávku posledních zpráv; shoda s čerstvým REST ověřena (220/220 trhů).

## Co nefunguje / rizika

* **Headless Chromium** (i s běžným UA) → `www.allwyn.cz` vrací **403 „Access Denied“** (Akamai),
  CORS preflight na API pak selže → L5 nepoužitelný. Node fetch s běžným UA zatím prochází;
  kdyby Akamai zpřísnil pravidla i pro API, zkusit nejdřív zpomalit, pak cookies `_abck/bm_sz`
  z odpovědí (HttpClient je ukládá sám).
* Klíč `Ocp-Apim-Subscription-Key` se může změnit → vzít nový z HTML
  `https://www.allwyn.cz/kurzove-sazky` (`"Integrations:SAG:SubscriptionKey":"…"`).
* Pomalý fotbalový prematch listing (2–6 s, ~440 zápasů, ~3 MB JSON).
* Limity nepozorovány (desítky požadavků/min bez 429).

## Oprava, když se to rozbije

1. `curl` na health URL výše s hlavičkami → 401/403? (klíč, Akamai), 500 `errorCode 72` (parametry).
2. Stáhnout HTML a JS (`/assets/sazkabet/assets/_main-*.js`, `analytics-*.js`) a hledat
   `sazkaEventsDrilldownList`, `getSagBasicApiUrl`, `Integrations:WS:BaseAddress`.
3. Změny názvů trhů: `fixtures/sazka/prematch-detail.json` + `RULES` v `parse.ts`.
