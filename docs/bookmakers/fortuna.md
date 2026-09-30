# Fortuna (ifortuna.cz)

Platforma **FEG „ufo“** (Fortuna Entertainment Group): ID typu `ufo:mtch:1wf-008`, API na
`api.ifortuna.cz`, push na `ws-offer.ifortuna.cz`, statika `cdn-offer.feg.eu`. Se sázkovkou Betano
(Kaizen Gaming – `danae-webapi`, SignalR) platformu **nesdílí** (viz `betano.md`).

API je veřejné, bez přihlášení, bez cookies a bez Cloudflare výzvy (Cloudflare jen jako CDN,
`cf-cache-status`, strukturní endpointy `s-maxage=5`). CORS povoluje `https://www.ifortuna.cz`
včetně credentials.

## Strategie

| level | name | scope | jak | požadavky / fetch | typická latence |
|---|---|---|---|---|---|
| 2 | `rest-api` | prematch + live | plain HTTP (`ctx.http`) | prematch ≈ 39 (14 výpis + 10 overview + ≤ 15 detail; před rozšířením o 9 sportů ≈ 27–29); live 2 (+ `/live/sports` a výpis jen sportů s live zápasem á 10 s, typicky 1 + 6–9) | prematch 6–9 s (při `minIntervalMs` 150 ms), live ≈ 0,2 s (s obnovou výpisu ≈ 1 s) |
| 3 | `websocket` | live | STOMP 1.2 přes SockJS websocket + REST snapshot, `subscribe()` push; plné sady trhů (`market.{id}`) pro až 40 live zápasů | 0 za emit; resync 2 + počet sportů s live zápasem (`/live/sports` + výpisy) / 30 s; detail zápasu 1× při přihlášení + á 5 min (≤ 2,5 req/s, rozestup 400 ms) | push ≈ 15–50 zpráv/s, emit max. á 300 ms, heartbeat emit á 5 s; `now − fetchedAt` p50 37 ms, p99 0,3 s |
| 5 | `browser-fetch` | prematch + live | stejné endpointy přes `ctx.browser.fetchInPage()` na stránce www.ifortuna.cz (fallback, kdyby API začalo blokovat ne-prohlížeče) | prematch ≈ 24 (bez detailů; 14 výpis + 10 overview), live 2 (+ výpis) | prematch ≈ 9 s, live ≈ 0,3 s (+ start Chromia ~4 s) |

Runner: v LIVE je `preferPush: true` (config/modes.ts), takže live jede primárně přes `websocket`
(L3) – `rest-api` / `browser-fetch` jsou záloha. Při `liveDemand = IDLE` runner volá `fetch()`
websocket strategie (stav z paměti).

Počty z 28. 9. 2026 ~23:00 (4 původní sporty): prematch 1249 událostí (fotbal 746, tenis 300, hokej 114,
basket 89), ≈ 3900 trhů; live 23 událostí (večer), 77 trhů (REST typovaný) / 47 trhů (WS výchozí sada).
Po rozšíření (1. 10. 2026, 0:30, 13 sportů): prematch 1780 událostí (fotbal 716, tenis 273, americký fotbal 148,
basket 133, stolní tenis 130, hokej 123, MMA 96, házená 51, box 42, šipky 27, volejbal 20, baseball 13, snooker 8),
5568 trhů / 12 940 kurzů, sběr ≈ 6 s; live 34–36 událostí (fotbal, tenis, basket, stolní tenis, volejbal, baseball),
WS s detaily 540–580 trhů.

## Endpointy

Základ `https://api.ifortuna.cz/offer`. Parametry polí se opakují (`fixtureIds=a&fixtureIds=b`).
Velikosti: komprimovaně (br/gzip) / raw JSON.

| účel | endpoint | poznámka |
|---|---|---|
| sporty | `/structure/api/v1_0/sports`, `/structure/api/v1_0/live/sports` | health check (1,7 kB) |
| výpis prematch | `/structure/api/v1_0/sport/{sportId}/matches?timeFilter=all&pageSize=500&page=N` | `pageSize` max 500, stránka parametrem `page` (ne `pageNumber`!). Vrací `categories`, `tournaments`, `fixtures`, `pagingInfo`. Fotbal 2 stránky (34 kB / 440 kB na stránku). Obsahuje i LIVE zápasy (`kind`) a e-sporty. |
| výpis live | `/structure/api/v1_0/live/sport/{sportId}/matches?pageSize=500` | ≈ 2 kB / 16 kB. **Sport bez jediného live zápasu vrací HTTP 404** `Structure with id ufo:sprt:0w not found` (= prázdný výpis; dřív to shodilo celý live sběr i resync websocketu). CDN `s-maxage=5` (až 5 s starý). |
| hlavní trhy (hromadně) | `/markets/api/v1_0/fixtures/markets/overview?fixtureIds=…[&marketTypeIds=ufo:mtyp:00-0u…]` | mapa `fixtureId -> Market[]`. **Jen trhy s příznakem overview.** S `marketTypeIds` vrací víc linií (fotbal OU 12 místo 5, hokej OU 3×) a jen dané typy (typy jsou sportově prefixované, lze míchat sporty v jednom požadavku). 180 zápasů ≈ 29 kB / 790 kB. URL nad ~8 kB → **HTTP 414**, proto dávky po 180 ID. |
| detail zápasu | `/markets/api/v1_0/fixture/{fixtureId}/markets` | všechny trhy; nejde filtrovat (parametry ignoruje). Velký zápas 65 kB / 1,9 MB (hráčské trhy), Euroliga 12 kB / 270 kB. |
| stav live (hromadně) | `/stats-v2/api/v2_0/miniscoreboards?fixtureIds=…` | ≈ 1 kB / 10 kB pro 35 zápasů |
| plný scoreboard | `/stats-v2/api/v2_0/fixture/{id}/scoreboard` | `eventTime` (s), `remainingTimeInPeriod`, `timerRunning`; hromadné `/scoreboards` **ignoruje filtr** a vrací všech ~15 700 zápasů (171 kB / 2 MB) – nepoužito |
| config | `https://api.ifortuna.cz/cms-client/configuration/web_global` | `miniscoreboardWebSocketUrl = https://ws-offer.ifortuna.cz/stomp` |

