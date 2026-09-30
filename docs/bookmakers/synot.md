# SYNOT TIP (`synot`)

Web: <https://sport.synottip.cz> (kurzové sázky; rozcestník www.synottip.cz). Platforma **eBet**
(ASP.NET/WCF + Web API na IIS, F5 BIG-IP, React bundle `/reactw/js/app.min.js`; stejný kód obsluhuje
i slovenský TIPOS). **Bez ochrany proti botům:** ověřeno 29. a 30. 9. 2026 – curl, Node fetch i
headless Chromium dostávají 200, žádný Cloudflare/Akamai.

## Strategie

| level | název | scope | stav |
|---|---|---|---|
| 2 | `ebet-api` | prematch + live | ✅ interní API webu, čistý Node fetch, anonymní token |
| 5 | `browser-fetch` | prematch + live | ✅ totéž API přes `fetch` ve stránce sport.synottip.cz (záloha) |

Live používá **`webapi/GetLiveEventsWL`** – přesně to, co long-polluje live stránka webu
(`getLiveEventsWLAsync` v app.min.js). Dřívější `GetLIPEvtsDsk` („GetLiveEventsInPrematchDesktop“ =
malý live box na prematch stránce) má stejný tvar dat a ve stejném okamžiku identické kurzy/stavy
(ověřeno 240/240 výběrů), ale jen hlavní trhy.

SignalR (`/WebServices/Api/signalr`, hub `livehub`) posílá `eventDetailChanged` jen pro **jednu**
otevřenou událost (detail) zhruba po 10 s; změny kurzů v něm nejsou rychlejší než seznam
(seznam za SignalR medián +0,4 s, rozsah −0,6…+1,3 s, 44 změn). Hromadný push kanál není → L3 není.

### Měření

| | požadavky | data | latence |
|---|---|---|---|
| prematch, 13 sportů (1. 10. 2026) | **5** (+1 token): výpis všech sportů 525 kB, trhy se sjednocenými GameIds do 24 h ~2,0 MB, americký fotbal 7 dní 450 kB, MMA 4 kB, box 1 kB | ~3,0 MB (API nekomprimuje) | ~1,0–1,5 s (paralelně) |
| prematch, 4 sporty (30. 9. 2026, dřívější stav) | 8 (2 na sport) | ~2,2 MB | ~1,5 s |
| live (1× GetLiveEventsWL) | 1 | 150–250 kB (nekomprimováno) | 50–150 ms |

Prematch: ~1 500 zápasů, ~13,7 tis. trhů, ~29 tis. kurzů (fotbal 858, hokej 125, tenis 100, basket 125, házená 55, volejbal 15,
stolní tenis 78, baseball 13, snooker 8, šipky 18, americký fotbal 98, MMA 12, box 4). Live ve 21:30: ~140 událostí všech sportů,
z toho ~95 ve 4 původních sledovaných sportech; kolem 22:45 ~25; ve 0:40 ~27 (z toho volejbal 3, stolní tenis 7, baseball 1).

## Endpointy

Vše `POST` s JSON tělem, hlavičky `content-type: application/json;charset=UTF-8` a
**`accept: application/json`** (bez ní WCF odpoví XML). Odpověď `{Result, Token, ReturnValue}`:
`Result` 1 = OK, 0 = chyba (neplatný/prošlý token → adaptér token obnoví a zopakuje).

| účel | URL | tělo |
|---|---|---|
| anonymní token | `/WebServices/ApiSession/SportsBettingSessionService.svc/GetLiveInitData` | `{Version:"CZ-I", LanguageID:12, AppType:1}` → `Token` |
| prematch výpis | `/WebServices/Api/SportsBettingService.svc/GetWebStandardEvents` | `{LanguageID:12, Token, CategoryID:"12" nebo null, Top:5000, Skip, IncludeLiveCategories:false}` |
| prematch vybrané trhy | totéž | navíc `GameIds:[79,7,…]`, `From:"/Date(ms)/"`, `To:"/Date(ms)/"` |
| **live (používá se)** | `/WebServices/Api/webapi/GetLiveEventsWL` + hlavička `Verify: sport <token>` | `{ActualEvents:true, LanguageID:12, Token, UseLongPolling:false, TimeStamp:0}` |
| live – live box prematch stránky (nepoužito) | `…/SportsBettingService.svc/GetLIPEvtsDsk` | totéž tělo |
| health | `…/SportsBettingSessionService.svc/getServerTime` | `{LanguageID:12, Token, WithTokenCheck:true, SID:""}` |
| detail zápasu (nepoužito) | `…/SportsBettingService.svc/GetWebStandardEventExt` | `{EventID, LanguageID:12, Token, UseLongPolling:true, TimeStamp}` |

