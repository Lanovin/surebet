# betx (https://bet-x.cz)

**Pozor na doménu:** `betx.cz` (i `www.betx.cz` → `betx.cz`) je **zaparkovaná doména** registrátora INWX
(„Domain parked“, ~4 kB, Cloudflare). Skutečná sázkovka BETX (provozovatel EVONA ELECTRONIC, česká licence)
je na **https://bet-x.cz** (`www.bet-x.cz` → 301), mobil `https://m.bet-x.cz`.

**Platforma:** vlastní platforma Evona (Angular SPA na IIS/ASP.NET; hosty `*.betx.bet`), kurzy ze
Sportradar UOF (každý kurz nese `UofKey`). Není to Altenar/Kambi/… – s kingsbet sdílí jen UOF id trhů
(mapovací tabulka `src/adapters/kingsbet/uof.ts`).

Jak se to zjistilo: `https://bet-x.cz/assets/config.json` → `API.URL.Terminal =
https://evonaapicz.betx.bet/api/terminal`; `GET …/terminal/configuration/client/CZEWeb` →
`SportApiUrl = https://sportapis-cz.betx.bet/SportsOfferApi/api/sport/`; cesty endpointů z `main-es2015.*.js`.

## Strategie

| level | název | scope | požadavky / fetch | data | latence |
|---|---|---|---|---|---|
| 2 | `betx-api` | prematch | ~22–23 (stránky po 100 zápasech, víc průchodů) | ~7 MB JSON (server **nekomprimuje**) | ~3,5 s |
| 2 | `betx-api` | live | 2 (listing + 1 BetTypeKey průchod) | ~110 kB | ~0,2 s |
| 5 | `betx-browser` | obojí | stejné URL přes `fetch()` v Chromiu | stejné | live ~0,1 s, prematch ~2,5 s (+ start prohlížeče) |

L5 stránka stojí na `https://bet-x.cz/assets/config.json` (CORS povoluje jen origin `https://bet-x.cz`),
SPA se nenačítá. Obě strategie sdílí `fetchRaw()` + `parseRaw()`.

Naměřeno 28. 9. 2026 ~23:00: prematch 1 372 událostí (fotbal 922, tenis 199, basket 96, hokej 155),
~3 000 trhů; live 13–19 událostí.

## Endpointy (SportsOfferApi)

Základ `https://sportapis-cz.betx.bet/SportsOfferApi/api/sport/`. **Povinné hlavičky:**
`Device-Type: desktop` a `TerminalId: 1` (bez nich HTTP 200 s tělem `[]`); `LanguageId: cs` pro české
názvy. Cookies ani token nejsou potřeba. CORS: `access-control-allow-origin: https://bet-x.cz`,
povolené hlavičky `device-type,languageid,terminalid`.

| endpoint | použití |
|---|---|
| `offer/v3/matches/flat?Offset=&Limit=100&DateFrom=ISO[&DateTo=ISO]&SportIds=388&BetTypeKey=60` | prematch – ploché pole zápasů `{Count, Response[]}`; každý zápas má `BasicOffer` (1X2 / vítěz) + v `Offers[]` hlavní linii zvoleného `BetTypeKey`. **Max. 100 zápasů na stránku** (větší `Limit` ignoruje, default 50) |
| `offer/v3/matches/live?SportIds=388,389,391,398[&BetTypeKey=5_-1]` | live – strom sport → Categories → Leagues → Matches, `BasicOffer` + stav; s BetTypeKey místo BasicOffer hlavní linie daného typu |
| `offer/v3/match/offers?MatchId=N` | všechny trhy zápasu (~40–200 kB, nekomprimováno) – nepoužito (drahé) |
| `offer/v3/sportsmenu/live` | healthCheck (~0,3 kB) |
| `offer/v3/sports?OddsFilter=0` | strom sportů s počty |
| `signalr` (hub `notificationv3`) | viz níže |

