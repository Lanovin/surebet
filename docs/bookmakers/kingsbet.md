# kingsbet (www.kingsbet.cz)

**Platforma:** web (CMS + kasino) běží na Oryx/iGP, sportsbook je **Altenar** (widget SDK `altenarWSDK`,
`integration=kingsbet`). Kurzy jsou Sportradar – `market.typeId` = UOF id trhu, `odd.typeId` = UOF id výsledku.

Jak se to zjistilo: `/sport` obsahuje `<altenar-sportsbook>`; web přes websocket
`wss://web-api-igp-kbhr-wss.oryxgaming.com/ws` pošle `open-sportsbook` a dostane
`{"integration":"kingsbet","url":"https://sb2widgetsstatic-altenar2.biahosted.com/",…}`. SDK loader
`https://sb2wsdk-altenar2.biahosted.com/altenarWSDK.js` obsahuje `altenarWSDKOrigins` (API hosty).

## Strategie

| level | název | scope | požadavky / fetch | data | latence |
|---|---|---|---|---|---|
| 2 | `altenar-api` | prematch | 4 listingy + ≤ 20 detailů | ~2 MB JSON (~0,5 MB gzip) | ~3,5 s |
| 2 | `altenar-api` | live | 4 (jeden na sport) | ~30 kB JSON (~12 kB gzip) | 0,2–0,5 s |
| 5 | `altenar-browser` | obojí | stejné URL přes `fetch()` v Chromiu | stejné | live ~0,1 s, prematch ~1,5 s (+ start prohlížeče) |

Obě strategie sdílí `fetchRaw()` + `parseRaw()`; liší se jen transportem. L5 stránka stojí na
`https://www.kingsbet.cz/robots.txt` (SPA se nenačítá) a volá API s `credentials: 'omit'`.

Naměřeno 28. 9. 2026 ~23:00 (málo live): prematch 847 událostí (fotbal 410, tenis 250, basket 105,
hokej 82), ~2 200 trhů; live 17 událostí.

## Endpointy

Základ: `https://sb2frontend-altenar2.biahosted.com/api/` (Cloudflare, `access-control-allow-origin: *`,
`cache-control: public,max-age=3`). Společné parametry (stejné jako web):

```
culture=cs-CZ&timezoneOffset=-120&integration=kingsbet&deviceType=1&numFormat=en-GB&countryCode=CZ
```

Žádné cookies, token ani speciální hlavičky nejsou potřeba (posíláme `Origin/Referer: https://www.kingsbet.cz`).

| endpoint | použití |
|---|---|
| `widget/GetEvents?…&eventCount=0&sportId={66,68,67,70}` | prematch listing sportu – **všechny** zápasy (ne outrighty) se 3–6 hlavními trhy (`headers`) |
| `widget/GetLiveEvents?…&eventCount=0&sportId=X` | live listing sportu s hlavními trhy a stavem |
| `widget/GetEventDetails?…&eventId=N&showNonBoosts=false` | všechny trhy události (~80 trhů, ~14 kB gzip) |
| `Widget/GetSportInfo?…` | healthCheck (malé) |
| `widget/GetSportMenu?…&period=0` | strom sport → kategorie → soutěž (počty vč. outrightů) |
| `widget/GetLiveOverview?…&sportId=X`, `widget/GetLivenow` | to, co polluje web na live stránce (jen 1 sport) |

sportId: fotbal 66, tenis 68, basket 67, lední hokej 70 (e-sporty jsou samostatné sporty 145–148 → ignorují se).

### Formát listingu (normalizované entity)

