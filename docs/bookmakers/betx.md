# betx (https://bet-x.cz)

**Pozor na doménu:** `betx.cz` (i `www.betx.cz` → `betx.cz`) je **zaparkovaná doména** registrátora INWX
(„Domain parked“, ~4 kB, Cloudflare). Skutečná sázkovka BETX (provozovatel EVONA ELECTRONIC, česká licence)
je na **https://bet-x.cz** (`www.bet-x.cz` → 301), mobil `https://m.bet-x.cz`.

**Platforma:** vlastní platforma Evona (Angular SPA na IIS/ASP.NET; hosty `*.betx.bet`), kurzy ze
Sportradar UOF (každý kurz v listingu nese `UofKey`). Není to Altenar/Kambi/… – s kingsbet sdílí jen UOF id
trhů (mapovací tabulka `src/adapters/common/uof.ts`).

Jak se to zjistilo: `https://bet-x.cz/assets/config.json` → `API.URL.Terminal =
https://evonaapicz.betx.bet/api/terminal`; `GET …/terminal/configuration/client/CZEWeb` →
`SportApiUrl = https://sportapis-cz.betx.bet/SportsOfferApi/api/sport/`; cesty endpointů z `main-es2015.*.js`.

## Strategie

| level | název | scope | požadavky | stáří dat | poznámka |
|---|---|---|---|---|---|
| 2 | `betx-api` | prematch | ~22–23 / sken (stránky po 100 zápasech) | – | ~7 MB JSON (server **nekomprimuje**), ~4 s |
| 2 | `betx-api` | live (záloha) | 4 / 6 s (základ + 3 průchody) | 0–11 s (cache serveru) | |
| 3 | `betx-push` | live | 5 WebSocketů + listing 1 / 30 s (+4 průchody / 2 min) | ~0,1–0,5 s | **primární pro LIVE** (runner s `preferPush` ho bere první) |
| 5 | `betx-browser` | obojí | stejné URL jako L2 přes `fetch()` v Chromiu | jako L2 | |

L5 stránka stojí na `https://bet-x.cz/assets/config.json` (CORS povoluje jen origin `https://bet-x.cz`),
SPA se nenačítá. L2/L5 sdílí `fetchRaw()` + `parseRaw()`, L3 sdílí `parseBetxMatches()`.

Naměřeno 30. 9. 2026: prematch 1 417 událostí (fotbal 979, tenis 131, basket 104, hokej 203), 3 196 trhů;
live večer 45–75 zápasů (fotbal/tenis/basket/hokej), ve 22:45 ~25.

## Endpointy (SportsOfferApi)

Základ `https://sportapis-cz.betx.bet/SportsOfferApi/api/sport/`. **Povinné hlavičky:**
`Device-Type: desktop` a `TerminalId: 1` (bez nich HTTP 200 s tělem `[]`); `LanguageId: cs` pro české
názvy – **pozor**, server upřednostní `Accept-Language` (Node `fetch` bez něj posílá `*` → anglické názvy;
`HttpClient` posílá `cs-CZ`, takže adaptér dostává češtinu). Cookies ani token nejsou potřeba. CORS:
`access-control-allow-origin: https://bet-x.cz`.

| endpoint | použití |
|---|---|
| `offer/v3/matches/flat?Offset=&Limit=100&DateFrom=ISO[&DateTo=ISO]&SportIds=388&BetTypeKey=60` | prematch – ploché pole `{Count, Response[]}`; `BasicOffer` (1X2 / vítěz) + v `Offers[]` hlavní linie zvoleného `BetTypeKey`. **Max. 100 zápasů na stránku**. Už začaté zápasy nevrací (ani s `DateFrom` v minulosti) |
| `offer/v3/matches/live?SportIds=388,389,391,398[&BetTypeKey=5_-1]` | live – strom sport → Categories → Leagues → Matches, `BasicOffer` + stav; s BetTypeKey hlavní linie daného typu (zápasy bez něj mají jen BasicOffer nebo nic) |
| `offer/v3/match/offers?MatchId=N` | všechny trhy zápasu (~40–200 kB) – nepoužito |
| `offer/v3/sportsmenu/live` | healthCheck (~0,3 kB), počty live zápasů podle sportu |
| `signalr` (hub `notificationv3`) | live push – viz níže (L3) |