SportId: fotbal 388, tenis 389, basket 391, hokej 398 (další: 425 „BETX Superšance“ = speciály – ignoruje se).

### Průchody (BetTypeKey)

Listing vrací vždy jen BasicOffer + **jeden** typ sázky; víc typů = víc průchodů (čárkou oddělené klíče
server ignoruje). Výchozí (`DEFAULT_OPTIONS` ve `strategies.ts`):

| sport | BasicOffer | průchody (1. přes celou nabídku, další jen do 72 h) |
|---|---|---|
| fotbal | 1X2 (UOF 1) | `60` počet gólů (18), `4` handicap 2-cestný (16) |
| hokej | 1X2 (1) | `2` vítěz vč. prodl. a nájezdů (406), `60` počet gólů (18) |
| tenis | vítěz (186) | `911` počet gemů (189), `910` handicap gemy (187) |
| basket | vítěz vč. prodl. (219) | `1004` počet bodů vč. prodl. (225), `1003` handicap vč. prodl. (223) |
| live | 1X2 / vítěz | `5_-1` počet gólů (fotbal + hokej) |

Další užitečné klíče: `43` BTTS, `47` DNB, `42` 1. poločas 1X2, `5000` 1. poločas počet gólů; live
`7_16` DNB, `7_106` vítěz hokej, `7_922` tenis handicap gemy.

### UofKey

`uof:{producer}/sr:sport:{srSport}/{uofMarket}/{uofOutcome}?{specifikátory}` – producer 3 = prematch,
1 = live; např. `uof:3/sr:sport:4/18/13?total=5.5` = hokej, total 5.5, under. Handicap `hcp` je z pohledu
domácích (`hcp=-1.5` = domácí −1.5). Výběr se bere z UOF id výsledku (ne z `Type`/`Name` – u totalu je
`Type "1"` = méně!). Neznámé/variantní trhy (`sr:correct_score:…`) se přeskočí.

Kurzy: `Odd` (2 desetinná místa), `Active`; nabídka `Active`/`IsEnabled`; zápas `IsBlocked`,
v live `LiveIsBlocked`/`LiveIsDisabled`/`LiveBettingEnabled` → `open: false`. `Odd: 0` = kurz chybí → vynechán.

## Live stav a přestávky

| pole | příklad |
|---|---|
| `LiveMatchTimeState` | `1. poločas`, `Přestávka`, `2. třetina`, `1.čtvrtina`, `2.set`, `přerušeno`, `Konec zápasu` |
| `LiveMatchTimeOrigName` | `LB_SOCCER_1P`, `LB_SOCCER_PAUSED`, `LB_ICE_HOCKEY_2P`, `LB_ICE_HOCKEY_PAUSED`, `LB_BASKETBALL_1Q`, `LB_TENNIS_2SET`, `LB_TENNIS_INTERRUPTED`, `LB_SOCCER_ENDED` |
| `LiveStatusString` | `1p`, `2p`, `paused`, `1q`, `2set`, `interrupted`, `ended` |
| `LiveMatchTime` | odehrané minuty (fotbal `45` v HT, hokej `20` v 1. přestávce, `22` ve 2. třetině) |
| `LiveMatchScore` | `"2 : 1"` (tenis: sety) |
| `LiveSetScore` | dílčí skóre `"2 : 0 - 0 : 1"` (tenis: gemy po setech, poslední = aktuální set) |
| `LiveGameScore` | tenis body `"15 : 30"` |

`breakFlag` = `LiveStatusString === "paused"` nebo `*_PAUSED` / text „Přestávka“ (fotbalový poločas i
hokejová přestávka – obojí pozorováno). `period` z OrigName (`_2P`, `_1Q`, `_3SET`), jinak počet dílčích
skóre (HT → 1). `finished` = `ended` / `*_ENDED`. `clockSec` = minuty × 60 jen fotbal a hokej (u basketu
nejasné, zda jde o čas zápasu či čtvrtiny). Tenisová přestávka mezi sety pozorována nebyla (`přerušeno`
= přerušení, ne přestávka).

