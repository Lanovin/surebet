# Sazka / Allwyn (`sazka`)

Web: <https://www.sazka.cz/kurzove-sazky> → 301 → <https://www.allwyn.cz/kurzove-sazky>.
Platforma: **OpenBet "engage"** (Sportsbook API za Azure API Management `apigw.allwyn.cz`, push
`ob-push-engage-prod.allwyn.cz`), frontend Vue ("sazkabet"). Před webem i API je **Akamai**
(Bot Manager, cookies `_abck`, `bm_sz`, `ak_bmsc`) a u API ještě Cloudflare.

## Strategie

| level | název | scope | stav |
|---|---|---|---|
| 2 | `openbet-api` | prematch + live | ✅ čistý Node fetch (bez cookies); live polling min. á 2 s (`minIntervalMs`) |
| 3 | `openbet-push` | live (`subscribe()`) | ✅ REST snapshot + websocket delty s přehráním delt po každém REST refreshi |
| 5 | fetch v prohlížeči | – | ❌ vynecháno: headless Chromium dostává od Akamai 403 „Access Denied“ |

### Měření (28. 9. 2026 večer)

| | požadavky | data (raw / gzip) | latence |
|---|---|---|---|
| prematch (4 sporty, detail pro 160 nejbližších zápasů do 24 h) | 4 listing + 4 detail (cache-bust) | ~7,5 MB / ~0,8 MB | ~5 s (30. 9.: stáří dat ~5 s; bez cache-busteru bylo 25–87 s) |
| prematch (13 sportů, od 1. 10. 2026; detail ≤ 240 zápasů, vedlejší sporty první) | **2 listingy** (fotbal + ostatních 12 sportů přes `drilldownTagIds`) + **6 detailů** = **8** (cache-bust) | ~11,2 MB | ~7–8 s (detaily sekvenčně á ~0,5 s), stáří dat ~5 s |
| live (≈20–25 zápasů) | 1 listing + 1 detail (po 40 ID) | ~0,74 MB / ~50 kB | 0,8 s |
| push | 1 websocket; REST listing á 10 s, plný snapshot á 60 s + po každém připojení, detail „dirty“ zápasů á ≥2 s (≤ 40 zápasů) | ~6 600 zpráv / min při 80 zápasech (30. 9.) | emit ≤ 250 ms po změně; REST údržba ~0,6 req/s |

Prematch výsledek: ~920 zápasů (30. 9.: fotbal 488, tenis 260, hokej 127, basket 45), ~4 900 trhů.
1. 10. 2026 (0:50, 13 sportů): 1 146 zápasů / 6 082 trhů / 13 385 kurzů (fotbal 498, tenis 271, hokej 129, MMA 60, basket 45,
box 42, házená 28, šipky 27, AF 17, baseball 12, volejbal 9, snooker 8; stolní tenis prematch v noci 0). Live: 37 zápasů
(tenis 14, fotbal 13, stolní tenis 8, baseball 1, volejbal 1), 1 listing + 1 detail (~1 MB raw, ~1 s).

**Požadavky na prematch cyklus** (runner chce všech 13 sportů): dřív 8 (4 sporty: 4 listingy + 4 detaily po 40 ID);
naivní rozšíření listingu po sportech by bylo 13 + 5 = 18; teď **8** (2 + 6), tedy stejně jako před rozšířením.
Listingy fotbal a ostatní běží souběžně, detaily sekvenčně (≤ 40 ID, `HttpClient.minIntervalMs`).

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
| listing prematch (sport, nebo víc sportů čárkou) | `/orchestrations/sazkaEventsDrilldownList?drilldownTagIds=<id>[,<id>…]&eventState=OPEN_EVENT` – 12 sportů bez fotbalu jedním požadavkem (1. 10.: stejné události i trhy jako 12 samostatných listingů) |
| listing fotbal + DC + DNB | `…&marketGroupTypesIncluded=CUSTOM_GROUP,DRAW_NO_BET&marketsSortsIncluded=MR,HL,--,DC,DN` (`marketsSortsIncluded` přidává dvojtip `DC`, `marketGroupTypesIncluded` DNB; u ostatních sportů přidá jen DNB, dvojtip házené v listingu není ani s `DC`) |
| listing live (všech 13 sportů) | `/orchestrations/sazkaEventsDrilldownList?drilldownTagIds=11,12,5,8,29,42,4,3,9,6,23,37,39&liveNowOrSoon=true&_=<ms>` |
| detail (všechny trhy, víc zápasů) | `/orchestrations/sazkaEventsDrilldownDetail?eventIds=<id,id,…>` (≤ 40–50 ID) |
| strom sportů/lig | `/content-service/q/sazka-drilldown-nodes` |
| počty live po sportech (health) | `/content-service/q/sazka-sports?eventState=LIVE_EVENT` |