Stránka zápasu: `https://www.ifortuna.cz/sazeni/{sportSeoName}/{categorySeoName}/{tournamentSeoName}/{seoName}`.

### Prematch sběr (`collectPrematch`)
1. výpis pro každý z 13 sportů (14 požadavků – fotbal má 2 stránky), stránky číslované od 0 (`page=0`),
   filtr `kind=PREMATCH`, `status=ACTIVE`, bez e-sportů (a bez plážového volejbalu / zlatého setu);
2. overview v jednom proudu dávek přes všechny sporty (10 požadavků), každá dávka nese jen typy trhů sportů,
   které v ní jsou (`OVERVIEW_TYPES`; dávka ≤ 180 ID a ≤ 6 800 znaků URL – nad ≈ 7 600 vrací server 400,
   nad ≈ 8 kB 414);
3. detail pro nejbližší zápasy: hlavní sporty (fotbal, hokej, basket, tenis) okno 3 h (hokej 24 h, protože
   *vítěz vč. prodloužení* `0w-0d` má v prematch `overview:false` a v hromadném endpointu chybí), max. 45
   sledovaných; další sporty s vlastní kvótou (házená, baseball, americký fotbal, volejbal, snooker, šipky:
   okno 12 h, max. 10 zápasů, aby nevytlačily hlavní sporty); stolní tenis, MMA a box detail nedostanou (vše
   mapované je v overview; prematch zápasy stolního tenisu mají před začátkem stejně jen vítěze zápasu).
   ≤ 15 detailů na fetch (nejstarší první), obnova po 90 s, detail starší než 4 min se do výstupu nedává.
   V cache se drží jen namapovatelné typy trhů (detail velkého zápasu má 1700 trhů).
   Vypnutí/úprava: `DEFAULT_DETAIL` v `strategies.ts` (`detail: null` = jen overview).

Počet požadavků na prematch cyklus (měřeno, detail cache studená i teplá): 4 původní sporty 27 (5 + 7 + 15),
všech 13 sportů **39** (14 + 10 + 15). Runner sbírá prematch á 30–60 s, tj. ≈ 0,7–1,3 req/s.

Co je jen v detailu (tedy jen pro zápasy v okně): fotbal AH, BTTS, poločasy, týmové totaly;
hokej ML|MATCH, **DC**, DNB, handicapy, třetiny, totaly „do rozhodnutí“; basket OU|MATCH, poločasy/čtvrtiny;
tenis gemové handicapy/totaly, sety handicap/počet; házená DC/DNB/poločasy; baseball 1X2 a run line;
americký fotbal 1X2 a handicap; volejbal handicap setů/bodů. V overview je: fotbal 1X2, **DC**, DNB, OU;
hokej 1X2, OU; basket 1X2 (3-cestný), ML, AH; tenis ML, vítěz 1. setu; seznam typů per sport vrací
`/markets/api/v1_0/codebook/sport/{sportId}/overview-market-types` (`OVERVIEW_TYPES` s ním souhlasí;
`marketTypeIds` mimo overview typy hromadný endpoint nevrátí – ověřeno na `0y-01`, `0y-02`, `0y-0d`).

### Live sběr (`collectLive`)
`/live/sports` (1 požadavek) → výpis live jen pro sporty s `fixturesCount > 0` (cache 10 s; při chybě / neznámém
tvaru se ptá všech) → 1× overview (typované, všechny sporty) → 1× miniscoreboards.
Zápasy, které se objeví mezi obnovami výpisu, přibudou do 10 s. `fetchedAt` = okamžik odeslání
overview požadavku (overview i detail jsou `cf-cache-status: BYPASS`, bez Age), prematch = začátek
overview fáze (trhy z detail cache můžou být až `ttlMs` = 4 min staré – jeden `fetchedAt` na celý
výstup to nevyjádří).

## Formát

Fixture: `participants[]` s `type: HOME|AWAY` (pořadí v poli neodpovídá – vždy podle `type`),
`startDatetime` ms, `kind` PREMATCH/LIVE, `status` ACTIVE. Market: `marketTypeId`
(`ufo:mtyp:{sportCode}-{xx}`), `name` (konkrétní, s linií/periodou, občas anglicky, NBSP),
`syntheticGroupKey` (anglický klíč per trh, např. `2nd_period_-_draw_no_bet`, `1st_set`,
`handicap(incl._ot_and_decisive_so)`), `outcomes[]` s `name`, `odds`, `displayType`
(`OPEN` | `LOCKED` | `SUSPENDED` | `CLOSED`; vše kromě OPEN = `open:false`).