## Serverová cache (důležité)

Live listing je na serveru cachovaný **~10 s** a klíčem cache je jen řetězec `SportIds` – `BetTypeKey`
se ignoruje. Dotaz `SportIds=388,389&BetTypeKey=5_-1` hned po `SportIds=388,389` dostane základní listing
bez totalů. Proto má každý BetTypeKey průchod vlastní řetězec (duplicitní id: `388,389,388`), viz
`liveUrl()`. Obsah se mění po ~10 s (ověřeno pollováním po 1 s: nový hash každých 10,1–10,3 s) – živé kurzy
z betx mají tedy zpoždění až ~10 s; polling po 1 s server nezatěžuje (odpovídá z cache).
Prematch `matches/flat` tímto netrpí (různé `BetTypeKey` vrací různé trhy).

## Rate limity

Žádný 403/429 při ~5 req/s. IIS nekomprimuje (i s `Accept-Encoding: gzip` jde 380 kB na stránku) – proto
horizont 72 h pro 2.+ průchody. Prematch sken ≈ 7 MB / 30–60 s.

## Websocket (SignalR) – zdokumentováno, neimplementováno

Klasický ASP.NET SignalR 2 (jQuery), hub `notificationv3`:

1. `GET {api}signalr/negotiate?clientProtocol=2.1&TerminalId=1&LanguageId=cs&connectionData=[{"name":"notificationv3"}]`
   → `ConnectionToken`, `TryWebSockets: true`
2. `wss://sportapis-cz.betx.bet/SportsOfferApi/api/sport/signalr/connect?transport=webSockets&…&connectionToken=…`
3. `GET …/signalr/start?…` → `{"Response":"started"}`
4. volání `{"H":"notificationv3","M":"RegisterForMatches","A":[[388,389,391,398]],"I":0}`; další metody
   `RegisterSports`, `RegisterMatches`, `RegisterForExtended(matchIds)`, `RegisterForOffers(ids)`,
   `RegisterSportBetType(sportId, betTypeKey, true)`, `RegisterActiveMatchesCount`, `LiveStatus`.
   Události: `sportUpdated`, `liveUpdated`, `liveExtendedUpdated`, `liveOfferUpdated`, `liveMatchesCount`, `liveStatus`.

Pozorování: `RegisterForMatches` uspěje, ale za 60 s nepřišel žádný `liveUpdated`; `RegisterForMatches(389)`
(číslo) → chyba hubu. `RegisterForExtended([ids])` posílá `liveExtendedUpdated` jen pro první zápas,
~18 kB snapshot každých ~10 s, se zkrácenými poli (`lmts`, `lmsc`, `ofs[].odds[].o`) a **bez UofKey**
(jen interní `bt` kódy jako `2_-1`). Push je tedy stejně pomalý jako cache listingu a hůř mapovatelný →
polling listingu (1–2 požadavky) je lepší.

## Když se to rozbije

1. `npx tsx scripts/try-adapter.ts betx live` / `prematch`. Tělo `[]` → chybí hlavičky
   `Device-Type`/`TerminalId` (nebo se změnilo `TerminalId` – viz `…/configuration/client/CZEWeb`,
   `DefaultTerminalId`).
2. Změna hostu: `https://bet-x.cz/assets/config.json` → `API.URL.Terminal` →
   `GET {Terminal}/configuration/client/CZEWeb` → `SportApiUrl`.
3. Chybějící totaly v live → zkontrolovat cache (viz výše) – průchod musí mít unikátní `SportIds`.
4. Nové trhy: podle `UofKey` doplnit `src/adapters/kingsbet/uof.ts`; BetTypeKey najít v
   `offer/v3/match/offers?MatchId=…` (pole `BetTypeKey`) nebo v `CommonHeaders` listingu.
5. Když by API začalo blokovat node klienta, runner přepne na `betx-browser` (L5).