Kořenové kategorie (= `DisciplineID` v live): fotbal `12`, hokej `14`, tenis `19`, basket `21`, házená `33`, volejbal `23`,
stolní tenis `20`, baseball `13`, americký fotbal `22`, box `17`, MMA `35`, snooker `39`, šipky `24` (ostatní: e-sporty 87/202/214,
futsal 28, rugby 5, badminton 25, florbal 50 … se nesledují).
**`CategoryID: null` = všechny sporty jedním požadavkem** (tak volá web úvodní stránku; 1 975 zápasů, 525 kB). Seznam kategorií
(`"12,14"`, `"12;14"`, `"[12,14]"`) API nebere – vrátí prázdnou odpověď (ověřeno 1. 10.). `Skip` stránkuje (ověřeno: stránky
se nepřekrývají); `UnpaginatedEventCount` = celkem, dnes < 2 000, takže stačí jedna stránka (`PAGE_SIZE` 5000, pojistka 4 stránky).
Formát dat ve filtru je WCF (`/Date(1790690400000)/`); ISO řetězec vrací chybovou HTML stránku.

`GetWebStandardEvents` bez `GameIds` vrací jen hlavní trh („Zápas“ 1/0/2, tenis „Vítěz zápasu“,
basket „Vítěz (včetně prodloužení)“). S `GameIds` vrací jen vyjmenované typy trhů (hodnota `-99`
= „Zápasy“ se s jinými ID nekombinuje, proto dva požadavky). `AvailableGames` (pole 2 odpovědi) je
jen obecný filtr webu (ID + obecný název, ne po sportech) → skutečné typy trhů sportu se zjišťují z dat: dotaz s `GameIds` = 1…1700
a `CategoryID` sportu vrátí všechny trhy všech zápasů sportu (takto pořízená inventura níže). Celá nabídka se všemi trhy má ~7 MB → vedlejší trhy jen
pro zápasy do `marketsHorizonHours` (24 h, v L5 12 h). Události, které už jsou v live nabídce
(i „Nezačalo“), prematch výpis (`IncludeLiveCategories:false`) nevrací.

### Čerstvost live dat (`fetchedAt`)

* Žádná CDN (bez `Age`/`Cache-Control: max-age`, `cache-control: no-cache`), ale **server drží
  live snapshot v paměti a přegenerovává ho každých ~1,03 s** (p99 1,07 s, ojediněle 2–4 s).
  Dotazy v rámci okna dostanou tentýž snapshot se stejným `TimeStamp` → data jsou v okamžiku
  dotazu 0–1 s stará.
* `TimeStamp` = čas vygenerování v 100ns tikách; báze se liší mezi uzly za F5 (cookie
  `BIGipServer~SYNOTTIP~m.synottip.cz`, kterou `HttpClient` drží, uzel udržuje).
  `SnapshotClock` (api.ts) z něj počítá skutečný okamžik vygenerování: posun hodin uzlu =
  minimum (t1 − TimeStamp/10⁴) přes odpovědi (chyba ≈ nejkratší zpoždění, desítky ms), prvních
  10 odpovědí a nejednoznačné skoky konzervativně `t0 − 1100 ms`, tentýž snapshot má vždy stejný
  `fetchedAt` (neomládne). Na živém serveru: 10× ~1,1 s (konzervativně), pak 0,23–0,27 s.
* Long-polling (`UseLongPolling:true` + `TimeStamp` z minulé odpovědi) vrací odpověď 0–0,62 s po
  vygenerování (server kontroluje zhruba po 0,6 s) → oproti pollingu jen ~0,2 s čerstvější, proto
  se nepoužívá (a `subscribe()` není implementováno).

## Formát dat

**Prematch** – `ReturnValue` je base64 **protobuf** (`GetWebStandardEventsResponse`). Schéma je
výřez ze staticky generovaného protobufjs kódu v `app.min.js` (`proto.ts`, vlastní dekodér bez
knihovny): strom `EventTree.Categories[]` = sport → země/region (`Mezinárodní`, `Česko`) → liga
→ `Base.Events[]`. Událost: `Id`, `Name` „Domácí - Hosté“ (competitors neposílá), `Date.Value`
(epoch ms), `GameGroups[].Games[]` → `Details[]` (jedna linie) → `OddsList[]` (`Name`, `Rate`
**float32**, `State`). Kategorie s `IsVirtual` (zkratky „NHL“, „Liga národů UEFA“ nahoře v menu)
se přeskakují. Zpráva `Game` v protobufu nemá `State` (jen `TurnOff`).