Sporty (`sportId` / kód; kód = prefix typů trhů `{kód}-xx` a kategorií `ufo:ctgr:{kód}-…`): fotbal `ufo:sprt:00`,
hokej `0w`, basket `0i`, tenis `0x`, házená `0y`, volejbal `0m`, baseball `0q`, americký fotbal `0g`, box `01`
(trhy `14-…`), MMA = „Bojové sporty“ `19` (trhy `19-…`, UFC `05-…`), šipky `0l`, snooker `0h`, stolní tenis `0j`.
Sporty jsou v `SPORTS_MAP` (`codes` = povolené kódy kategorií/trhů); přidat sport = přidat řádek do `SPORTS_MAP`,
`OVERVIEW_TYPES` a `DEFS` (websocket i REST ho převezmou). Nemáme: badminton `0r`, florbal `11`, futsal `0p`,
rugby `07`, kriket `0k`, pozemní hokej `0n` (nejsou v `SPORTS`).
**E-sporty** jsou pod reálnými sporty v kategoriích s cizím kódem (`ufo:ctgr:0c-00` eFotbal,
`35-00` eHokej, `0e-00` eBasketbal) a jejich trhy mají typy `0c-…`, `35-…`, `0e-…` → filtr podle
kódu kategorie + názvu turnaje (`Esports Battle`, `(4x5 min.)`).

### Mapování trhů (`DEFS` v `parse.ts`)
Výběry: `1`/`0`/`2` (1X2, ML, DNB), `10`/`12`/`02` (dvojtip = 1X / 12 / X2), `+ 2.5`/`- 2.5` (OU), `Tým (-1)` /
`1 (+0.5)` (handicap fotbal, hokej, basket, tenis) nebo bez závorek `1 -1.5` / `2+0.5` / `Pákistán -1.5` (ostatní
sporty; bez závorek musí mít linie znaménko, jinak by šlo o jméno končící číslem) – linie z pohledu domácích,
hosté musí mít opačnou, jinak se trh zahodí –, `Ano`/`Ne`, `Lichý`/`Sudý`.
Perioda se čte z `name` („2. třetiny“, „1.setu“, „1. Period“) a `syntheticGroupKey`; když si
odporují nebo chybí, trh se vynechá.

| sport | REG (základní doba) | MATCH (vč. prodl./nájezdů) | periody |
|---|---|---|---|
| fotbal | `00-00` 1X2, `00-03` DNB, `00-0u` OU, `00-0b` AH (2-cestný, asijské celé linie = vrácení), `00-1c` BTTS, `00-10`/`00-13` týmové OU | – | H1: `00-2d` 1X2, `00-2g` DNB, `00-2i` OU, `00-2h` AH, `00-2n` BTTS, `00-2m` OE, `00-2j`/`00-2k`; H2: `00-2w`, `00-2z`, `00-3b`, `00-3g`, `00-3c`/`00-3d` |
| hokej | `0w-00` 1X2, `0w-02` DNB, `0w-04` AH, `0w-05` OU, `0w-0b` BTTS, `0w-06`/`0w-08` | `0w-0d` ML „do rozhodnutí“, `0w-0e` AH, `0w-0f` OU, `0w-0g`/`0w-0h` | P1–P3: `0w-0j` 1X2, `0w-0q` DNB, `0w-0l` OU, `0w-0r` AH, `0w-0o` BTTS, `0w-0m`/`0w-0n` |
| basket | `0i-00` 1X2 (3-cestný) | `0i-04` ML, `0i-06` AH, `0i-07` OU, `0i-08`/`0i-09`, `0i-0a` OE (vše „včetně prodloužení“) | H1: `0i-0h`, `0i-0i`, `0i-0j`, `0i-0k`, `0i-0n`, `0i-0l`/`0i-0m`; Q: `0i-0b`, `0i-0c`, `0i-0e`, `0i-1b`, `0i-0o`/`0i-0p` |
| tenis | – | `0x-01` ML, `0x-02` AH (gemy), `0x-03` AH_SETS, `0x-04` OU (gemy), `0x-05`/`0x-06` OU hráčů, `0x-0i` OU_SETS | S: `0x-0e` ML, `0x-0f` AH, `0x-0g` OU |
| házená | `0y-00` 1X2, `0y-01` DC, `0y-02` DNB, `0y-04` AH, `0y-05` OU, `0y-06`/`0y-07` týmové OU, `0y-08` OE | – | H1: `0y-0c` 1X2, `0y-0d` DC, `0y-0e` DNB, `0y-0f` AH, `0y-0g` OU, `0y-0h` OE; H2: `0y-0i` 1X2, `0y-0j` DNB, `0y-0k` OE |
| volejbal | – | `0m-00` ML, `0m-01` AH_SETS, `0m-0f` OU_SETS, `0m-0a` AH (body), `0m-0b` OU (body), `0m-02`/`0m-07` týmové OU (body) | S1–S5: `0m-09` ML, `0m-0c` AH (body), `0m-0d` OU (body), `0m-0e` OE |
| baseball | `0q-00` 1X2 (9 směn, remíza = tied po 9.) | `0q-0d` ML, `0q-0f` AH (run line), `0q-0g` OU, `0q-0h`/`0q-0i` týmové OU (vše „včetně extra inningů“) | – |
| americký fotbal | `0g-00` 1X2 (60 min) | `0g-07` AH, `0g-08` OU, `0g-09`/`0g-0a` týmové OU, `0g-0b` OE (vše „včetně prodloužení“) | H1: `0g-0q` 1X2, `0g-0w` DNB, `0g-0x` AH, `0g-0y` OU; Q: `0g-0f` 1X2, `0g-0m` DNB, `0g-0n` AH, `0g-0g` OU |
| box | `14-01` 1X2 (s remízou), `14-00` DNB | – | – |
| MMA (Bojové sporty) | UFC: `05-00` 1X2, `05-02` DNB; ostatní (KSW, Oktagon, PFL, One FC, EFC, Fight Mode…): `19-00` DNB | – | – |
| šipky | – | `0l-01` ML, `0l-02` AH_SETS, `0l-04` OU_SETS, `0l-05` AH (legy), `0l-06` OU (legy) | S: `0l-03` ML, `0l-07` AH (legy), `0l-08` OU (legy) |
| snooker | – | `0h-01` ML, `0h-03` AH (framy), `0h-04` OU (framy) | – |
| stolní tenis | – | `0j-00` ML, `0j-02` AH (body), `0j-03` OU (body), `0j-0n` AH_SETS, `0j-0o` OE, `0j-0p`/`0j-0q` týmové OU (body hráče) | S1–S5: `0j-0a` ML, `0j-0b` OU (body), `0j-0c` AH (body), `0j-0d` OE |