Sport ID (drilldown level 2, ověřeno ve stromu `sazka-drilldown-nodes` 1. 10. 2026): fotbal `11`, tenis `12`, basket `5`,
lední hokej `8` (kód `ice-hockey`; kód `hockey` je **pozemní hokej**, ID 30 – ignorujeme), házená `29` (`handball`),
volejbal `42` (`volleyball`; plážový volejbal `18` je jiný sport – ignorujeme), baseball `4` (`baseball`), americký
fotbal `3` (`american-football`), MMA `9` (kód `ufc-mma`, na webu „Bojové sporty“: UFC, KSW, Oktagon), box `6` (`boxing`),
šipky `23` (`darts`), snooker `37` (`snooker`), stolní tenis `39` (`table-tennis`). E-sporty mají vlastní sport `esports`
(ID 24), ostatní sporty (florbal, futsal, plážový fotbal, badminton, …) nemapujeme.

`marketGroupTypesIncluded` bere OpenBet *market group* kódy (`CUSTOM_GROUP`, `DRAW_NO_BET`,
`DOUBLE_CHANCE`, …), ne `groupCode` trhu; neplatný kód → HTTP 500 `errorCode 72`. Bez parametru
listing vrací „hlavní“ trhy (CUSTOM_GROUP). Parametr `groupedMarkets=true` vrací webem
seskupené trhy – **nepoužíváme**, bereme surové `markets[]` (mají přesné názvy vč. „(60 minut)“).

### Cache před API – důležité (přeměřeno 30. 9. 2026)

Odpovědi API jsou **cachované podle URL** – ne na hraně Akamai (`server-timing: cdn-cache; desc=MISS`),
ale za ní (origin/APIM), na **více uzlech s různým stářím**. `X-Created-At` = kdy odpověď vznikla,
`Date` je aktuální. Naměřeno: stáří **0–87 s** a **nemonotónní** – stejné URL po sobě vrátilo data
staré 86,8 s → 17,5 s → 36,0 s (basket listing), detail 87,0 s → 83,6 s → 0 s. Bez ochrany tak další
poll může přinést **starší** kurzy než předchozí (kurzy „skáčou“ zpět, seenAt couvá → falešné arby).
Request hlavičky `Cache-Control`/`Pragma` se ignorují. Unikátní parametr `_=<ms>` cache obejde
(`X-Created-At` ≈ teď). Proto:

* live listing/detail vždy s `_=<ms>`;
* **prematch taky s `_=<ms>`** (`SazkaOptions.prematchCacheBust`, výchozí `true`) – stejný počet
  požadavků (8 / poll), jen je obslouží origin: poll ~5 s místo ~2,5 s, stáří dat ~5 s místo až 87 s;
* `fetchedAt` = nejstarší `X-Created-At` ze všech odpovědí pollu (skutečné stáří dat).

Bez cache-busteru se live REST lišil od push stavu u ~40 % trhů; s ním shoda (viz audit níže).

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
* **dvojtip `DC`** (1. 10. 2026, 1 231 výběrů, 0 rozporů): šablona `DOUBLE_CHANCE` („Dvojtip“; fotbal, hokej, házená), varianty
  `DOUBLE_CHANCE_1ST_HALF` / `_2ND_HALF` (fotbal), `DOUBLE_CHANCE_1ST/2ND/3RD_PERIOD` (hokej, třetiny). Výběry mají `subType`
  **1 = „Domácí nebo Remíza“ (1X), 2 = „Remíza nebo Hosté“ (X2), 3 = „Domácí nebo Hosté“ (12)** – pozor, „2“ není 12;
  mapování kontroluje i název (při rozporu trh zahodí). Rozsah = rozsah 3-cestného výsledku téhož úseku (hokej `DOUBLE_CHANCE` =
  60 minut; ceny DC ≈ 1X2 stejného rozsahu s odchylkou ≤ 2 % u 400+ trhů, větší u velkých favoritů jen kvůli maržím/zaokrouhlení
  cen ~1.03–1.15). Sazka občas skryje výběr → neúplný DC se bere (sám o sobě arb netvoří). „Dvojitý výsledek“ (`DOUBLE_RESULT*`,
  poločas/zápas) je jiný trh a nemapuje se. Házená: `DOUBLE_CHANCE` ověřen (24 zápasů), poločasové kódy `_1ST_HALF/_2ND_HALF`
  jsou převzaté z fotbalu (v nočním vzorku házené nebyly). Dvojtip mají jen fotbal, hokej, házená – AF, baseball, box, MMA
  ho v nabídce nemají.