SportId: fotbal 388, tenis 389, basket 391, hokej 398 (425 „BETX Superšance“ = speciály – ignoruje se).
Konfigurace webu: `https://evonaapicz.betx.bet/api/terminal/configuration/initialization/CZEWeb`
(`OfferBonusPercent 0`, `OfferLiveBonusPercent 0`, `MinShowingOdds 1.0`, `OddsRepresentation decimal`,
`ExtendedLiveConfig` = live typy sázek, které web nabízí v přehledu pro každý sport).

### Průchody (BetTypeKey)

Listing vrací vždy jen BasicOffer + **jeden** typ sázky; víc typů = víc průchodů (čárkou oddělené klíče
server ignoruje). Výchozí (`DEFAULT_OPTIONS` ve `strategies.ts`):

| sport | BasicOffer | prematch (1. přes celou nabídku, další do 72 h) | live listing (L2) |
|---|---|---|---|
| fotbal | 1X2 (UOF 1) | `60` počet gólů (18), `4` handicap 2-cestný (16) | `5_-1` počet gólů (18) |
| hokej | 1X2 (1) | `2` vítěz vč. prodl. a nájezdů (406), `60` počet gólů (18) | `5_-1` (18), `7_106` vítěz vč. prodl. a nájezdů (406) |
| tenis | vítěz (186) | `911` počet gemů (189), `910` handicap gemy (187) | – |
| basket | prematch vítěz vč. prodl. (219), **live 1X2 základní doby (1)** | `1004` počet bodů (225), `1003` handicap (223), vše vč. prodl. | `7_37` vítěz vč. prodloužení (219) |

Ověřené live klíče (UofKey v listingu 30. 9.): hokej `8_1140` → 412 (total vč. prodl.+SN), `7_1142` → 410
(handicap vč. prodl.+SN); basket `7_38` → 223, `8_39` → 225 (vč. prodl.); tenis `7_922` → 187 (handicap
gemy), `8_83` → 189 (počet gemů). Linie všech těchto trhů platí na **celý zápas** (už dané góly/body/gemy
se počítají), handicap z pohledu domácích (`Sbv` = `hcp` v UofKey).

**Nemapovat** (na webu vypadají jako 1/x/2 nebo 1/2): `6_4` „Vyhraje zbytek zápasu [2:0]“, `6_13` „Další
gól [3]“, `4_-1` evropský „Handicap góly [0:3]“, basket `7_34` handicap bez prodloužení vs. `7_38` vč.
prodloužení, `6_1372`/`7_1366` 2. poločas vč. prodloužení, `7_64` „Kdo dá bod N“, kombinace `8_1523` ….
V listingu je chrání UofKey (jiné UOF id), v push tabulka `PUSH_BET_TYPES` (jen vyjmenované typy).

### UofKey

`uof:{producer}/sr:sport:{srSport}/{uofMarket}/{uofOutcome}?{specifikátory}` – producer 3 = prematch,
1 = live; např. `uof:3/sr:sport:4/18/13?total=5.5` = hokej, total 5.5, under. Výběr se bere z UOF id
výsledku (ne z `Type`/`Name` – u prematch totalu je `Type "1"` = méně!). Neznámé/variantní trhy
(`sr:correct_score:…`) se přeskočí.

Kurzy: `Odd` (max. 2 desetinná místa pod 10, nad 10 max. 1 – web zobrazuje `<10` na 2, `10–100` na 1,
`≥100` na 0 desetinných míst, bez bonusu → **API `Odd` = kurz na webu i na tiketu**, ověřeno proti DOM).
`Odd: 0` + `Active: false` = výsledek stažený (web zámek) → vynechán, ostatní výsledky trhu zůstávají
otevřené. `Active: false` s kurzem → `open: false`. Nabídka `Active`/`IsEnabled`, zápas `IsBlocked`,
v live `LiveIsBlocked`/`LiveIsDisabled`/`LiveBettingEnabled=false`/`IsLiveMatchAvailable=false` →
trh `open: false` (web sám z toho používá jen `odd.active` – jsme přísnější).