**Dvojtip (`DC`)** – výběry `10` = HOME_DRAW, `12` = HOME_AWAY, `02` = DRAW_AWAY. Typy: fotbal `00-01` (REG; popis
„Sázka na výsledek zápasu v základní hrací době“, je v overview), `00-2f` (H1), `00-2y` (H2); hokej `0w-01` (REG =
60 min) a `0w-0t` (P1–P3, číslo třetiny z názvu); házená `0y-01`, `0y-0d` (H1). Ověřeno na kurzech: pro 11 + 8 + 1
fotbalových, 11 hokejových a 9 + 5 házenářských zápasů je 1/kurz dvojtipu ≈ součet pravděpodobností příslušných výsledků
1X2 (poměr 1.02–1.20, tj. marže; při prohozeném významu by vyšel násobně jinak). Basket (3-cestný REG, poločasy,
čtvrtiny), americký fotbal a baseball dvojtip nenabízejí.

**Ověření nových sportů (1. 10. 2026)**: každý namapovaný trh porovnán se stránkou zápasu (Playwright, `data-id` =
ID výběru) – házená, americký fotbal, baseball, volejbal, šipky, snooker, stolní tenis, MMA: 26/26, 37/37, 61/61,
28/28, 12/12, 14/14, 2/2, 2/2 kurzů shodných s API i s výstupem adaptéru; orientace (výběr `1` = `HOME`) na 2 177
výběrech podle `longName` bez jediné chyby (2 výjimky jsou zkrácená jména, ne prohození). Týmové totaly: typ trhu
odpovídá vždy stejné straně (`…-06` domácí, `…-07` hosté atd.) u všech 18 typů, 100 %.

Pravidla a důkazy za jednotlivými sporty:
* **Házená** – názvy trhů nemají „včetně prodloužení“ (na rozdíl od basketu / baseballu / amerického fotbalu), 1X2
  má remízu ⇒ vše `REG` (60 min). Vyřazovací zápasy (Liga mistrů, Super Globe) mají prodloužení, které se do těchto
  trhů nepočítá; vítěz vč. prodloužení / 7m se nenabízí. Vynecháno: výsledek/vítězný náskok `0y-03`, kombinace
  `0y-09`/`0y-0a`, poločas s nejvíce góly `0y-0b`.
* **Volejbal** – remíza neexistuje (ML, žádné 1X2). Handicap/total **bodů** (`0m-0a`, `0m-0b`, `0m-0c`, `0m-0d`) a
  **setů** (`0m-01`, `0m-0f`) jsou oddělené typy ⇒ `AH|OU` na body, `AH_SETS|OU_SETS` na sety. Vynecháno: přesný
  výsledek `0m-06`, „vyhraje alespoň set“ `0m-03`/`0m-04`, kombinace `0m-08`. Plážový volejbal a „zlatý set“
  (podle názvu turnaje / zápasu) se vyřazují celé – žádný takový zápas v nabídce nebyl, filtr je preventivní.
* **Baseball** – trhy „včetně extra inningů“ = `MATCH`. `0q-00` „Výsledek zápasu“ 1X2 = **9 směn**: pravděpodobnost
  remízy z kurzů 8–13 % ve všech ligách (MLB, NPB, KBO), a hlavně ML vítěz zápasu ≈ `P(1) + P(X)/2` u 10/10 zápasů.
  Fortuna u baseballu **nenabízí trhy závislé na nadhazovačích** (žádný trh nemá nadhazovače v názvu ani
  `specifiers`), proto se nic nevyřazuje. Vynecháno: první směna `0q-0b`, po 5. směně (`0q-0c`, `0q-0o`, `0q-0p`…),
  hity (`0q-01`…), jednotlivé směny (`0q-0t`…), kombinace, „kdo získá N. bod“, bude-li extra inning.
