# MerkurXtip (`merkurxtip`)

Web: <https://www.merkurxtip.cz/sazeni> (CMS Oryx „platform_v2“, Cloudflare). Sportsbook je
**Altenar** (widget SDK `altenarWSDK`, integrace **`merkurxtip`**), vložený do stránky. Integraci web
získá přes Oryx websocket (`wss://web-api-mehr-wss.oryxgaming.com/ws`, zpráva `open-sportsbook` →
`extras.integration = "merkurxtip"`, anonymně `token: ""`).

## Strategie

| level | název | scope | stav |
|---|---|---|---|
| 2 | `altenar-api` | prematch + live | ✅ veřejné widget API, čistý Node fetch, bez cookies/klíče |
| 5 | `browser-fetch` | prematch + live | ✅ totéž API přes `fetch` ve stránce merkurxtip.cz (záloha) |

Websocket pro kurzy Altenar na tomto webu **nepoužívá** – ověřeno Playwrightem: live přehled
polluje `GetLiveOverview` á 10 s a `GetEventsById` á 5 s, detail zápasu `GetEventDetails` á 5 s.
L3 proto neexistuje.

### Měření (28. 9. 2026 večer)

| | požadavky | data raw | latence |
|---|---|---|---|
| prematch (4× GetEvents + 30× GetEventDetails nejbližších zápasů do 12 h) | 34 | ~3,7 MB (gzip/br ~0,4 MB) | ~5 s |
| live (4× GetLiveEvents paralelně) | 4 | ~30 kB | 0,1–0,5 s |
| browser-fetch live | 4 | ~30 kB | ~1,8 s (+ ~3 s první načtení stránky) |

Prematch: ~1 380 zápasů (fotbal 730 ~ 5 týdnů dopředu, tenis ~370, basket ~140, hokej ~140),
~3 400 trhů. Live (večer): ~15 zápasů.

## Endpointy

Základ `https://sb2frontend-altenar2.biahosted.com/api/widget/`, společné parametry
`culture=cs-CZ&timezoneOffset=-120&integration=merkurxtip&deviceType=1&numFormat=en-GB&countryCode=CZ`.
Žádné hlavičky nejsou potřeba (CORS `Access-Control-Allow-Origin: *`).

| účel | URL |
|---|---|
| prematch sportu (všechny zápasy, hlavní trhy) | `GetEvents?…&sportId=<id>` |
| live sportu (hlavní trhy + stav) | `GetLiveEvents?…&sportId=<id>` |
| live přehled (počty po sportech + zápasy 1. sportu) | `GetLiveOverview?…&sportId=0` |
| víc zápasů podle ID (hlavní trhy) | `GetEventsById?…&eventIds=1,2,3` |
| detail zápasu (všechny trhy a linie) | `GetEventDetails?…&eventId=<id>` |
| menu sportů/lig | `GetSportMenu?…` |
| health | `GetInfo?…` |

Sport ID: fotbal `66`, tenis `68`, basket `67`, hokej `70` (e-sporty 145–148 ignorujeme).
`sportId=0` ani seznam ID nefungují (400 / prázdné). `GetUpcoming` vrací jen ~7 dní,
`GetEventsByChamp` jen první ligu ze seznamu – proto `GetEvents` po sportech.

**Cache:** odpovědi jdou přes Google CDN s `cache-control: public,max-age=3` a hlavičkou `Age`
(0–2 s). Parametr `_=<ms>` cache **neobchází** (CDN normalizuje query) → `fetchedAt` =
čas požadavku − `Age` (nejstarší ze všech odpovědí).

## Formát dat

Normalizovaný JSON: `events[]` (`id`, `name` „A vs. B“, `sportId`, `catId`, `champId`,
`competitorIds[home, away]`, `marketIds[]`, `startDate`, `status` (0 prematch / 1 live /
5 „Pozastaveno“), `et` (0 = zápas), live: `ls`, `liveTime`, `score`, `currentSetScore`,
`pointScore`, `timer`), `markets[]` (`typeId`, `name`, `sv` = hlavní linie, `oddIds`),
`odds[]` (`typeId` výběru, `price`, `oddStatus` 0 = aktivní, `name`), `competitors[]`,
`champs[]` (liga), `categories[]` (země).
Detail: `markets[]` s `desktopOddIds` po sloupcích (všechny linie), každý `odd.sv` = linie;
stejný trh bývá v odpovědi 2× (varianta BetBuilder s podmnožinou linií) → slučujeme podle `id`.

### Mapování trhů (`RULES` v parse.ts)

`typeId` trhů jsou ID trhů **Sportradar UOF**; navíc kontrolujeme název trhu:

* **fotbal**: 1 1X2, 11 DNB, 18 OU, 16 asijský handicap AH, 29 BTTS, 19/20 týmové totaly,
  26 lichý/sudý OE; 1. poločas 60/64/66/68/69/70/75, 2. poločas 83/86/88/90/91/92/95. Vše REG/H1/H2.
  14 (3-cestný handicap) a kombinace vynechány.