* **další sporty** (1. 10. 2026, herní plán kurzových sázek 17.2 a): bez uvedení rozsahu platí normální hrací doba; 18.7: u setových
  sportů jiný formát než vypsaný = kurz 1,00; 16.1 f: změna nadhazovačů u baseballu = kurz 1,00):

| sport | namapováno (groupCode → klíč) | pozn. |
|---|---|---|
| házená | `MATCH_RESULT` 1X2\|REG, `DOUBLE_CHANCE` DC\|REG, `DRAW_NO_BET` DNB\|REG, `TOTAL_GOALS_OVER/UNDER` („Góly pod/nad“) OU\|REG, `HANDICAP_2_WAY` AH\|REG, týmové totaly OU_HOME/OU_AWAY\|REG, `MATCH_RESULT_1ST_HALF` 1X2\|H1, `DRAW_NO_BET_1ST_HALF` DNB\|H1, `TOTAL_GOALS_OVER/UNDER_1ST_HALF` OU\|H1 | vše 60 min (REG): AH +1.5/+2.5/+3.5 domácích, AH ≈ DC (+0.5 ≈ 1X); „vč. prodloužení“ Sazka pro házenou nevypisuje |
| volejbal | `MATCH_WINNER` ML\|MATCH, `SET_WINNER_NTH` / `SET_WINNER_<FIRST…FIFTH>_SET` ML\|Sn, `TOTAL_POINTS_OVER/UNDER` („Body: pod/nad“) OU\|MATCH, `MATCH_WINNER_POINT_HANDICAP` („Body: handicap“) AH\|MATCH, `MATCH_WINNER_SET_HANDICAP` („Sety: handicap“, −2.5 = 3:0) AH_SETS\|MATCH, `TOTAL_SETS_OVER/UNDER` OU_SETS\|MATCH, `SET_WINNER_<n>_SET_HANDICAP` AH\|Sn, `TOTAL_POINTS_OVER/UNDER_<n>_SET` OU\|Sn | číslo setu z názvu („2.set: …“); live handicap setů počítá dosavadní skóre (0:2 → „Sety +2.5“ = výhra 3. setu, stejná cena jako „3.set: vítěz“). Nemapováno: přesný výsledek, extra body, zlatý set (celá událost se zahodí) |
| baseball | `MONEY_LINE` („Vítěz zápasu do rozhodnutí“, vč. extra směn) ML\|MATCH, `HANDICAP_2_WAY` („Body: handicap“) AH\|MATCH, `TOTAL_RUNS_OVER/UNDER(_HOME/_AWAY)` OU/OU_HOME/OU_AWAY\|MATCH, `TOTAL_RUNS_ODD_EVEN` OE\|MATCH, `MATCH_RESULT_3_WAY` („Výsledek zápasu (9 směn)“, jen NPB/KBO) 1X2\|REG | `FIRST_5_INNINGS_*`, `MONEY_LINE_1ST_5_INNINGS`, „N. směna“, „Extra směna“, „První dosáhne N bodů“, „Tým skóruje první“, hráčské trhy vynechány (pojistka v `NAME_BLACKLIST`). Sazka zatím uvádí zápasy **bez nadhazovačů** → trhy „jen s nadhazovači“ neexistují; kdyby se v názvu týmů objevily závorky / „nadhazovač“, celá událost se zahodí |
| americký fotbal | `MATCH_RESULT_NORMAL_TIME` („Výsledek zápasu“, 3-cestný, remíza ~5 %) 1X2\|REG, `HANDICAP_2_WAY` „(včetně prodloužení)“ AH\|MATCH, `MATCH_RESULT_1ST_HALF_3_WAY` 1X2\|H1, `TOTAL_POINTS_OVER/UNDER_1ST_HALF` OU\|H1, `HANDICAP_HALF-TIME_2_WAY` AH\|H1 | **vynecháno**: `MONEY_LINE` („do rozhodnutí“ – NFL remíza po prodloužení, herní plán nic neříká o vrácení vkladu), `TOTAL_POINTS_OVER/UNDER(_HOME/_AWAY)` bez uvedení rozsahu (podle 17.2 a) normální doba, u NFL zvykově vč. prodloužení → nejasné), touchdowny, field goals, hráčské trhy |
| MMA | `SB_FIGHT_WINNER_3WAY` („Výsledek zápasu“: bojovník / Remíza / bojovník) 1X2\|REG | jiný trh Sazka u MMA nenabízí; výběry bez `subType` → podle jmen |
| box | `FIGHT_WINNER` („Výsledek zápasu“, s remízou) 1X2\|REG, `FIGHT_WINNER_2_WAY` („Vítěz zápasu“) DNB\|REG | **DNB bez výslovného textu pravidla** (API nemá popis, herní plán o remíze u boxu mlčí) – odvozeno z cen: u 7/7 zápasů mají obě strany 2-cestného trhu nižší kurz než ve 3-cestném (1.04 vs 1.08, 8.5 vs 9.0) a normované pravděpodobnosti sedí na poměr bez remízy z 1X2 (±0.01, viz test) = remíza vrací vklad. Kdyby se to ukázalo jako mylné, smazat řádek `FIGHT_WINNER_2_WAY` v `RULES.boxing`. Počet kol, způsob výhry, „plný počet kol“ vynechány |
| šipky | `MATCH_RESULT_2_WAY` ML\|MATCH, `LEG_TOTAL_OVER/UNDER` („Legy 5.5“) OU\|MATCH (legy), `TOTAL_SETS_OVER/UNDER` OU_SETS\|MATCH, `HANDICAP_2_WAY` („Zápas handicap“) AH_SETS\|MATCH **jen v zápase na sety** | handicap je na SETY: −1.5 = výhra o 2 sety; ověřeno proti „Přesný výsledek (sety)“ u 4/4 zápasů (P(−1.5) 0.42–0.53 vs ceny). Zápas na sety = událost má trh s `SET` v groupCode (`TOTAL_SETS…`, `CORRECT_SCORE_SET`) nebo periody `SET`; v zápase na legy handicap nemáme ověřený → nemapuje se. 180, zavření, „Více 180“ vynecháno |
| snooker | `MATCH_RESULT` ML\|MATCH, `HANDICAP_2_WAY` („Zápas handicap“, framy) AH\|MATCH, `TOTAL_FRAMES_OVER/UNDER` OU\|MATCH | AH +0.5 domácích = cena ML domácích (±4 %), +1.5 níž; „Přesný výsledek“ vynechán |
| stolní tenis | `MATCH_RESULT` ML\|MATCH, `HANDICAP_2_WAY_MATCH_GAMES` („Handicap setů“) AH_SETS\|MATCH, `TOTAL_POINTS_OVER/UNDER` („Body: pod/nad“) OU\|MATCH, `GAME_X_WINNER` ML\|Sn, `TOTAL_POINTS_OVER/UNDER_NTH_GAME` OU\|Sn, `HANDICAP_2_WAY_NTH_GAME` („3. Game Handicap 2-Way −2.5“, body setu) AH\|Sn | prematch zápasy mají před začátkem jen „Vítěz zápasu“; vše ostatní až live. Live AH/OU/ML počítají stav (8:7 v setu, 0:2 na sety). Vynecháno: „první dosáhne N bodů“, „získá N. bod“, lichý/sudý, extra body, přesný výsledek, týmové body setu |