```json
{ "events": [{ "id": 17726915, "name": "América-MG vs. Juventude", "sportId": 66, "catId": 593, "champId": 11005,
               "startDate": "2026-09-28T22:30:00Z", "status": 0, "et": 0, "competitorIds": [..,..], "marketIds": [..],
               /* live navíc: */ "ls": "2. poločas", "liveTime": "87'", "score": [2,2],
               "currentSetScore": [4,4], "pointScore": ["30","15"], "server": 2,
               "timer": { "playtime": 5192766, "timeUtc": "…", "isPaused": false, "matchPhase": 4 } }],
  "markets": [{ "id": .., "typeId": 18, "name": "Počet gólů", "sv": "2.5", "oddIds": [..] }],
  "odds": [{ "id": .., "typeId": 12, "price": 2.125, "oddStatus": 0, "name": "Více než 2.5" }],
  "competitors": [{ "id": .., "name": ".." }], "champs": [..], "categories": [..] }
```

* `market.sv` = hodnoty UOF specifikátorů spojené `|` v **abecedním pořadí jmen** (`"1|5.5"` = periodnr|total,
  `"-0.5|1"` = hcp|periodnr, `"1|10.5"` = setnr|total).
* V detailu mají vícelinkové trhy jednu položku a každý kurz nese vlastní `odd.sv` = linie
  (handicap vždy z pohledu domácích: `"1 (+1.5)"` i `"2 (-1.5)"` mají `sv: "+1.5"`).
* `oddStatus` 0 = otevřeno, jinak zavřeno (v live `7` s `price: 0`).
* Ceny mají 4 desetinná místa (zlomkové kurzy zaokrouhlené nahoru, např. 5/3 → 1.6667); předáváme je
  beze změny (web ukazuje 2 desetinná místa; 4-místná hodnota nikdy nenadhodnocuje výplatu).

## Mapování trhů

Sdílená tabulka `src/adapters/kingsbet/uof.ts` (používá ji i betx). Hlavní trhy v listingu:

| sport | typeId → klíč |
|---|---|
| fotbal | 1 → `1X2\|REG`, 18 → `OU\|REG`, (10 dvojtip vynechán) |
| hokej | 1 → `1X2\|REG`, 16 → `AH\|REG`, 18 → `OU\|REG`, 406 → `ML\|MATCH`, 410 → `AH\|MATCH`, 412 → `OU\|MATCH` |
| basket | 219 → `ML\|MATCH`, 223 → `AH\|MATCH`, 225 → `OU\|MATCH` (vše „vč. prodl.“) |
| tenis | 186 → `ML\|MATCH`, 187 → `AH\|MATCH` (gemy), 188 → `AH_SETS\|MATCH`, 189 → `OU\|MATCH` (gemy) |

Z detailu navíc: 11 DNB, 29 BTTS, 16 AH, 19/20 týmové totaly, 26 OE; poločasy 60/64/66/68/69/70/74/75 (H1),
83/86/88/90/91/92/94/95 (H2, u basketu vynecháno); hokej 443/446/452/459/460/462 (P1–P3);
basket 1 (`1X2|REG`), 227/228/229, čtvrtiny 235/236/302/303/304 (Q1–Q4); tenis 190/191/198, sety 202/203/204.
Evropský handicap (14, 65, 87), kombinace, hráčské trhy a BetBuilder kopie (`isBB`) se vynechávají.

Detail se stahuje jen pro 20 nejbližších událostí začínajících do 24 h (`OPTIONS` v `index.ts`) – dá
AH/BTTS/DNB/poločasy/třetiny/sety tam, kde má prematch arb největší smysl, a drží počet požadavků na ~24.

## Live stav a přestávky

| pole | význam |
|---|---|
| `ls` / `liveTime` | text stavu: `1. poločas`, `Poločas` (HT), `2. poločas`, `První přestávka` (hokej), `2. třetina`, `1. set`, `Pozastaveno` (přerušeno, `status: 5`) |
| `timer` (fotbal) | `playtime` ms k okamžiku `timeUtc`, `isPaused`, `matchPhase` 2 = 1. poločas, 3 = HT, 4 = 2. poločas |
| `score` | skóre (tenis: sety) |
| `currentSetScore`, `pointScore` | tenis: gemy v aktuálním setu, body |