## Serverová cache live listingu (důležité)

* Live listing se generuje při prvním dotazu po vypršení a pak ~**10–11 s** vrací beze změny (poll po 1 s:
  nový obsah přesně každých ~11 s; první dotaz po vypršení trvá 100–270 ms, z cache ~40 ms).
* Klíčem cache je **jen hodnota `SportIds`** – `BetTypeKey` ani pořadí parametrů se nepočítá
  (`SportIds=398,388&BetTypeKey=5_-1` hned po `SportIds=398,388` vrátí základní listing). Každý průchod
  proto má vlastní řetězec (`388,398,388`), viz `liveUrl()`/`livePasses()`.
* `LiveUpdateTimestamp` = poslední živá aktualizace zápasu; **max přes listing ≈ okamžik vygenerování**
  (u desítek zápasů s přesností ~0,2 s). `fetchedAt` L2/L5 = `max(LiveUpdateTimestamp)`, ale nejdřív
  `start dotazu − 11,5 s` (`liveGeneratedAt()`); přes průchody nejstarší. Dřív se bralo „teď“ → data až
  11 s stará se tvářila jako čerstvá.
* Měřeno 30. 9. (6 min, 72 pollů po 5 s): stáří dat při stažení 0 / 5 / 10 s (průměr 5,3 s); 1X2/vítěz
  z listingu = push stav v okamžiku vygenerování u 98,9 % kurzů, ale v okamžiku stažení už jen 83,6 %
  (total 87,9 %) – zbytek web už ukazoval jinak.
* Suspendovaný zápas (betstop po gólu apod.) z listingu **zmizí** až s dalším vygenerováním; do té doby
  (až ~11 s) listing ukazuje předchozí kurzy jako aktivní. Příklad: Crystal Palace – Charlton 30. 9.
  19:51:50.1 push suspendace (pak gól na 3:0), listing vygenerovaný 19:51:42.3 servíroval kurzy
  „otevřené“ do 19:51:52.5 (fixture `betx-api-live-timed.json`).
* Polling po 6 s (`LIVE_POLL_MS`) trefí nové vygenerování každým druhým dotazem (stáří 0 / 6 s); po 5 s by
  bylo 0 / 5 / 10 s a víc požadavků.

Prematch `matches/flat` touto cache netrpí (různé `BetTypeKey` vrací různé trhy).

## Live push (SignalR) – L3 `betx-push`

Klasický ASP.NET SignalR (protokol 1.5), hub `notificationv3` – totéž, co používá web v Live přehledu:

1. `GET {api}signalr/negotiate?clientProtocol=1.5&TerminalId=1&LanguageId=cs&connectionData=[{"name":"notificationv3"}]`
   → `ConnectionToken` (bez hlaviček Device-Type, stačí `Origin`)
2. `wss://sportapis-cz.betx.bet/SportsOfferApi/api/sport/signalr/connect?transport=webSockets&…&connectionToken=…`
3. `GET …/signalr/start?transport=webSockets&…` → `{"Response":"started"}`
4. `{"H":"notificationv3","M":"RegisterMatches","A":[[388]],"I":0}` a volitelně
   `{"H":"notificationv3","M":"RegisterSportBetType","A":[388,"5_-1",true],"I":1}`

Chování serveru (ověřeno):

* **Jedno spojení = jeden sport + nanejvýš jeden registrovaný typ.** Další `RegisterMatches` /
  `RegisterSportBetType` na stejném spojení předchozí nahradí (`RegisterMatches([[388,389,391,398]])` vrací
  jen fotbal). Web to dělá stejně (přehled jednoho sportu + jeden typ ve výběru). Proto
  `PUSH_DEFAULTS.pushBetTypes`: fotbal `5_-1`, hokej `5_-1` + `7_106`, basket `7_37`, tenis `7_922` = 5 spojení.