* **live** (30. 9. ověřeno na 81 zápasech, šablona po šabloně): live používá stejné `groupCode` a
  názvy jako prematch; AH/OU jsou na **skóre celého zápasu** (vstřelené góly/body/gemy se počítají –
  např. 0:3 v 61': „Handicap 2.5“ Leicester +2.5 @3.65, O3.5 @1.29), periodové trhy jen na danou
  periodu. Navíc jen live: hokej `PERIOD_WINNER_NTH_PERIOD` („2. třetina: vítěz“, 3 výběry bez subType)
  → 1X2|P{n}, `PERIOD_HANDICAP_2_WAY_NTH_PERIOD` → AH|P{n}, `BOTH_TEAMS_TO_SCORE_CURRENT_PERIOD`
  („Oba dají gól 2. třetina“) → BTTS|P{n}; basket `TOTAL_POINTS_OVER/UNDER_2ND/3RD_QUARTER` a
  `HANDICAP_2_WAY_2ND/3RD_QUARTER` → OU/AH|Q2–Q3 (4. čtvrtina OU/AH a basket H2 vynechány – nejisté,
  zda vč. prodloužení). **Nemapuje se**: „Výsledek/Handicap/Góly pod/nad po X minutách“
  (`*_AFTER_30/60/75_MINS`), „X. Gól“ (`GOALSCORER_TEAM_NEXT*`), „Handicap s remízou“ (evropský),
  „Postup“, race-to, Mega kurz (jen AKO), kombinace, hráčské trhy.
* Pojistka `NAME_BLACKLIST` v `mapMarket`: název se „zbytek/zbývající“, „po N minut“, „N. gól“,
  „s remízou“, „postup“, „přesný“, „Mega kurz/ako“, „první dosáhne“… se nikdy nenamapuje, i kdyby
  měl mapovaný `groupCode` (obrana proti náhradním šablonám typu Kingsbet). Žádný z 6 550 dnes
  mapovaných trhů (live + prematch vzorky) ji nespouští.
* Orientace ověřena: `subType` H/A výběru = `teams[].side` (2 695 kontrol, 0 rozporů), výběry bez
  subType se párují jménem (369/369).
* Kurzy: `prices[0].decimal` = přesně `1 + numerator/denominator` zaokrouhleno na 2 místa (žebříček
  Sazky je ve zlomcích s přesnými 2 desetinnými místy, 83/100 = 1.83); jediný rozdíl jsou kurzy pod
  1.01 (1/125: REST `1`, push `1.008`) – push se zaokrouhluje stejně jako REST, validace je zahodí.
* Hokej `TOTAL_GOALS_OVER/UNDER` má dvě pojmenování podle ligy: „Počet gólů do rozhodnutí X“ (NHL)
  a „Góly pod/nad (do rozhodnutí) X“ (ČR…) – obojí vč. prodloužení a nájezdů (O6.5 NHL 2.10 vs
  60 min 2.40) → OU|MATCH. AH ±1.5 a víc je pro 60 min i „do rozhodnutí“ fakticky stejná sázka
  (prodloužení/nájezdy končí o 1 gól), proto tam Sazka mívá stejné ceny.
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
  (600/720/1200/300 s) a hodiny od založení nikdo neposunul (`lastUpdate` ≈ `startTime`), (d) basket: poločas je samostatná perioda `HALF_TIME` (ověřeno v push i REST),
  (e) konec 3. třetiny / 4. čtvrtiny (nebo prodloužení) **za nerozhodného stavu** = přestávka před
  prodloužením/nájezdy; prodloužení skončené s vítězem už přestávka není (konec zápasu).
  Ověřeno živě 30. 9. (hokej 3 zápasy, basket 14: intermise, poločas `HALF_TIME`, konce čtvrtin).
  Ověřeno na e-basketbalu (stejná OpenBet struktura, feed eSports Battle): Q2 doběhla na 0 →
  `sCLOCK HALF_TIME` → Q3 `COUNTING_DOWN`.
* **tenis**: `SET` periody (`periodIndex`) nemají status → `periodScores` = gemy setů, `games` =
  aktuální set, `points` z `DISPLAY_SCORE` posledního gemu („60“ = gem dohrán → „0:0“),
  `score` = sety. **Přestávka mezi sety** = gemy aktuálního setu tvoří dohraný set (6:x o 2, 7:5,
  7:6) a zápas neskončil (`MAX_SETS`) → `breakFlag`, `statusText` „SET_n:FINISHED“.

* **házená, americký fotbal** (bez živého vzorku v době ověření – struktura podle scoreboard konfigurace webu, `_main-*.js`
  `Rm`: házená = `mm`: `FIRST_HALF`/`SECOND_HALF`, 30 min, `ClockOffset` vzestupně v rámci poločasu, prodloužení
  `FIRST/SECOND_OVERTIME` 60'/65'; AF = `ym` = basket: `QUARTER_1..4` + `OVERTIME`, odpočet): stejná logika jako fotbal
  (`HB_ORDER`, báze 1800 s) a basket (AF: odpočet, přestávka po čtvrtině, remíza po 4. čtvrtině = přestávka před prodloužením);
  pokryto syntetickými testy, **ne živým zápasem**.
* **volejbal, stolní tenis**: `SET` periody (`periodIndex`), **bez hodin i bez statusu** (feed drží `STOPPED`, `status` prázdný)
  → `score` = sety, `periodScores` = body setů (podle `participantId`, pořadí faktů je náhodné), `period`/`statusText`
  `SET_n`. Přestávka mezi sety **není v datech** – `breakFlag` jen když perioda má `status: FINISHED` (a zápas není rozhodnut;
  počet vítězných setů: volejbal 3, stolní tenis z faktu `MAX_SETS`) nebo existuje perioda `*_BREAK`/`HALF_TIME`; jinak se
  nevymýšlí (heuristika „25 bodů + rozdíl 2“ by byla pro jiné formáty nebezpečná). Pozorováno 1. 10.: skóre poslední setu občas
  chvíli před skóre zápasu (set 25:19 při stavu 0:2 na sety) – je to feed.
* **baseball**: `INNINGS` periody s `periodIndex` (ne `INNINGS_n`; parser umí obojí), `periodScores` = body směn (podle
  `participantId`), fakt `BATTING` HOME/AWAY (kdo pálí) nepoužíváme (`GameState` nemá kam). Bez hodin, bez přestávky.
* **šipky, snooker**: periody `SET` (vnořené `LEG`) / `LEG` / `FRAME`; šipky na sety → `score` = sety, `periodScores` = legy
  setů; na legy → `score` = legy; snooker `FRAME_n` + skóre framů. Bez živého vzorku (syntetické testy, struktura podle webu:
  šipky = `Sets` + `Throw`, snooker = `Generic`/„frame“).
* **MMA, box**: web pro ně nemá scoreboard, live nenabízejí (tabulka lhůt herního plánu: live „–“) → jen skóre, žádná přestávka.

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
`displayed`, `names.cs`, `mkt_code` = `groupCode`, `raw_hcap`, `bet_in_run`), `sCLOCK` (id události:
`period_code` (`ALL`/`GAME`/`POINT` ignorujeme), `offset`, `state` R běží / C odpočet běží / S stojí,
`last_update`). `sSCORE`/`sEVENT` za 40 min živého provozu (~80 zápasů) **nepřišla ani jedna** → skóre
a periody jdou jen přes REST (listing á 10 s, detail „dirty“ zápasů); `sEVENT` se statusem `S` se
přesto aplikuje hned (+ REST detail).