**Kurzy**: float32 (2.29999995) se zaokrouhlují na 2 místa – web zobrazuje zaokrouhleně (ne
oříznutě): 28/28 kurzů z úvodní stránky 30. 9. se shodovalo, u 10 z nich by oříznutí dalo jiné
číslo (např. 2.29999995 → web „2,30“). Live JSON má kurzy rovnou na 2 místa. Web ukazuje i kurzy
nad 35 (100,00, 250).

**Live** – čistý JSON, `ReturnValue[]` po sportech (`DisciplineID`) s `Events[]`; stejné
`GameGroups` a navíc stav: `StateName`, `StateTime`, `RemainingPeriodTime`, `ClockStopped`,
`Results[]`, `State`, `CategoryPath` „Země / Liga“. `Date` je v GetLiveEventsWL ISO s posunem
(`2026-09-30T20:45:00+02:00`), v GetLIPEvtsDsk WCF (`/Date(1790793900000+0200)/`); obojí je
**plánovaný** začátek (i když se začalo dřív – Cienciano 30. 9. „1. poločas“ ve 21:58:48, `Date`
22:00).

**Texty obsahují nezlomitelné mezery** („Tým 1 (-1.5)“) → vše se normalizuje (`norm()`).

### Identita událostí prematch ↔ live

Id události je **stejné** v prematch i live (`/zapas/{id}` ↔ `/live/live-zapas/{id}`): ověřeno na
3821351 a 3802302 (prematch výpis 21:35 → live 21:59) a na 3853986 / 3855871 (prematch fixture
z 29. 9. → live 30. 9.). Jakmile je zápas v live nabídce, z prematch výpisu zmizí.

### Mapování trhů (`RULES` v parse.ts)

Typ trhu = číslo na začátku `Game.ID` („233d462443661“ → 233, „79“ → 79 u trhů s liniemi); navíc
se kontroluje název trhu.

* **fotbal**: 2 1X2, **3 DC**, 4 DNB, 79 OU, 7 AH („Handicap“ = asijský, linie x.0/x.5, čtvrtinové
  vynechány), 88 BTTS, 8 OE, 80/81 týmové totaly; 1. poločas 12/**13 DC**/14/113/16/117/114/115,
  2. poločas 123/**124 DC**/125/130/127/135/131/132. „Handicap 0:1“ (5, 3-cestný) vynechán.
* **hokej**: 2/**3 DC**/4/79/7/88/8/80/81 = základní doba; 228/229/230 „(včetně prodloužení a sam.
  nájezdů)“ → ML/AH/OU|MATCH; třetiny 233 1X2, **245 DC**, 240 DNB, 235–237 OU, 241–243 AH, 238 BTTS.
* **tenis**: 178 ML, 209 AH gemy, 210 AH_SETS, 211 OU gemy, 212/213 gemy hráčů, 356 OU_SETS
  „Počet setů“, 221/222/223 set n: vítěz / handicap gemů / počet gemů.
* **basket**: 251/252/253/254/255 „(včetně prodloužení)“ → ML/AH/OU/týmové totaly |MATCH,
  2 „Zápas“ 1/0/2 = 1X2|REG (jen GetLIPEvtsDsk, v GetLiveEventsWL ani v prematch není), 1. poločas
  12/14/113/16, čtvrtiny 1–3 (257 1X2, 262 DNB, 258–260 OU, 263–265 AH). **2. poločas a
  4. čtvrtina vynechány** – není jisté, jestli u basketu nezahrnují prodloužení.
* Výběry: „1“/„0“/„2“, dvojtip „10“ (= 1X → `HOME_DRAW`) / „12“ (`HOME_AWAY`) / „02“ (`DRAW_AWAY`), „Pod (x)“/„Nad (x)“,
  „Tým 1 (±x)“/„Tým 2 (∓x)“ (linie domácích = číslo u Týmu 1), „Ano“/„Ne“, „Lichá“/„Sudá“. Neznámý výběr → linie vynechána.