* **Americký fotbal** – `0g-00` 1X2 = 60 minut: remíza ≈ 5 % a ML vč. prodloužení `0g-05` ≈ `P(1) + P(X)/2` u 9/9
  zápasů. `0g-05` „Vítěz zápasu včetně prodloužení“ **nemapujeme**: nevíme, jestli se při remíze (NFL i po
  prodloužení vzácně) vrací vklad (NCAA remízu nemá) – ekvivalent poskytuje `AH|MATCH|±0.5`, které detektor
  ví použít. Vynecháno též: touchdowny, field goaly, safety, hráčské trhy (`GOALSCORER`, `COMPOUND_EXT`).
* **Box** – `14-01` „Výsledek zápasu“ (2/0/1, remíza ≈ 4 % ⇒ kurz 17–26) = `1X2|REG`; `14-00` „Vítěz zápasu“ (2
  výběry, `syntheticGroupKey: winner`) = `DNB|REG`. **Bez výslovného textu pravidla** (`marketTypeDesc` je `null`, stránka
  zápasu pravidla neukazuje) – odvozeno: stejný `winner` trh u MMA má popis „V případě remízy budou sázky vráceny“,
  kurzy odpovídají `P(1)/(P(1)+P(2))` z 1X2 (součet 1/kurz 1.08 = marže 1X2; u plain-winner bez vrácení by vyšlo
  ≈ 1.04) u 7/7 zápasů, a „Způsob vítězství“ `14-04` má výběr „Remíza“ (remíza je možná, tj. `ML` by bylo chybné). Typ `14-00` je
  u každého zápasu, `14-01` jen u hlavních (7 z 42). Vynecháno: počet kol `14-02`, „na body“ `14-03`, způsob vítězství.
* **MMA** – UFC: `05-00` „Výsledek zápasu“ (popis „Jedním z možných typů v této sázce je remíza“) = `1X2|REG`, `05-02`
  „Vítěz zápasu“ (popis „V případě remízy budou sázky vráceny“) = `DNB|REG`; ostatní organizace `19-00` „Vítěz
  zápasu“ se stejným popisem = `DNB|REG` (u nich 1X2 není). Vynecháno: počet kol, „skončí na body“, způsob vítězství,
  „vyhraje v N. kole“ a všechny kombinace.
* **Šipky** – `0l-01` „Vítěz zápasu“ (2 výběry; World Grand Prix jsou sety, „Modus Super Series“ legy) = `ML|MATCH`.
  „Handicap/počet setů“ (`0l-02`, `0l-04`) → `AH_SETS`/`OU_SETS`, „handicap/počet legů v zápasu“ (`0l-05`, `0l-06`) →
  `AH`/`OU|MATCH` (jednotka leg), v jednom zápase se kombinují jen odpovídající trhy. Sety `Sn`: vítěz setu `0l-03`,
  legy v setu `0l-07`/`0l-08`. Vynecháno: 180, nejvyšší zavření, vítěz 1. legu, kombinace. Nejistota: liga, kde
  remíza jde (Premier League apod.), by měla trh s remízou – `0l-01` je vždy 2-cestný, v aktuální nabídce žádná taková
  liga není.
* **Snooker** – `ML|MATCH`, framový handicap a počet framů (`0h-03`, `0h-04`; jednotka frame).
* **Stolní tenis** – body (`0j-02`, `0j-03`, `0j-0p`/`0j-0q`) × sety (`0j-0n` AH_SETS) oddělené typy. Sety 1–5
  (`S1–S5`); u zápasů na 4 vítězné sety (WTT, best of 7) se 6. a 7. set nemapují (perioda > 5 ⇒ vynechat).
  Prematch zápasy české Ligy Pro / TT Cupu mají do cca hodiny před začátkem **jen vítěze zápasu**; plná sada
  (handicapy/totaly bodů, sety, 180 trhů) se objeví těsně před začátkem a v live. Vynecháno: přesný výsledek, přesný
  počet setů, „kdo získá N. bod“.
* **Kódy kategorií**: box má kategorii `01-…` a trhy `14-…`, MMA kategorie `19-…` a UFC `05-…` – kategorie s jiným
  kódem (e-sport pod reálným sportem) se dál zahazují.

Vynecháno: dvojtipy mimo `DC` výše (např. „výsledek + počet“), kombinace (výsledek/počet), přesné výsledky, multigóly, „kdo dá gól“, hráčské
trhy, vítěz gamu (`0x-1s`), „vítěz se vrací při 1:2“ (`0x-3t`), evropské 3-cestné handicapy
(`00-5z`, `00-61`). Mapují se jen trhy `variant: STANDARD` (jiné varianty – `GOALSCORER`,
`COMPOUND_EXT` – mají jiná pravidla).

### Live trhy (inventář z 30. 9. 2026, ~130 live zápasů, detail + overview + WS)
Live používá **stejná ID typů a stejnou sémantiku jako prematch** – žádné náhradní trhy pod ID
výsledku (jako Altenar „next goal“ pod 1X2). Všechny live trhy měly `variant: STANDARD`,
`specifiers: null`. Ověřeno na kurzech:

* `00-00` „Výsledek zápasu“ = 1X2 základní doby (`marketTypeDesc` „…v základní hrací době“).
  „Zbytek zápasu“ je samostatný typ `00-6b` („Kdo vyhraje zbytek zápasu? za stavu 1:0“), „kdo dá
  N. gól“ `00-2s`, v 1. poločase `00-2e`, hokej `0w-0u`/`0w-0k`/`0w-3g`, zbytek zápasu hokej `0w-3h` –
  nic z toho se nemapuje.