Pozorování 30. 9. 2026:

* Nová linie = **nový trh (nové ID)**; posun linie na stejném ID nenastal (0 z 25 538 `sEVMKT`).
  Skrytí linie = `sEVMKT st=S disp=N` (REST pak trh vůbec nevrací).
* REST vrací jen zobrazené výběry/trhy a výběry vždy se `status: ACTIVE`; `active` je **efektivní**
  stav (suspendovaný trh → `active:false` na trhu i výběrech). Push nese vlastní `status` → push
  kód udržuje `active` spolu se `status` (dřív trh suspendovaný v REST snapshotu zůstal po push
  znovuotevření navždy zavřený – 97 případů na 12 porovnáních).
* Úvodní dávka po subscribe (`!!!!!!!!!!` = od začátku) je **ocas historie kanálu**, ne úplný stav
  (u 21 trhů přišlo 5 `sEVMKT`) → REST snapshot je nutný. ID zpráv jsou globální, ale napříč kanály
  jen přibližně seřazená (drobné inverze), proto se podle nich nefiltruje.
* Server občas trh znovuotevře **bez** `sEVMKT st=A` (po gólu dostaly st=A ostatní trhy, „Oba dají gól“
  ne, ceny mu chodily dál, REST ho měl ACTIVE) → cena/výběr pro u nás suspendovaný mapovaný trh =
  „dirty“ → REST detail do ~2 s (dřív až do plného snapshotu).
