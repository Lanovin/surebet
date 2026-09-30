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

### Měření (30. 9. 2026 večer)

| | požadavky | data | latence |
|---|---|---|---|
| prematch (4× hlavní nabídka + 4× vedlejší trhy do 24 h) | 8 (+1 token) | ~2,2 MB (API nekomprimuje) | ~1,5 s |
| live (1× GetLiveEventsWL) | 1 | 150–250 kB (nekomprimováno) | 50–150 ms |

Prematch: ~1 200 zápasů, ~9–12 tis. trhů. Live ve 21:30: ~140 událostí všech sportů, z toho
~95 ve 4 sledovaných sportech; kolem 22:45 ~25.

## Endpointy

Vše `POST` s JSON tělem, hlavičky `content-type: application/json;charset=UTF-8` a
**`accept: application/json`** (bez ní WCF odpoví XML). Odpověď `{Result, Token, ReturnValue}`:
`Result` 1 = OK, 0 = chyba (neplatný/prošlý token → adaptér token obnoví a zopakuje).

| účel | URL | tělo |
|---|---|---|
| anonymní token | `/WebServices/ApiSession/SportsBettingSessionService.svc/GetLiveInitData` | `{Version:"CZ-I", LanguageID:12, AppType:1}` → `Token` |
| prematch sportu | `/WebServices/Api/SportsBettingService.svc/GetWebStandardEvents` | `{LanguageID:12, Token, CategoryID:"12", Top:5000, IncludeLiveCategories:false}` |
| prematch vybrané trhy | totéž | navíc `GameIds:[79,7,…]`, `From:"/Date(ms)/"`, `To:"/Date(ms)/"` |
| **live (používá se)** | `/WebServices/Api/webapi/GetLiveEventsWL` + hlavička `Verify: sport <token>` | `{ActualEvents:true, LanguageID:12, Token, UseLongPolling:false, TimeStamp:0}` |
| live – live box prematch stránky (nepoužito) | `…/SportsBettingService.svc/GetLIPEvtsDsk` | totéž tělo |
| health | `…/SportsBettingSessionService.svc/getServerTime` | `{LanguageID:12, Token, WithTokenCheck:true, SID:""}` |
| detail zápasu (nepoužito) | `…/SportsBettingService.svc/GetWebStandardEventExt` | `{EventID, LanguageID:12, Token, UseLongPolling:true, TimeStamp}` |

Kořenové kategorie (= `DisciplineID` v live): fotbal `12`, hokej `14`, tenis `19`, basket `21`.
Formát dat ve filtru je WCF (`/Date(1790690400000)/`); ISO řetězec vrací chybovou HTML stránku.

`GetWebStandardEvents` bez `GameIds` vrací jen hlavní trh („Zápas“ 1/0/2, tenis „Vítěz zápasu“,
basket „Vítěz (včetně prodloužení)“). S `GameIds` vrací jen vyjmenované typy trhů (hodnota `-99`
= „Zápasy“ se s jinými ID nekombinuje, proto dva požadavky). Seznam typů trhů sportu je v
odpovědi v `AvailableGames` (pole 2). Celá nabídka se všemi trhy má ~7 MB → vedlejší trhy jen
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

* **fotbal**: 2 1X2, 4 DNB, 79 OU, 7 AH („Handicap“ = asijský, linie x.0/x.5, čtvrtinové
  vynechány), 88 BTTS, 8 OE, 80/81 týmové totaly; 1. poločas 12/14/113/16/117/114/115,
  2. poločas 123/125/130/127/135/131/132. „Handicap 0:1“ (5, 3-cestný) vynechán.
* **hokej**: 2/4/79/7/88/8/80/81 = základní doba; 228/229/230 „(včetně prodloužení a sam.
  nájezdů)“ → ML/AH/OU|MATCH; třetiny 233 1X2, 240 DNB, 235–237 OU, 241–243 AH, 238 BTTS.
* **tenis**: 178 ML, 209 AH gemy, 210 AH_SETS, 211 OU gemy, 212/213 gemy hráčů, 356 OU_SETS
  „Počet setů“, 221/222/223 set n: vítěz / handicap gemů / počet gemů.