* `00-0b` „Handicap v zápasu“ v live **počítá i už dané góly** (celý zápas): Torreense–Metalist za
  1:0 – `Torreense (-1.5)` 1.52 = „zbytek zápasu, výhra domácích“ 1.52 (overall ≥ 2 ⇔ zbytek ≥ 1);
  Defensor–Plaza za 0:1 – `Plaza (-0.5)` 1.85 = 1X2 hosté 1.85. Hokej `0w-04` stejně (Servette −2.5
  za 2:4 = 1.92). OU (`00-0u`, `0w-05`, `0i-07`, `0x-04`) = celkový počet vč. už daných.
* basket live: `0i-00` 3-cestný REG, `0i-04`/`0i-06`/`0i-07` vč. prodloužení (čtvrtinové
  `0i-0b`/`0i-0c`/`0i-1b` jen danou čtvrtinu). `0i-15`/`0i-16`/`0i-18`/`0i-19` (2. poločas
  **vč. prodloužení**) se nemapují – H2 klíč je bez prodloužení.
* orientace: výběr `1` = účastník `type: HOME` ve 34 534/34 534 výběrech (kontrola přes `longName`),
  `fixture.name` = „HOME - AWAY“.
* **overview** (REST i topic `overview-markets`) obsahuje jen *plně otevřené* hlavní trhy: trh se
  suspendovaným výběrem (`1 = 1 (SUSPENDED)`) v overview **vůbec není** a WS ho smaže (`DELETE`);
  po znovuotevření přijde `UPDATE`. Ve WS overview zprávách byly všechny výběry `OPEN`.
* **detail** (`/fixture/{id}/markets`, topic `market.{id}`) má všechny trhy vč. suspendovaných
  výběrů: `displayType: SUSPENDED` s `odds: 1` (výběr se zahodí, 1.01–1000) nebo se skutečným kurzem
  (→ `open: false`). Topic posílá změny + zhruba á 30 s celou sadu znovu.

Nové sporty v live (1. 10. 2026 0:30: stolní tenis 8, volejbal 3, baseball 1 zápas): stejná ID typů jako v prematch.
Overview (REST typovaný i WS) nese: stolní tenis ML, handicap/total bodů, vítěz setu; volejbal ML, vítěz setu, počet
bodů v zápasu/setu, počet setů; baseball ML a OU (trh se suspendovanou linií v overview chybí, takže baseball občas
bez trhů). Detail navíc: stolní tenis handicap setů, týmové totaly, OE, sety 1–5 (38 trhů na zápas), volejbal handicap
setů/bodů, baseball 1X2 a run line. Živé handicapy/totaly bodů počítají celý zápas (set), ne zbytek.

Overview typy v live: fotbal `00-00`, `00-01`, `00-03`, `00-0u`, `00-12`, `00-2s`; hokej `0w-00`,
`0w-05`, `0w-0d`, `0w-0j`; basket `0i-00`, `0i-04`, `0i-06`; tenis `0x-01`, `0x-0e`, `0x-0g`,
`0x-1s`. Detail navíc (mapované): fotbal AH `00-0b`, BTTS, týmové totaly, poločasy; hokej AH,
„do rozhodnutí“, třetiny; basket OU, týmové totaly, poločas/čtvrtiny; tenis AH/OU gemů, sety.
Na 35 live zápasech websocket s detaily ≈ 410 trhů (jen overview ≈ 100).

### Kurzy
API dává nejvýš 2 desetinná místa (0/1/2), web zobrazuje totéž se 2 místy („7.30“) – žádné
zaokrouhlování. Porovnání s webem (Playwright, `data-testing-id`/`data-id` = ID výběru):
live výpis 2 414 výběrů přesně + 16 v rámci ≤ 1 s zpoždění, 30 neshod – všechny na straně webu
(tenisové sety zamrzlé na hodnotě z načtení stránky; stránka odebírá `overview-markets` jen pro
zobrazené sporty); stránky zápasů 136/136; REST detail vs. výstup adaptéru 502/502.

### Identita událostí a čas začátku
Live zápas má **stejné ID jako prematch** (`ufo:mtch:…`): prematch výpis obsahuje tentýž fixture
s `kind: LIVE` (36/36 live fotbalových zápasů, zbytek e-sporty a 2 zápasy bez trhů), feature
`LIVE_TRANSITION`. Prematch strategie vybírá `kind=PREMATCH`, live `kind=LIVE` – po začátku zápas
z prematch výstupu zmizí a v live pokračuje pod stejným `sourceId`. `startDatetime` (a
miniscoreboard `scheduledStartTime`) je **plánovaný** začátek, ne skutečný výkop (Bharathy–Windsor:
start 19:30 UTC, v 19:37 pořád „Začne brzy“).

## Live stav a přestávky

Zdroj: miniscoreboard (`overview.gameTime` = hotový český text, `overview.info[]` = periody
`{order, home, away, finished}`, `columns.TotalScore`, tenis `PartialScoreL1` = gemy v setu,
`PartialScoreL2` = body). WS strategie navíc plný scoreboard (`eventTime`, `remainingTimeInPeriod`,
`timerRunning`).