* **hokej**: 1 1X2|REG, 11 DNB|REG, 18 „Počet gólů“ OU|REG, 29 BTTS|REG, 19/20 týmové totaly REG;
  406 / 410 / 412 / 414 / 415 „(včetně prodloužení a nájezdů)“ → ML/AH/OU/OU_HOME/OU_AWAY|MATCH;
  třetiny 443 1X2, 446 OU, 460 AH, 459 DNB, 452 BTTS (číslo třetiny z názvu).
* **basket**: 219 / 223 / 225 / 227 / 228 „(vč. prodl.)“ → ML/AH/OU/týmové totaly |MATCH,
  1 1X2|REG, 60/66/68 1. poločas.
* **tenis**: 186 ML, 187 AH (gemy), 188 AH_SETS, 189 OU (gemy), 190/191 gemy hráčů,
  202 / 203 / 204 set n: vítěz / handicap gemů / počet gemů.
* Výběry: 1/2/3 = HOME/DRAW/AWAY, 12/13 = OVER/UNDER, 1714/1715 = AH HOME/AWAY, 74/76 = ANO/NE,
  70/72 = lichý/sudý. Neznámý typ výběru → celý trh vynechán.
* **AH linie**: `sv` je vždy linie domácích (i u výběru hostů: „2 (-1.5)“ má `sv` „+1.5“);
  v listingu linie jen na `market.sv`. Čtvrtinové linie (x.25/x.75) vynechány.
* Pojistka rozsahu: REG/periodové trhy s „prodl/nájezd/rozhodnut“ v názvu se zahodí,
  MATCH trhy hokeje/basketu ho mít musí.
* **Kurzy**: API posílá „přesné“ hodnoty (2.7143, 5.6667), web je ukazuje na 2 místa (a sázka
  posílá cenu na 6 míst, `oddsRounding: Truncate`). Nevíme jistě, s čím se počítá výplata →
  **ořezáváme na 2 desetinná místa** (nikdy nenadsadíme kurz).

## Live stav a přestávky

Z listingu `GetLiveEvents`:

* `statusText` = `ls` (surový text: „1. poločas“, „Poločas“, „2. třetina“, „1. set“,
  „Pozastaveno“, „Neznámý“), `period` z textu („2. třetina“ → 2).
* **Přestávka** (`breakFlag`) podle `ls`: fotbal/basket „Poločas“ (fotbal zároveň
  `timer.isPaused: true`, `matchPhase: 3`), hokej „**První / Druhá přestávka**“ (ověřeno live, AHL;
  `period` = číslo odehrané třetiny), obecně „Přestávka“ (viděno u e-fotbalu), regex
  `^poločas$|přestávk|pauza|konec \d|po \d. …|break`. Text pro přestávku mezi čtvrtinami basketu
  jsme neviděli (e-basket ukazuje jen „n. čtvrtina“ / „Poločas“) – pokud přijde jiný, doplnit
  `BREAK_RE` v parse.ts. „Zápas ještě nezačal“ = v live feedu, ale před začátkem.
* Hodiny: `timer.playtime` (ms k `timer.timeUtc`), `isPaused`, `isTimerCountDown` → `clockSec`
  (fotbal vzestupně) nebo `periodRemainingSec` (odpočet). Když `timer` chybí (hokej, basket),
  bere se `liveTime` „39'“ (kumulativní minuta zápasu) → `clockSec = 38·60`.
* Tenis: `score` = sety, `currentSetScore` = gemy, `pointScore` = body („15:0“), `server`.
  Přestávku mezi sety feed textem nehlásí (jen `ls` „2. set“) → případně řeší clock fallback.

## Co nefunguje / omezení

* Live obsahuje jen **hlavní trhy** listingu (fotbal 1X2 + hlavní total; tenis vítěz, gemy
  handicap/total, sety handicap; hokej 1X2 + ML/AH/OU vč. prodl.; basket ML/AH/OU vč. prodl.).
  Plné trhy live by znamenaly `GetEventDetails` pro každý zápas (web to dělá á 5 s jen pro
  otevřený zápas) – vynecháno kvůli počtu požadavků.
* `ctx.browser.fetchInPage` nejde použít: posílá `credentials: 'include'`, což API s `ACAO: *`
  odmítne (CORS) → L5 volá `fetch` bez credentials přes `browser.withPage()` + `page.evaluate`.
  *Návrh změny frameworku:* volitelný parametr `credentials` ve `fetchInPage`.
* Rate limit nepozorován (desítky požadavků/min, žádné 429). Cloudflare na webu, API bez ochrany.

## Oprava, když se to rozbije

1. `curl 'https://sb2frontend-altenar2.biahosted.com/api/widget/GetSportMenu?culture=cs-CZ&timezoneOffset=-120&integration=merkurxtip&deviceType=1&numFormat=en-GB&countryCode=CZ'`
   – 400 = špatná integrace/parametry. Integraci zjistit z Oryx websocketu (Playwright:
   `framereceived` s `open-sportsbook`) nebo z `https://sb2wsdk-altenar2.biahosted.com/altenarWSDK.js`
   (`altenarWSDKOrigins.web` = základ API).
2. Změna hostu: `altenarWSDKOrigins` v `altenarWSDK.js` (web/topEvents).
3. Nové/změněné typy trhů: `fixtures/merkurxtip/detail-*.json` a `RULES` v `parse.ts`.