* Pojistka rozsahu: REG/periody s „prodl/nájezd“ v názvu se zahodí, MATCH hokeje, basketu, baseballu a amerického fotbalu ho
  mít musí (výslovně „(včetně prodloužení)“ / „(včetně extra směn)“). Trh bez toho je podle herního plánu čl. 8.3
  (výsledek po uplynutí stanovené hrací doby, bez ohledu na prodloužení, pokud název neříká jinak) základní doba.

#### Dvojtip (`DC`)

Typy: fotbal 3 (REG), 13 (H1), 124 (H2); hokej 3 (REG), 245 (P1–P3, číslo z názvu „N. třetina - Dvojtip“); házená 3, 13, 124.
Basketbal, americký fotbal, baseball ani jiný sport dvojtip **nenabízí** (basket: jen 3-cestný „Zápas“ a poločasy/čtvrtiny 1X2).
Kombinace „Dvojtip a počet gólů“ (103), „Dvojtip a oba týmy dají gól“ (102, 189, 192, 527, 528) se nemapují.
* **Hokejový dvojtip (3) = 60 min**, ne vč. prodloužení: 1/kurz „10“ ≈ 1/kurz „1“ + 1/kurz „0“ z 1X2|REG (112 zápasů: medián
  součtu absolutních odchylek normalizovaných pravděpodobností 0,033, tj. jen marže; dvojtip vč. prodloužení by se lišil o P(remíza) ≈ 0,2).
  Fotbal 96 zápasů: medián 0,046; házená 47: 0,089 (široké marže).
* Výběr s kurzem ≤ 1.00 Synot vůbec nevypisuje (např. „12“ u těžkého favorita) → trh má 2 nebo 1 výběr; výběry dvojtipu
  jsou pro detektor samostatné nohy (`groups.ts`: 1 vs. X2, 2 vs. 1X, X vs. 12), takže se chybějící výběr jen vynechá.
* Dvojtip se v live seznamu (`GetLiveEventsWL`) neposílá.

#### Další sporty

ID typu trhu **není napříč sporty jednoznačné** (209 = tenis „Gamy - Handicap“, stolní tenis „Sety - Handicap“; 178 = „Vítěz zápasu“
ve všech individuálních sportech; 251–255 jen basket/AF „včetně prodloužení“), proto jsou `RULES` po sportech + kontrola názvu.
Inventura typů z dat (1. 10. 2026, všechny zápasy 14 dní dopředu) a z ní vycházející mapování:

| sport (kategorie) | namapováno | vynecháno (a proč) |
|---|---|---|
| házená (33) | 2 `1X2\|REG`, 3 `DC`, 4 `DNB`, 7 `AH`, 79 `OU`, 80/81 `OU_HOME/AWAY`, 8 `OE`; `H1` 12/13/14/16/113/17, `H2` 123/124/125/134 – vše 60 min (název bez „včetně prodloužení“, herní plán 8.3) | 6 vítězný rozdíl, 9 poločas/zápas, 11, 95 a 1x2 + total (kombinace), 348 dlouhodobé; vítěz vč. prodloužení / 7m Synot nevypisuje |
| volejbal (23) | 178 `ML\|MATCH`, 210 `AH_SETS`, 356 `OU_SETS`, 269 `OU\|MATCH` (body celkem), 8 `OE\|MATCH`, 221 `ML\|Sn`, 287 `OU\|Sn`, 288 `OE\|Sn` | 214/215 „vyhraje set“, 217 přesný počet setů, 219 přesný výsledek, 220 „N. set a zápas“; zápasy „Přátelské“/zlatý set se vyřazují celé (filtr preventivní, v nabídce nebyl) |
| stolní tenis (20) | 178 `ML\|MATCH`, 268 `AH\|MATCH` (body), 269 `OU\|MATCH` (body), 209 `AH_SETS` (jen live), 80/81 `OU_HOME/AWAY\|MATCH` (body hráče, jen live), 249 `ML\|Sn`, 270 `AH\|Sn` (body), 271 `OU\|Sn`, 250 `OE\|Sn` | 219 přesný výsledek, „kdo první získá N bodů“, „N. bod“, počet setů rozhodnutých extra body |
| baseball (13) | 2 „Zápas“ `1X2\|REG` (9 směn), 293 `ML\|MATCH`, 294 `AH\|MATCH` (run line), 295 `OU\|MATCH`, 296/297 `OU_HOME/AWAY\|MATCH`, 298 `OE\|MATCH` – vše vč. extra směn | 299–303 a 384/385 směny 1–5 a jednotlivé směny, 363, 371–373 odpaly, 380, 381 „bude extra směna“, 382/383, 387/388, 420–422, 432, 885 (hráčské / kombinační / po částech zápasu). **Trhy závislé na nadhazovačích Synot nevypisuje** (žádný nemá nadhazovače v názvu) |
| americký fotbal (22) | 2 `1X2\|REG` (60 min), 252 `AH\|MATCH`, 253 `OU\|MATCH`, 254/255 `OU_HOME/AWAY\|MATCH`, 256 `OE\|MATCH` (vše „včetně prodloužení“); `H1` 12/14/16/113/17; čtvrtiny 1–3: 257 `1X2`, 262 `DNB`, 258–260 `OU`, 263–265 `AH` | **251 „Vítěz (včetně prodloužení)“ – `ML` se nemapuje** (2 výběry, NFL může skončit remízou i po prodloužení a Synot nepíše, jak ji vyhodnotí; ekvivalent `AH\|MATCH\|±0.5` detektor použije); H2 (123/124/127/130) a 4. čtvrtina (261/266) – jako u basketu nejasné vůči prodloužení; 9, 11, 274, 282/283 (týmové lichá/sudá), 446, 447, 348 |
| MMA (35), box (17) | 2 „Zápas“ `1X2\|REG` včetně remízy (kurz remízy 22–35) | **178 „Vítěz zápasu“ (2 výběry) se nemapuje ani jako `ML`, ani jako `DNB`**: herní plán vrácení při remíze neuvádí (čl. 8 nic o remíze u bojových sportů, kurzy 178 mají plochou marži 6,9 % nezávislou na P(remíza), takže se z nich vrácení odvodit nedá); 79 celkový počet kol, 185 způsob vítězství, 186, 187, 188 |
| snooker (39) | 178 `ML\|MATCH`, 1276 `AH\|MATCH` (framy), 1277 `OU\|MATCH` (framy) | 219 přesný výsledek |
| šipky (24) | 178 `ML\|MATCH`, 210 `AH_SETS`, 356 `OU_SETS`, 1587 `OU\|MATCH` (**legy** celkem), 221 `ML\|Sn`, 700 `AH\|Sn` (legy), 701 `OU\|Sn` (legy) | 304 „N. set, N. leg“, 305–310 a 307 180-tky, 532/1585 přesné výsledky, 704; `ML` se u soutěží s „league/liga“ v názvu (Premier League – remíza možná) zahazuje; žádný handicap na legy za celý zápas se nevypisuje (AH\|MATCH u šipek se tedy nikdy nemíchá se sety) |

Soutěžní filtry (`eventMarkets`): baseball `ML\|MATCH` a `1X2\|REG` jen **MLB** (v NPB/KBO/CPBL a přátelácích může zápas skončit remízou i po extra
směnách, „Zápas“ tam Synot nevypisuje; AH/OU vč. extra směn se vyhodnotí podle konečného skóre a zůstávají).

Důkazy k sémantice (kurzy z 1. 10. 2026):
* **Baseball „Zápas“ 1/0/2 = 9 směn**, přestože to Synot nepíše: 3 zápasy MLB, P(remíza) 10,7–11,5 % a „Vítěz (včetně extra směn)“ ≈
  P(1) + P(X)/2 (0,550 vs 0,550, 0,562 vs 0,570, 0,490 vs 0,487) – stejná úvaha jako u Fortuny. Protože to není výslovné, je trh jen pro MLB.
* **Americký fotbal „Zápas“ = 60 min**: P(remíza) 5–7 % a ML vč. prodloužení ≈ P(1) + P(X)/2 (58 zápasů).
* Snooker: handicap ±0.5 chodí ve dvou detailech („Tým 1 (-0.5)“ a „Tým 1 (+0.5)“) se stejnými kurzy – správně, remíza ve framech není možná
  (home −0.5 ⇔ home +0.5), proto `AH|MATCH|-0.5` i `|0.5` mají shodné ceny.
* Týmové totaly (80/81, 254/255, 296/297 …): jméno týmu v názvu trhu vždy odpovídá straně (296 = domácí, 297 = hosté: 12/12 zápasů baseballu,
  52/52 amerického fotbalu, 56/56 basketu).