| gameTime | GameState |
|---|---|
| `1. pol. - 14m` (fotbal, uplynulá minuta, `45+2m`) | `period 1`, `breakFlag false`, `clockSec 840` |
| `2. tř. < 3m` (hokej), `3. čt. < 4m` (basket) – **zbývá méně než N min** | `period`, `periodRemainingSec = N·60` (horní odhad); WS: přesné sekundy + `clockRunning` |
| `2. set` (tenis) | `period 2`, `score` = sety, `games`, `points` „40:A“, `periodScores` = gemy v setech |
| `Přestávka` | `breakFlag true`, `clockRunning false`, `period` = poslední perioda z `info` |
| `Prodl. < 5m` (hokej/basket prodloužení) | `period` = řádné periody + 1 (hokej 4, basket 5), `breakFlag false`, `periodRemainingSec` |
| `Přerušeno` / `Zápas přerušen` | `clockRunning false` (bez breakFlag) |
| `Konec` / `Zápas skončil` | `finished true`, `clockRunning false` (dřív se „Konec“ nepoznal) |
| `Probíhá` (feed bez detailu) | jen `statusText`, `score` |
| `1. poločas`, `2. třetina`, `3. čtvrtina` (bez hodin) | `period`, `breakFlag false` |
| `3. set` (stolní tenis, volejbal) | `period` = číslo setu, `score` = vyhrané sety (`TotalScore`), `periodScores` = body v setech vč. rozehraného (`info`), `points` = body v rozehraném setu (`PartialScoreL1`, např. `6:2`); žádné hodiny, bez příznaku přestávky mezi sety |
| `3. směna` (baseball) | `period` = směna, `score` = běhy (`TotalScore`), `periodScores` = běhy po směnách (`info`, první číslo = domácí); bez hodin, bez informace horní/dolní půlka směny |
| `1. pol. - 24m` / `2. čt. < 6m` (házená, americký fotbal) | **nepozorováno živě** (v noci nebyl žádný live zápas) – přebírá se chování fotbalu (uplynulá minuta, `clockSec`) resp. hokeje/basketu (odpočet, `periodRemainingSec`; prodloužení = 3. perioda házené, 5. americký fotbal). Nerozpoznaný text skončí jen jako `statusText`/`period` bez hodin |
| `1. pol. < 3m` (jen e-sporty) | bez `clockSec` („<“ = zbývá) |
| `Začne brzy`, `Začíná …`, `Za 3 m`, `29.09.26 3:00:00` | zápas ještě nezačal → `live: false`, jen `statusText` („Za N m“ dřív hlásilo live) |

Plný scoreboard (odběr `scoreboard.{id}` pro fotbal, hokej, basket, házenou a americký fotbal; stolní tenis, volejbal,
baseball ho nepotřebují – nemají hodiny): `eventTime` = uplynulé sekundy od začátku (hokej 3. třetina, zbývá 707 s →
`eventTime` 2893; basket 2. čtvrtina, zbývá 7 s → 1193; fotbal v nastavení stojí na 2700),
`remainingTimeInPeriod` = odpočet periody, `timerRunning` jen hokej/basket (fotbal ho nemá –
jeho hodiny se proto berou jen 2 min od poslední zprávy, ne 30 min jako zmrazené).
Skóre z miniscoreboardu může o pár sekund zaostávat za trhy (Sporting–Brondby: trhy „za stavu
1:1“, miniscoreboard ještě 1:0).

Přestávky: **poločas (fotbal), mezi třetinami (hokej), mezi čtvrtinami/poločas (basket)** hlásí
feed textem `Přestávka` – ale stejný text přichází i při **krátkém přerušení uprostřed periody**
(pozorováno: hokej AHL, 2. třetina, zbývalo 7:06). V takové zprávě často chybí `info` (periody) i
hodiny; adaptér proto převezme poslední známé periody (`mergeMini`) a WS strategie zmrazí poslední
známý čas (`periodRemainingSec 426`), takže detekce může odlišit přestávku po periodě
(zbývá 0) od přerušení. **Tenis nemá žádný explicitní příznak přestávky mezi sety** – k dispozici
jsou jen `games`/`points`/`periodScores` (např. 0:0 v novém setu po dokončeném setu).

## Websocket (L3)

* URL `wss://ws-offer.ifortuna.cz/stomp/{3 číslice}/{8 znaků}/websocket` (SockJS), hlavička
  `Origin: https://www.ifortuna.cz`. Rámce SockJS: `o` (open), `h` (heartbeat), `a["…"]` (data),
  `c[…]` (close); klient posílá `["STOMP rámec"]`.
* STOMP 1.2: `CONNECT accept-version:1.2, heart-beat:10000,10000` → `CONNECTED`; hodnoty hlaviček
  escapují `:` jako `\c` (`/topic/offer/cs/sport/ufo\csprt\c00/overview-markets`).
* Topicy (anonymní, bez tokenu):
  * `/topic/offer/cs/sport/{sportId}/overview-markets` – `{data: Market, operation: UPDATE}` /
    `{id, operation: DELETE}`; plné objekty trhů (LIVE),
  * `/topic/offer/v2/cs/miniscoreboard` – všechny miniscoreboardy (globálně),
  * `/topic/offer/cs/fixtures` – změny zápasů (UPDATE s `kind`, DELETE),
  * `/topic/offer/cs/tournaments`, `/topic/offer/cs/sports`,
  * `/topic/offer/v2/cs/scoreboard.{fixtureId}` – plný scoreboard (hodiny) per zápas,
  * `/topic/offer/cs/market.{fixtureId}` – **všechny trhy jednoho zápasu** (odebírá ho stránka
    zápasu po načtení `/fixture/{id}/markets`), `UPDATE` s plným trhem vč. suspendovaných výběrů,
    `DELETE`; ověřeno 836/836 + 502/502 shod s REST detailem.