* **basket**: 251/252/253/254/255 „(včetně prodloužení)“ → ML/AH/OU/týmové totaly |MATCH,
  2 „Zápas“ 1/0/2 = 1X2|REG (jen GetLIPEvtsDsk, v GetLiveEventsWL ani v prematch není), 1. poločas
  12/14/113/16, čtvrtiny 1–3 (257 1X2, 262 DNB, 258–260 OU, 263–265 AH). **2. poločas a
  4. čtvrtina vynechány** – není jisté, jestli u basketu nezahrnují prodloužení.
* Výběry: „1“/„0“/„2“, „Pod (x)“/„Nad (x)“, „Tým 1 (±x)“/„Tým 2 (∓x)“ (linie domácích = číslo
  u Týmu 1), „Ano“/„Ne“, „Lichá“/„Sudá“. Neznámý výběr → linie vynechána.
* Pojistka rozsahu: REG/periody s „prodl/nájezd“ v názvu se zahodí, MATCH hokeje a basketu ho
  mít musí.

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
  „Prodloužení“, „Po prodloužení“, „Ukončeno“.
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
  zastaví na 5400 (resp. 2700). V přestávkách StateTime chybí.
* Skóre: `Results[]` s `MainResult` = celkové (tenis: sety), `Flags & 64` = periody („1. poločas“,
  „2. set“ 7:6), tenis `Flags & 1` „Game skóre“ → `points`, gemy aktuálního setu z periody.

## Ověření (30. 9. 2026, 21:25–22:55)

* DOM live stránky vs. `parseLive` nad odpovědí, kterou si stránka sama stáhla: hlavní trh
  364/368 shod (4 rozdíly = náhradní trh 365, který se správně nemapuje), 86/86 v závěrečném
  běhu včetně záložek Góly / Handicap / Gamy / Set / Body (linie, strana, kurz, zámek).
* 25 min long-poll záznamu GetLIPEvtsDsk + 40 min GetLiveEventsWL (inventura typů trhů, stavů,
  přechodů gól → State 3 → State 2).
* Prematch: 28 kurzů z úvodní stránky = parser (zaokrouhlení float32).

## Co nefunguje / omezení

* Live obsahuje jen trhy seznamu (1 trh na skupinu). Plné live trhy = detail každého zápasu
  (`GetWebStandardEventExt` / SignalR) – vynecháno kvůli počtu požadavků.
* Basket 1X2|REG v live už není (je jen v GetLIPEvtsDsk; šlo by přidat druhým požadavkem
  +165 kB/s).
* Vedlejší prematch trhy jen do 24 h (objem dat).
* Rate limit nepozorován (1 req/s dlouhodobě). Token nevyprší během desítek minut; když ano,
  `Result: 0` → obnova.

## Oprava, když se to rozbije

1. `curl -s -X POST -H 'content-type: application/json' -H 'accept: application/json' -d '{"Version":"CZ-I","LanguageID":12,"AppType":1}' https://sport.synottip.cz/WebServices/ApiSession/SportsBettingSessionService.svc/GetLiveInitData`
   – musí vrátit `Result: 1` a `Token`.
2. Live: v app.min.js hledat `getLiveEventsWLAsync` (URL, tělo, hlavička `Verify`); náhradní
   endpoint se stejným tvarem dat je `GetLIPEvtsDsk`.
3. Změna protobuf schématu: v `app.min.js` hledat `GetWebStandardEventsResponse` a
   `e.decode=function` – čísla polí `case N: a.Pole=…` porovnat se `SCHEMA` v `proto.ts`.
4. Nové/změněné typy trhů: `AvailableGames` v odpovědi `GetWebStandardEvents` (ID + název),
   `RULES` v `parse.ts`, fixtures `fixtures/synot/prematch-markets-*.json`, `live-wl*.json`.
5. Nahrání nových fixtures: odpovědi uložit jak jsou (JSON obálka, token nahradit nulami).