* REST odpověď bývá o ~0,2 s **před** push (změna je v REST dřív, než dorazí zpráva).

Údržba stavu (`PushState` + jedna smyčka v `SazkaPushStrategy.subscribe`, nikdy dva REST souběžně):

1. **Přehrání delt po REST refreshi** (hlavní oprava 30. 9.): REST odpověď vzniká v čase T
   (`X-Created-At`), do stavu se dostane o 0,3–1 s později; delty přijaté mezitím se prostým
   nahrazením události ztrácely → zastaralé ceny a skryté linie „otevřené“ až do další změny / 60 s
   snapshotu. Teď se všechny přijaté zprávy drží 15 s a po každém nahrazení se přehrají ty přijaté od
   `min(T, start požadavku) − 3 s` (idempotentní, v pořadí).
2. **Detail je autoritativní**: trhy, které v čerstvém detailu chybí, zmizí (dřív se ze starého stavu
   / listingu doplňovaly a zůstávaly „otevřené“).
3. Plný snapshot: listing → subscribe nových kanálů → detail všech → nahrazení + přehrání. Pořadí
   subscribe → detail zaručí, že delty po vzniku detailu jsou v bufferu. Á 60 s a po každém připojení.
4. Listing á 10 s: nové/skončené zápasy (nové dotáhne detailem), u známých jen stav události a
   `commentary` (skóre, periody) + přehrání `sCLOCK`.