* Server posílá STOMP heartbeat přesně á 10 s (rychlejší si vyjednat nejde – odpověď je vždy
  `heart-beat:10000,10000`); bez klientského heartbeatu server spojení po ~30 s zavře.
* Stav = REST snapshot s **výchozí** (netypovanou) overview sadou (to, co web zobrazuje a
  `overview-markets` aktualizuje; extra linie z typovaného overview WS neudržuje) + zprávy; resync
  každých 30 s, reconnect s backoffem 1–30 s, emit při změně (throttle 300 ms) a nejméně á 5 s.
  Pro až `maxDetailSubs` (40) live zápasů (naše sporty, bez e-sportů a nepodporovaných formátů, s trhy; **hlavní
  sporty fotbal/hokej/basket/tenis mají přednost** před novými – stolní tenis má v noci desítky zápasů – a v rámci
  skupiny se řadí podle začátku) se odebírá
  `market.{id}` a po přihlášení topicu se stáhne REST detail (drží se jen namapované typy);
  načtený detail má pro zápas přednost před overview, obnova á 5 min.
* **Přehrání po snapshotu (oprava 30. 9. 2026):** REST snapshot zachycuje stav z okamžiku požadavku,
  ale načte se o 0,3–0,5 s později; dřív přepsal WS zprávy z mezidobí – suspendovaný (smazaný) trh
  se vzkřísil se starým kurzem, změna kurzu se ztratila až do další zprávy. Na záznamu 13 min:
  112 zkreslených výběrů, medián 13 s, p90 32 s (např. tenis Koike–Zucchini: po brejku ML 1.08/5.8,
  adaptér 32 s ukazoval 1.12/4.75). Store si teď drží 30 s journal zpráv a po `loadSnapshot` /
  `loadDetail` přehraje zprávy od začátku stahování − 8 s (CDN stáří výpisu); na stejném záznamu
  zbyly 4 krátké odchylky (REST měl trh dřív než WS), žádný starý kurz.
* **Po (re)connectu se nic neemituje, dokud nedoběhne nový snapshot** (`synced`); detaily se po
  výpadku zahodí a načtou znovu (mezitím platí overview). `fetch()` bez srovnaného stavu hází chybu.
* **Tiché spojení:** bez jediného rámce (ani heartbeatu) 20 s → spojení se zahodí a naváže znovu.
  **Tichý `market.{id}`:** když overview doručí změnu kurzu, kterou detail nemá, a detail ji do 3 s
  nedoručí, detail se zahodí (platí overview) a načte znovu.
* **`fetchedAt` = čas posledního rámce ze serveru** (zpráva kteréhokoli topicu nebo heartbeat), ne
  čas emitu – mezi rámci stav nijak neověřujeme. Při provozu přichází rámec každých pár desítek ms
  (globální miniscoreboard topic); v úplném klidu může být až 10 s starý (heartbeat).

## Co selhalo / omezení

* `…/scoreboards` (hromadně, plný) ignoruje `fixtureIds` → vrací vše (2 MB raw) – nepoužitelné pro 1 s polling.
* `…/fixture/{id}/markets` nejde filtrovat typem – detail velkých zápasů je 1,9 MB raw.
* overview vrací jen trhy s `overview:true` (u hokejového ML v prematch je `false`) → detail rozpočet.
* `/structure/api/v1_0/fixtures?sportId=` → 400 (vyžaduje `fixtureIds`), `/sport/{id}/fixtures` → 404.
* URL > ~8 kB → 414.
* Rate limit nepozorován (desítky požadavků/min, websocket hodiny). Headless Chromium web načte bez problémů.
* Web (stránka live výpisu) sám odebírá `overview-markets` jen pro zobrazené sporty – jeho kurzy
  u ostatních sportů můžou zamrznout; pro porovnání platí REST / stránka zápasu.

## Když se to rozbije

1. `npx tsx scripts/try-adapter.ts fortuna prematch` / `live` – který krok selhal (`details` obsahuje URL a vzorek).
2. Změna API cest: web načítá `/fe/offer-application/manifest.json` → `app-*.js` → chunk `index-*.js`;
   konstanty `w="/structure/api/v1_0"`, `Ue="/markets/api/v1_0"`, `cs="/stats-v2/api/v2_0"`.
3. Změna WS: `cms-client/configuration/web_global` → `miniscoreboardWebSocketUrl`; topicy v chunku
   `websocketSubscriptions-*.js` (`/topic/offer/${lang}`, `/topic/offer/v2/${lang}`).
4. Nové/změněné typy trhů: `GET /markets/api/v1_0/fixture/{id}/markets` a porovnat `marketTypeId`,
   `marketTypeName`, `marketTypeDesc`, `syntheticGroupKey` s `DEFS`.
5. Blokace plain HTTP (403/Cloudflare výzva) → runner přepne na `browser-fetch` (L5).
6. Fixtures pro testy: `fixtures/fortuna/*.json` (výpis + overview + 4 detaily, live výpis/overview/
   miniscoreboards, WS snapshot + 400 zpráv); detaily zkrácené na namapované typy + 8 vzorků;
   `ws-resync-race.json` (2 skutečné případy přepsání WS zprávy snapshotem), `ws-detail-topic.json`
   (REST detail + zprávy `market.{id}` Lyon–Chelsea, vč. suspendovaných výběrů).