`GameState`: `statusText` = `ls`; `period` z textu („2. poločas“ → 2, „První přestávka“ → 1, HT → 1);
`breakFlag` = text obsahuje přestávku/„Poločas“ nebo fotbal `matchPhase === 3`; `clockSec` = `playtime`
(+ čas od `timeUtc`, když hodiny běží), jinak minuta z `liveTime` (hokej `19'` → 1140);
`clockRunning` = `!timer.isPaused`. Tenisovou přestávku mezi sety jsme v datech nezachytili
(pozorováno jen `1. set`, `2. set`, `3. set`, `Pozastaveno`); kdyby feed poslal text s „přestávka“/„pauza“,
`breakFlag` se nastaví, jinak musí detektor použít clock-fallback. Basket live v době průzkumu nebyl
(texty čtvrtin/přestávek neověřeny – parser bere „N. čtvrtina“ a „přestávk*“ obecně).

## Rate limity / chování

Žádný 403/429 ani Cloudflare challenge při ~5 req/s. Cloudflare cachuje odpovědi 3 s (`max-age=3`) –
live data jsou tedy staré max. ~3 s; častější polling než 1 s nemá smysl.

## Co nefunguje / zkoušeno

* `GetEvents` nemá parametr pro výběr typů trhů (zkoušeno `typeIds`, `marketTypeIds`, `marketTypeId`,
  `headerTypeIds`, … – ignoruje) → další trhy jen přes `GetEventDetails` (1 požadavek / událost).
* `GetLiveEvents?sportId=0&catIds=…` vrátí live události všech sportů, ale trhy jen pro hlavičky prvního
  sportu → live se tahá po sportech (4 požadavky).
* `GetEventsByChamp` s `champIds`/`catIds` vrací prázdno (správné parametry nezjištěny; nepotřebné,
  `GetEvents?sportId` vrací vše). Menu hlásí víc „událostí“ (fotbal 2139) než `GetEvents` (408) – rozdíl
  jsou outrighty (`GetOutrightEvents`), např. „1. Brazílie“ má jen outrighty.
* `GetEventsById?eventIds=…` vrací jen podmnožinu (live) událostí.
* Websocket: SDK zná origin `sb2frontendwebsocket-p002.biahosted.com`, ale anonymní web ho na live
  stránce nepoužil (polluje `GetLiveOverview` + `GetEventsById`). Oryx websocket je jen platforma
  kasina/účtu (auth, open-sportsbook), kurzy nenese. `subscribe()` proto neimplementováno.
* L4 (HTML) nemá smysl – sportsbook je čistě klientský (SPA v Shadow DOM widgetu).

## Když se to rozbije

1. `npx tsx scripts/try-adapter.ts kingsbet live` – když `altenar-api` padá a `altenar-browser` jede,
   blokuje se node klient (TLS otisk) → runner přepne na L5 sám.
2. `400`/prázdné odpovědi → zkontrolovat, že integrace pořád je `kingsbet`: otevřít web v prohlížeči a
   v DevTools najít požadavky na `sb2frontend-altenar2.biahosted.com` (nebo zpráva `open-sportsbook`
   v Oryx websocketu → `extras.integration`, `extras.url`). Host API je v
   `https://sb2wsdk-altenar2.biahosted.com/altenarWSDK.js` (`altenarWSDKOrigins.web`).
3. Nové/přejmenované trhy: `typeId` jsou UOF id – doplnit do `uof.ts`; ověřit názvy v detailu
   (`GetEventDetails`) a pořadí specifikátorů v `sv`.
4. Průzkumné skripty (Playwright zachytávání požadavků, SDK chunky) byly ve scratchpadu; postup:
   headless Chromium, `page.on('request')` s filtrem `biahosted`, navigace na
   `/sport?page=championship&championshipIds=…`, `/sport?page=event&eventId=…`, `/sport?page=live`.
