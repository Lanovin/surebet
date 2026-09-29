# SYNOT TIP (`synot`)

Web: <https://sport.synottip.cz> (kurzové sázky; rozcestník www.synottip.cz). Platforma **eBet**
(ASP.NET/WCF na IIS, F5 BIG-IP, React bundle `/reactw/js/app.min.js`; stejný kód obsluhuje i
slovenský TIPOS). **Bez ochrany proti botům:** ověřeno 29. 9. 2026 – curl i Node fetch dostávají
200, žádný Cloudflare/Akamai.

## Strategie

| level | název | scope | stav |
|---|---|---|---|
| 2 | `ebet-api` | prematch + live | ✅ interní API webu, čistý Node fetch, anonymní token |
| 5 | `browser-fetch` | prematch + live | ✅ totéž API přes `fetch` ve stránce sport.synottip.cz (záloha) |

Web má i SignalR (`/WebServices/Api/signalr`, hub `livehub`), ale kurzy jím neposílá – live
stránka long-polluje `GetLIPEvtsDsk`. L3 proto neexistuje.

### Měření (29. 9. 2026 odpoledne)

| | požadavky | data | latence |
|---|---|---|---|
| prematch (4× hlavní nabídka + 4× vedlejší trhy do 24 h) | 8 (+1 token) | ~2,2 MB (API nekomprimuje) | ~1,5 s |
| live (1× GetLIPEvtsDsk) | 1 | ~100 kB | 30–150 ms |

Prematch: ~1 070 zápasů (fotbal ~690, hokej ~135, basket ~125, tenis ~120), ~11 700 trhů.
Live: ~50 zápasů (odpoledne), jen hlavní trhy.

## Endpointy

Vše `POST` s JSON tělem, hlavičky `content-type: application/json;charset=UTF-8` a
**`accept: application/json`** (bez ní WCF odpoví XML). Odpověď `{Result, Token, ReturnValue}`:
`Result` 1 = OK, 0 = chyba (neplatný/prošlý token → adaptér token obnoví a zopakuje).

| účel | URL | tělo |
|---|---|---|
| anonymní token | `/WebServices/ApiSession/SportsBettingSessionService.svc/GetLiveInitData` | `{Version:"CZ-I", LanguageID:12, AppType:1}` → `Token` |
| prematch sportu | `/WebServices/Api/SportsBettingService.svc/GetWebStandardEvents` | `{LanguageID:12, Token, CategoryID:"12", Top:5000, IncludeLiveCategories:false}` |
| prematch vybrané trhy | totéž | navíc `GameIds:[79,7,…]`, `From:"/Date(ms)/"`, `To:"/Date(ms)/"` |
| live všech sportů | `…/SportsBettingService.svc/GetLIPEvtsDsk` | `{ActualEvents:true, LanguageID:12, Token, UseLongPolling:false, TimeStamp:0}` |
| health | `…/SportsBettingSessionService.svc/getServerTime` | `{LanguageID:12, Token, WithTokenCheck:true, SID:""}` |
| detail zápasu (nepoužito) | `…/SportsBettingService.svc/GetWebStandardEventExt` | `{EventID, LanguageID:12, Token, UseLongPolling:true, TimeStamp}` |

Kořenové kategorie (= `DisciplineID` v live): fotbal `12`, hokej `14`, tenis `19`, basket `21`.
Formát dat ve filtru je WCF (`/Date(1790690400000)/`); ISO řetězec vrací chybovou HTML stránku.

`GetWebStandardEvents` bez `GameIds` vrací jen hlavní trh („Zápas“ 1/0/2, tenis „Vítěz zápasu“,
basket „Vítěz (včetně prodloužení)“). S `GameIds` vrací jen vyjmenované typy trhů (hodnota `-99`
= „Zápasy“ se s jinými ID nekombinuje, proto dva požadavky). Seznam typů trhů sportu je v
odpovědi v `AvailableGames` (pole 2). Celá nabídka se všemi trhy má ~7 MB → vedlejší trhy jen
pro zápasy do `marketsHorizonHours` (24 h, v L5 12 h).

`GetLIPEvtsDsk`: s `UseLongPolling:true` a `TimeStamp` z minulé odpovědi server drží spojení,
dokud se data nezmění (~1 s). `TimeStamp` roste zhruba o 10⁷ za sekundu (100ns tiky) – data se
mění průběžně, každá odpověď je **kompletní stav** (ne delta). Adaptér polluje bez long-pollingu.

## Formát dat