5. „Dirty“ zápasy (nový mapovaný trh, nový výběr, nová perioda, cena suspendovaného trhu) → detail
   max. 40 zápasů á ≥ 2 s. Zprávy ke skrytým výběrům (`disp=N`) a k trhům s nemapovaným `mkt_code`
   resync nevyvolávají (dřív byl „dirty“ skoro každý zápas – nové linie gemů/bodů každých pár sekund).
6. Spojení: ping á 15 s; 35 s bez jediné zprávy (ani pong) → `terminate` + reconnect; po každém
   (znovu)připojení plný snapshot a **do jeho dokončení se neemituje** (chyběly by delty z výpadku –
   runner po 15 s ticha přepne na polling, detektor mezitím nohy sazky nechá zestárnout).
   `fetchedAt` emitu = čas emitu, jen když je websocket živý a bez mezery.

Audit 30. 9. 2026 (21:25–22:55, 30–80 živých zápasů, všechny 4 sporty): skutečná
`SazkaPushStrategy.subscribe()` porovnaná s nezávislým REST snapshotem (cache-bust) v čase
`X-Created-At + 1,5 s`; rozdíl se počítá jako „časový šum“, když k trhu přišla push zpráva ±3 s.

| | porovnání | trhů | špatná cena | zastaralý OTEVŘENÝ trh | zavřený, ač otevřený | chybějící |
|---|---|---|---|---|---|---|
| před opravou | 12 | ~7 400 | 93 | 91 | 97 | 13 |
| po opravě | 20 | ~10 150 | 1 | 0 | 2 | 1 |
| po opravě (22:50, finální kód) | 4 | ~880 | 0 | 0 | 0 | 0 |

(Příklady před opravou: tenis ML|S1 push 1.83/1.87 vs web 2.35/1.5 – zpráva z 19:39:14.6 ztracená
během REST resyncu; AH|MATCH|-2.5 push 1.83/1.8 vs web 1.25/3.4.) Zbylé rozdíly po opravě =
znovuotevření bez `st=A` (konzervativní, opraveno heuristikou výše) a 1 cena na hraně okna.

### Identita událostí a čas začátku

* Live používá **stejné ID události** jako prematch (live zápasy jsou i v prematch listingu
  `eventState=OPEN_EVENT` s `liveNow:true, started:true`) – párování `(sazka, sourceId)` z prematch
  platí i pro live.
* `startTime` je v live i prematch **plánovaný** čas (týmové sporty: 17:30:00Z, skutečný výkop
  17:30–17:45); u tenisu ho Sazka občas přepíše na přibližný skutečný začátek (12:31:00Z,
  18:34:33Z). Skutečný začátek je jen v `commentary.periods[0].startTime` (FIRST_HALF / PERIOD_1 /
  QUARTER_1 / SET 1).
* Počet live zápasů = počty webu (`sazka-sports?eventState=LIVE_EVENT`: fotbal 21, hokej 3, tenis 24,
  basket 13 = listing 21/3/24/13).

### Ověření rozšíření (1. 10. 2026 ~00:30–01:00 CEST)

* Inventura šablon všech 9 nových sportů z listingu + detailu všech zápasů (211 prematch + 39 live) – viz tabulka mapování;
  nemapované šablony: hráčské trhy (homeruny, touchdowny, 180), přesné výsledky, race-to, způsob výhry, „prvních 5 směn“ …
* Věrnost parseru vůči REST: **13 417 výběrů** (prematch, všech 13 sportů) a 614 live výběrů: každý namapovaný výběr nalezen
  v surovém trhu podle `sourceId` + jména, stejný kurz, orientace HOME/AWAY podle `subType` **i** `teams[].side`, linie AH/OU
  z `handicapLow` shodná s klíčem – 0 rozporů. Nezávislý druhý `curl` (cache-bust) 203 zápasů nových sportů o pár minut později:
  1 283 výběrů, 0 rozdílných kurzů.