* `liveUpdated` nese **celý stav zápasu** (zkrácená pole: `lms`, `lmt`, `lmts`, `lmto`, `lmsc`, `lssc`,
  `lgsc`, `lma`, `b`, `bo` = BasicOffer, `cofs` = registrovaný typ; nabídka `bt`, `sbv`, `a`, `e`,
  kurzy `n`/`on`/`o`/`a`), ale **ne týmy, soutěž, začátek ani UofKey**. Po registraci přijde celý seznam
  zápasu sportu, pak změny do ~0,1–0,5 s od `LiveUpdateTimestamp` (dávkově každých ~10 s zápasy změněné
  v posledních 10 s). Zápas bez změny (i suspendovaný) push mlčí i minuty – **ticho = beze změny**.
  Keep-alive `{}` ~každých 10 s; `liveStatus [1]` (0 = web zamkne všechny live kurzy).
* Suspendace: `bo.a=false` + všechny kurzy `a=false` → `open: false` okamžitě.
* `RegisterForMatches(matchIds)` (oblíbené zápasy webu) posílá celou rozšířenou nabídku zápasu napříč
  sporty (~100 kB/s pro 60 zápasů) – zbytečně těžké, nepoužito. `RegisterForExtended` viz starší poznámky:
  jen jeden zápas.

Implementace (`BetxPushStrategy.subscribe`): listing při startu a každých 30 s (týmy, soutěž, začátek,
nové zápasy; každý 4. běh i BetTypeKey průchody) + neznámé id z push → relist (max. 1× za 12 s).
Trhy jen z push přes `PUSH_BET_TYPES` (`"sportId|bt"` + `OrigName` → UOF trh/výsledek, linie = `sbv`) →
složený UofKey → stejné `parseOffers()` jako listing. `checkPushTable()` porovná tabulku s UofKey každého
listingu – nesouhlasící typ se za běhu vyřadí (log error). Stav zápasu (bo) z nejčerstvější zprávy
kteréhokoli spojení sportu, `cofs` jen ze spojení, které typ registruje (`pushSnapshot()`).
Mrtvé spojení (žádná zpráva 25 s) → terminate + reconnect s backoffem; jeho data se zahodí a sport bez
živého spojení se nevydává. Emit při změně (throttle 250 ms) a heartbeat každou 1 s (drží `seenAt`,
`fetchedAt` = okamžik emitu – push hlásí každou změnu).

Ověřeno proti DOM webu 30. 9. 22:45–22:52 (Playwright, jedna stránka): 23 živých zápasů (fotbal 8,
tenis 9, basket 6), 261 porovnání řádků 1X2/vítěz vč. zámků – shoda až na souběh v řádu stovek ms.
Prematch: 25 fotbalových zápasů z přehledu webu, 25/25 shodných 1X2.

## Live stav a přestávky

| pole (listing / push) | příklad |
|---|---|
| `LiveMatchTimeState` / `lmts` | `1. poločas`, `Přestávka`, `2. třetina`, `3.čtvrtina`, `přestávka`, `2.set`, `přerušeno`, `Konec zápasu`, `konec` |
| `LiveMatchTimeOrigName` / `lmto` | `LB_SOCCER_1P`, `LB_SOCCER_PAUSED`, `LB_ICE_HOCKEY_3P`, `LB_BASKETBALL_PAUSED`, `LB_TENNIS_2SET`, `LB_*_ENDED` |
| `LiveStatusString` (jen listing) | `1p`, `2p`, `paused`, `3q`, `2set`, `interrupted`, `ended` |
| `LiveMatchState` / `lms` | `1` hraje se, `2` konec |
| `LiveMatchTime` / `lmt` | **odehrané minuty zápasu** (herní čas): fotbal `45` v HT, hokej `40` ve 2. přestávce, basket FIBA `23` = 3. min 3. čtvrtiny, `20` v poločase; tenis nic |
| `LiveMatchScore` / `lmsc` | `"2 : 1"` domácí : hosté (tenis: sety) |
| `LiveSetScore` / `lssc` | dílčí skóre `"2 : 0 - 0 : 1"` (tenis: gemy po setech, poslední = aktuální) |
| `LiveGameScore` / `lgsc` | tenis body `"15 : 30"` |