**Prematch** – `ReturnValue` je base64 **protobuf** (`GetWebStandardEventsResponse`). Schéma je
výřez ze staticky generovaného protobufjs kódu v `app.min.js` (`proto.ts`, vlastní dekodér bez
knihovny): strom `EventTree.Categories[]` = sport → země/region (`Mezinárodní`, `Česko`) → liga
→ `Base.Events[]`. Událost: `Id`, `Name` „Domácí - Hosté“ (competitors neposílá), `Date.Value`
(epoch ms), `GameGroups[].Games[]` → `Details[]` (jedna linie) → `OddsList[]` (`Name`, `Rate`
**float32** → zaokrouhleno na 2 místa, `State`). Kategorie s `IsVirtual` (zkratky „NHL“, „Liga
národů UEFA“ nahoře v menu) se přeskakují.

**Live** – čistý JSON, `ReturnValue[]` po sportech (`DisciplineID`) s `Events[]`; stejné
`GameGroups` a navíc stav: `StateName`, `StateTime`, `RemainingPeriodTime`, `ClockStopped`,
`Results[]`, `State` (2 běží, 3 ukončeno), `Date` „/Date(ms+0200)/“, `CategoryPath` „Země / Liga“.

**Texty obsahují nezlomitelné mezery** („Tým 1 (-1.5)“) → vše se normalizuje (`norm()`).

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
  2 „Zápas“ 1/0/2 = 1X2|REG (jen v live), 1. poločas 12/14/113/16, čtvrtiny 1–3 (257 1X2,
  262 DNB, 258–260 OU, 263–265 AH). **2. poločas a 4. čtvrtina vynechány** – není jisté, jestli
  u basketu nezahrnují prodloužení.
* Výběry: „1“/„0“/„2“, „Pod (x)“/„Nad (x)“, „Tým 1 (±x)“/„Tým 2 (∓x)“ (linie domácích = číslo
  u Týmu 1), „Ano“/„Ne“, „Lichá“/„Sudá“. Neznámý výběr → linie vynechána.
* Pojistka rozsahu: REG/periody s „prodl/nájezd“ v názvu se zahodí, MATCH hokeje a basketu ho
  mít musí.
* Stav: 0 None (prematch), 1 Created, 2 Opened, 3 Suspended, 4 Closed – otevřené jen 0/2;
  `Detail.Suspended` zavře linii. Suspendovaný výběr bývá s `Rate: 0` → celá linie vynechána.
* Kurz maximálně 35 (limit sázkovky).

## Live stav a přestávky

* `statusText` = `StateName`: „1. poločas“, „Poločas“, „2. třetina“, „Přestávka“ (hokej i basket),
  „3. čtvrtina“, „2. set“, „Nezačalo“ (v live nabídce před začátkem), „Přerušeno“ (tenis),
  „Ukončeno“.
* `breakFlag`: „Poločas“, „Přestávka“ (regex `^poločas$|přestávk|pauza`); `period` z textu nebo
  při přestávce počet odehraných period v `Results`. Basket „Přestávka“ nerozlišuje poločas od
  přestávky mezi čtvrtinami a někdy chodí bez výsledků period → `period` chybí.
* Hodiny: `StateTime` = **uplynulé sekundy od začátku zápasu** (hokej 1. třetina: StateTime 725 +
  RemainingPeriodTime 475 = 1200), `RemainingPeriodTime` → `periodRemainingSec`,
  `ClockStopped` → `clockRunning`. V poločase fotbalu `StateTime` chybí.
* Skóre: `Results[]` s `MainResult` = celkové (tenis: sety), `Flags & 64` = periody („1. poločas“,
  „2. set“ 7:6), tenis `Flags & 1` „Game skóre“ → `points`, gemy aktuálního setu z periody.
* `finished`: „Ukončeno“ nebo `State: 3`.

## Co nefunguje / omezení

* Live jen **hlavní trhy** (fotbal/hokej 1X2, tenis vítěz, basket vítěz vč. prodl. + 1X2).
  Plné live trhy by znamenaly detail zápasu (`GetWebStandardEventExt` / live detail) pro každý
  zápas – vynecháno kvůli počtu požadavků.
* Vedlejší prematch trhy jen do 24 h (objem dat).
* Rate limit nepozorován (desítky požadavků/min). Token nevyprší během desítek minut; když ano,
  `Result: 0` → obnova.

## Oprava, když se to rozbije

1. `curl -s -X POST -H 'content-type: application/json' -H 'accept: application/json' -d '{"Version":"CZ-I","LanguageID":12,"AppType":1}' https://sport.synottip.cz/WebServices/ApiSession/SportsBettingSessionService.svc/GetLiveInitData`
   – musí vrátit `Result: 1` a `Token`.
2. Změna protobuf schématu: v `app.min.js` hledat `GetWebStandardEventsResponse` a
   `e.decode=function` – čísla polí `case N: a.Pole=…` porovnat se `SCHEMA` v `proto.ts`.
3. Nové/změněné typy trhů: `AvailableGames` v odpovědi `GetWebStandardEvents` (ID + název),
   `RULES` v `parse.ts`, fixtures `fixtures/synot/prematch-markets-*.json`.
4. Nahrání nových fixtures: odpovědi uložit jak jsou (JSON obálka, token nahradit nulami).