* Významová kontrola: DC vs 1X2 (fotbal 1 307 trhů, hokej, házená; odchylky v tabulce výše), DNB vs 1X2 (box 7/7 ±0.008, házená
  ±0.008), šipky AH_SETS vs „Přesný výsledek (sety)“, volejbal/stolní tenis live handicap setů = cena výhry setu, snooker AH +0.5
  ≈ ML, baseball NPB/KBO: ML „do rozhodnutí“ ≈ DNB z 3-cestného „9 směn“ (±0.01) → vč. extra směn, remíza po 9. směně ~11–14 %.
* Push (`--push=45` i vlastní audit 6× po 6 s proti čerstvému REST, 59 živých zápasů nových sportů, 1 104 výběrů): 0 trvalých
  rozdílů, 0 rozdílů stavu (skóre/perioda); přechodné rozdíly = pohyb kurzu mezi dvěma požadavky a nové linie stolního tenisu
  (resync do ~2 s).

## Co nefunguje / rizika

* **Headless Chromium** (i s běžným UA) → `www.allwyn.cz` vrací **403 „Access Denied“** (Akamai),
  CORS preflight na API pak selže → L5 nepoužitelný. Node fetch s běžným UA zatím prochází;
  kdyby Akamai zpřísnil pravidla i pro API, zkusit nejdřív zpomalit, pak cookies `_abck/bm_sz`
  z odpovědí (HttpClient je ukládá sám).
* Klíč `Ocp-Apim-Subscription-Key` se může změnit → vzít nový z HTML
  `https://www.allwyn.cz/kurzove-sazky` (`"Integrations:SAG:SubscriptionKey":"…"`).
* Pomalý fotbalový prematch listing (~2,5 s s cache-busterem, ~490 zápasů, ~3 MB JSON).
* Push: znovuotevření trhu bez `sEVMKT` se zachytí až cenovou zprávou (→ resync) nebo 60 s snapshotem;
  trh, kterému po tichém znovuotevření nechodí ceny, zůstane do snapshotu zavřený (konzervativní).
* `sSCORE`/`sEVENT` formát neověřen (nepřišly) – skóre má zpoždění až ~10 s (listing).
* Limity nepozorovány (desítky požadavků/min bez 429).
* Baseball NPB/KBO: remíza možná po 12. (NPB) / 11. směně; „Vítěz zápasu do rozhodnutí“ tam při remíze pravděpodobně vrací
  vklad (cena ≈ DNB) – ML\|MATCH je tedy bez pojistky proti té vzácné situaci (přesná četnost neověřena). OU/AH jsou při nedohrané hře
  platné od 9 odehraných směn (pravidlo 16.1 a).
* Stolní tenis a volejbal: žádná přestávka mezi sety v datech (viz výše) – detektor PAUSED se u nich opírá jen o suspendování trhů.
* Box DNB (bez výslovného textu pravidla – jen cenový důkaz, viz tabulka) a poločasové DC házené (kód převzat z fotbalu).
* Americký fotbal: v noci byly zápasy jen v týdnu NFL (16) → prematch 1X2|REG / H1 jen z detailu (okno 168 h).
* Výběr detailů (`maxDetailEvents` 240, vedlejší sporty první): hlavní sporty (fotbal/tenis/basket/hokej) jich dostanou o ~17 méně
  než dřív (143 vs 160 při limitu 8 požadavků); zápasy za oknem mají jen listing (hlavní trhy; házená bez DC/DNB/poločasů).
* Nové skryté linie stolního tenisu (live) se zachytí resyncem á ≥ 2 s – krátce po změně čáry může chybět nový trh.

## Oprava, když se to rozbije

1. `curl` na health URL výše s hlavičkami → 401/403? (klíč, Akamai), 500 `errorCode 72` (parametry).
2. Stáhnout HTML a JS (`/assets/sazkabet/assets/_main-*.js`, `analytics-*.js`) a hledat
   `sazkaEventsDrilldownList`, `getSagBasicApiUrl`, `Integrations:WS:BaseAddress`.
3. Změny názvů trhů: `fixtures/sazka/prematch-detail.json`, `prematch-dc-newsports.json`, `live-new-sports.json` + `RULES` v `parse.ts`.