Kompletní seznam kódů je v překladech webu (`…/api/terminal//translation/cs/CZEWeb`, klíče `LB_*`):
fotbal `1P`, `2P`, `PAUSED`, `OT`, `1P_OT`, `2P_OT`, `PEN`, `ENDED`, `INTERRUPTED`; hokej `1P–3P`, `PAUSED`,
`OT`, `PEN`, `ENDED`; basket `1Q–4Q`, `PAUSE1–3`, `PAUSED`, `AWAITING_OT` (přestávka), `OT`, `AFTER_OT`
(konec), `ENDED`; tenis `1SET–5SET`, `INTERRUPTED`, `RETIRED` (skreč), `WALKOVER`, `ENDED`.

`breakFlag` = `paused` / `*PAUSE*` / `*AWAITING*` / text „přestávka“; `finished` = `ended`, `*_ENDED`,
`*_AFTER_OT`, `RETIRED`, `WALKOVER`, `LiveMatchState 2`; `period` z kódu (`_2P`, `_3Q`, `_2SET`), jinak
počet dílčích skóre; `clockSec` = `LiveMatchTime` × 60 pro fotbal, hokej i basket (herní čas od začátku).
Tenisová přestávka mezi sety feed nehlásí (`přerušeno` = přerušení, ne přestávka).

## Identita událostí a začátek

* **Live používá stejné `Id` jako prematch** (ověřeno 30. 9. na 3 zápasech po výkopu: 74598540,
  74272460, 75089864 – shodné i `EventCode`, `BetxId`). Matcher tedy live a prematch propojí.
* `MatchStartTime` (i `LiveMatchStartTime`, vždy stejné) je **plánovaný** začátek, ne skutečný výkop
  (zápas s výkopem ~20:00:45 má dál `20:00:00Z`). U tenisu ho betx posouvá (75089864: prematch 20:00Z,
  v live 20:20Z).

## Rate limity (IIS 403)

`403 - Forbidden: Access is denied.` (IIS, pár sekund až desítky sekund) přichází při krátkých dávkách
požadavků z jedné IP – 30. 9. opakovaně, když se načítala stránka webu (~25 požadavků najednou) souběžně
s naším listingem; samotný polling 2 dotazy / 5 s ani 5 WebSocketů 403 nevyvolaly (WebSockety při 403 na
REST běžely dál). Proto: live polling 6 s, push relist řídce, spojení se rozjíždí po 500 ms. Fixtures
`broken-2026-09-28*` jsou tyto 403 na live listingu.

## Když se to rozbije

1. `npx tsx scripts/try-adapter.ts betx live --strategy=betx-api` / `prematch`. Tělo `[]` → chybí hlavičky
   `Device-Type`/`TerminalId` (nebo se změnilo `TerminalId` – viz `…/configuration/client/CZEWeb`,
   `DefaultTerminalId`).
2. Změna hostu: `https://bet-x.cz/assets/config.json` → `API.URL.Terminal` →
   `GET {Terminal}/configuration/client/CZEWeb` → `SportApiUrl`.
3. Chybějící totaly v live listingu → cache (viz výše) – průchod musí mít unikátní `SportIds`.
4. Push: log `push mapping disagrees with listing UofKey` = betx změnil význam BetTypeKey → opravit
   `PUSH_BET_TYPES` podle UofKey v listingu (test „push tabulka odpovídá UofKey“ s novou fixture).
   Žádná data z push → zkontrolovat v prohlížeči (DevTools → WS) jména metod/zpráv hubu.
5. Nové trhy: podle `UofKey` doplnit `src/adapters/common/uof.ts` (sdílené – domluvit s vlastníkem);
   BetTypeKey najít v `offer/v3/match/offers?MatchId=…` nebo v `ExtendedLiveConfig` konfigurace webu.
6. Když by API začalo blokovat node klienta, runner přepne na `betx-browser` (L5).