* Stolní tenis 80 „Tým1 celkový počet bodů“: body hráče 1 za celý zápas (live stránka: při 2:2 na sety a 31 bodech hráče 1 je Nad 37.5 @1.33,
  shodné s cenou „Celkový počet bodů“ 77.5).

### Live trhy (GetLiveEventsWL)

Seznam posílá v každé skupině **jeden** trh a ten se mění podle stavu zápasu – rozhoduje vždy typ
+ název, nikdy pozice/skupina:

| skupina | fotbal / hokej | tenis | basket |
|---|---|---|---|
| Hlavní sázky | 2 „Zápas“ → 1X2\|REG; **365 „Který tým vyhraje zbytek zápasu od skóre 5:0“ (náhrada, když je Zápas rozhodnutý) – nemapuje se** | 178 → ML\|MATCH | 251 → ML\|MATCH |
| Góly | 79 → OU\|REG, nebo 80 „Tým1 celkový počet gólů“ → OU_HOME\|REG | – | – |
| Handicap | 7 → AH\|REG | – | 252 → AH\|MATCH |
| Gamy / Set | – | 211 → OU\|MATCH, 223 → OU\|S*n*; 221 → ML\|S*n* | – |
| Body | – | – | 253 → OU\|MATCH |

Live totaly a handicapy se vyhodnocují **na celý zápas (padlé góly se počítají)**, ne „zbytek
zápasu“ – ověřeno z cen: Crystal Palace 2:0 (68') domácí −3.5 @7.35, Skotsko U21 3:1 (poločas)
−4.5 @5.07, Whyteleafe 1:1 (poločas) Tým 1 (0) @2.69 = domácí musí vyhrát, Panathinaikos 63:39
−30.5 @3.17, tenis Staeheli 3:6 3:2 Pod 21.5 @2.44, West Ham 3:1 Tým1 Nad 3.5 @3.9.

Nové sporty v live seznamu (inventura 1. 10. 2026 0:30–0:50 ze 6 snímků + 3 min záznam, `RULES` jsou stejné jako v prematch):

| sport | typy trhů v `GetLiveEventsWL` |
|---|---|
| volejbal | 178 → ML\|MATCH, 221 „N. set - Vítěz“ → ML\|S*n* (body a handicapy v live seznamu nejsou) |
| stolní tenis | 178 → ML\|MATCH, 269 → OU\|MATCH (body), 268 „Body - Handicap“ → AH\|MATCH (body), 209 „Sety - Handicap“ → AH_SETS\|MATCH, 80 „Tým1 celkový počet bodů“ → OU_HOME\|MATCH (nahrazuje 269) |
| baseball | 2 „Zápas“ → 1X2\|REG (9 směn; jen MLB), 295 → OU\|MATCH; 432 „Počet bezbodových směn“ se nemapuje |
| házená, snooker | z dřívějších záznamů (`live.json`): házená 2 „Zápas“; snooker jen stav „Probíhá“ (bez trhů) |
| šipky, americký fotbal, MMA, box | v době inventury se nehrálo – **bez živého vzorku** (mapování z prematch; stavové texty neověřeny) |

Při suspendaci výběru (`Rate: 0`, `State: 3`, např. volejbal „2“ @0) se celá linie vynechá (viz níže).

### Stavy nabídky a suspendace

Enum webu (`OfferItemState` / stav události): 0 None, 1 Created, 2 **Opened**, 3 **Suspended**,
4 Closed. Otevřené je jen 0/2.

* **Událost `State: 3` = sázení zastaveno, NE konec zápasu**: gól (~3 s), konec zákl. doby
  (fotbal `StateTime` 5400, nastavení), hokej 3 min před koncem (T3420) a prodloužení
  („Prodloužení“, „Čekání na prodloužení“), „Nezačalo“, „Ukončeno“. Web při 3 zamyká všechny kurzy
  (`t.State===Suspended` → `isSuspended`). Feed v tu chvíli trhy vynechává úplně (v 3 400+
  snímcích s `State 3` nebyl žádný trh); adaptér přesto při 3/4 zavírá všechny trhy.
* `Game.State` (jen live JSON) a `Detail.State`/`Suspended` zavírají linii, `Odds.State` výběr.
* Suspendovaný výběr chodí s `Rate: 0, State: 3` (typicky favorit s kurzem < 1,01; web zamkne jen
  ten výběr) → adaptér vynechá celou linii (bez ceny ji nejde vyjádřit; ztráta ~20 % řádků, ale
  jde o trhy s kurzy 10–250 bez arbového potenciálu). Výběr se `State 3` a nenulovým kurzem se v
  datech nevyskytl; kdyby přišel, jde ven s `open: false`.

## Live stav a přestávky

* `statusText` = `StateName`: „1. poločas“, „Poločas“, „2. třetina“, „Přestávka“ (hokej i basket),
  „3. čtvrtina“, „2. set“, „Nezačalo“, „Přerušeno“ (tenis), „Čekání na prodloužení“,
  „Prodloužení“, „Po prodloužení“, „Ukončeno“; nové sporty: volejbal a stolní tenis „1. set“ … „5. set“, **„Přestávka“ mezi sety**,
  baseball „4. směna bottom“ / „top“, házená „1. poločas“ / „Poločas“, snooker „Probíhá“ (event `State 3`, bez trhů).
* `live`: **„Nezačalo“ → `live: false`** (zápas je v live nabídce, ale nehraje se; jinak by Synot
  přepnul kanonickou událost do LIVE před výkopem). Ostatní události live feedu `live: true`.
* `finished` **jen z textu**: „Ukončeno“, „Konec zápasu“, „Po prodloužení“, „Po (sam.)
  nájezdech“. Dřív se bral i event `State 3` → kanonická událost „končila“ při každém gólu Synotu,
  v nastavení fotbalu, 3 min před koncem hokeje a před prodloužením (detektor ji pak přeskakuje a
  arby všech sázkovek končí jako `event_finished`).
* `breakFlag`: „Poločas“, „Přestávka“, „Čekání na …“ (regex `^poločas$|přestávk|pauza|^čekání`);
  `period` z textu („2. třetina“) nebo při přestávce počet odehraných period v `Results`;
  prodloužení periodu nenastavuje. Basket „Přestávka“ nerozlišuje poločas od přestávky mezi
  čtvrtinami → `period` = počet odehraných čtvrtin.
* Hodiny: `StateTime` = **uplynulé sekundy od začátku zápasu** (hokej: StateTime 3415 +
  RemainingPeriodTime 185 = 3600; basket FIBA 1044 + 156 = 1200), `RemainingPeriodTime` →
  `periodRemainingSec`, `ClockStopped` → `clockRunning`. Ve fotbale se StateTime v nastavení
  zastaví na 5400 (resp. 2700). V přestávkách StateTime chybí. Házená: poločas 1800 s (StateTime 1549 + Remaining 251). **Hodiny se
  přebírají jen u fotbalu, hokeje, basketu a házené** (`CLOCK_SPORTS`); volejbal, stolní tenis, baseball, šipky a snooker je ve
  feedu nemají, u amerického fotbalu / MMA / boxu nebyl živý vzorek.
* Skóre: `Results[]` s `MainResult` = celkové (tenis: sety), `Flags & 64` = periody („1. poločas“,
  „2. set“ 7:6), tenis `Flags & 1` „Game skóre“ → `points`, gemy aktuálního setu z periody.
  Nové sporty: volejbal / stolní tenis `score` = sety, `periodScores` = body po setech; baseball `score` = běhy, `periodScores` = běhy po
  směnách (`period` = číslo směny, „top/bottom“ se zahazuje); `finished` jen „Ukončeno“ (stolní tenis: event `State 3` + „Ukončeno“,
  trhy nejsou; `State 3` u „5. set“ / „Probíhá“ = jen pozastavené sázení).

## Ověření (30. 9. 2026, 21:25–22:55)

* DOM live stránky vs. `parseLive` nad odpovědí, kterou si stránka sama stáhla: hlavní trh
  364/368 shod (4 rozdíly = náhradní trh 365, který se správně nemapuje), 86/86 v závěrečném
  běhu včetně záložek Góly / Handicap / Gamy / Set / Body (linie, strana, kurz, zámek).
* 25 min long-poll záznamu GetLIPEvtsDsk + 40 min GetLiveEventsWL (inventura typů trhů, stavů,
  přechodů gól → State 3 → State 2).
* Prematch: 28 kurzů z úvodní stránky = parser (zaokrouhlení float32).

## Ověření nových sporticků a dvojtipu (1. 10. 2026, 0:30–1:00)

* **Prematch, stránka zápasu `/zapas/{id}` (Playwright, 1 stránka naráz, všechny záložky skupin trhů) vs. výstup adaptéru** (název trhu, popisek
  výběru, kurz; popisek „Tým 1“ vs. jméno domácího u 1X2): 20 zápasů – házená 2, volejbal 2, stolní tenis 2, baseball 2 (MLB + NPB), snooker 1,
  šipky 2, americký fotbal 2, MMA 2, box 1, fotbal 2, hokej 2 – **1 095 výběrů: 918 shodných hned, 177 rozdílů
  byl jen drift kurzů mezi snímkem a načtením stránky (baseball, fotbal, volejbal) – po novém snímku API těsně před načtením stránek
  221/221 shodných**; žádná chyba názvu, linie, strany ani měřítka.
* **Live** (`/live`, `GetLiveEventsWL` zachycený stránkou sám + DOM v témže okamžiku): 44/44 kurzů hlavního trhu a 24/24 stavů (status,
  skóre) vč. volejbalu (3 zápasy), stolního tenisu (4), baseballu (1). Detail `/live/live-zapas/{id}` (záložky Počet bodů / Handicap /
  Set) stolního tenisu vs. seznam: ML, „Celkový počet bodů“ 77.5, „Body - Handicap“ Tým 1 (+0.5) 2,41 / Tým 2 (−0.5) 1,44, „Tým1 celkový
  počet bodů“ 42.5 – kurzy shodné (drift < 1 s).
* Semantika: číselné kontroly proti 1X2 (dvojtip hokej/fotbal/házená, baseball a americký fotbal „Zápas“ vs. ML vč. prodloužení, MMA/box 178 vs. 1X2),
  herní plán 8.3 (stažen z odkazu na stránce `www.synottip.cz/herni-plan`, platný od 13. 7. 2026) – viz výše.
* Počet požadavků za cyklus: 8 → 5 (viz Měření).

## Co nefunguje / omezení

* Live obsahuje jen trhy seznamu (1 trh na skupinu). Plné live trhy = detail každého zápasu
  (`GetWebStandardEventExt` / SignalR) – vynecháno kvůli počtu požadavků.
* Basket 1X2|REG v live už není (je jen v GetLIPEvtsDsk; šlo by přidat druhým požadavkem
  +165 kB/s).
* Vedlejší prematch trhy jen do 24 h (objem dat); americký fotbal, MMA a box (hlavní trh výpisu se nemapuje) mají vlastní požadavek s oknem
  7 dní (`nicheHorizonHours`). Události, které po mapování nemají jediný trh (mimo okno), se z prematch výstupu vynechávají.
* Z baseballu chybí „Zápas“ (1X2) a ML mimo MLB; z amerického fotbalu ML; z MMA/boxu ML a DNB (viz výše). Basketbal nemá dvojtip.
* Volejbal v live: jen ML zápasu/setu; šipky, AF, MMA a box v live bez ověření na živých datech.
* Baseball: dvojzápas téhož dne (herní plán 8.18b) – trhy se týkají prvního zápasu; dvě utkání stejných týmů mají v nabídce různá ID,
  párování na jiné sázkovky to musí rozlišit časem.
* Rate limit nepozorován (1 req/s dlouhodobě). Token nevyprší během desítek minut; když ano,
  `Result: 0` → obnova.

## Oprava, když se to rozbije

1. `curl -s -X POST -H 'content-type: application/json' -H 'accept: application/json' -d '{"Version":"CZ-I","LanguageID":12,"AppType":1}' https://sport.synottip.cz/WebServices/ApiSession/SportsBettingSessionService.svc/GetLiveInitData`
   – musí vrátit `Result: 1` a `Token`.
2. Live: v app.min.js hledat `getLiveEventsWLAsync` (URL, tělo, hlavička `Verify`); náhradní
   endpoint se stejným tvarem dat je `GetLIPEvtsDsk`.
3. Změna protobuf schématu: v `app.min.js` hledat `GetWebStandardEventsResponse` a
   `e.decode=function` – čísla polí `case N: a.Pole=…` porovnat se `SCHEMA` v `proto.ts`.
4. Nové/změněné typy trhů: inventura z dat – `GetWebStandardEvents` s `GameIds` = 1…1700, `CategoryID` sportu a oknem `From`/`To`
   (`AvailableGames` v odpovědi je jen obecný seznam filtru: ID + název bez vazby na sport),
   `RULES` v `parse.ts`, fixtures `fixtures/synot/prematch-markets-*.json`, `live-wl*.json`.
5. Nahrání nových fixtures: odpovědi uložit jak jsou (JSON obálka, token nahradit nulami).
