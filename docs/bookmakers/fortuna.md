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
| 2 | `rest-api` | prematch + live | plain HTTP (`ctx.http`) | prematch ≈ 29 (5 výpis + 9 overview + ≤ 15 detail); live 2 (+4 každých 10 s) | prematch 4–5 s (při `minIntervalMs` 150 ms), live ≈ 0,2 s (s obnovou výpisu ≈ 0,9 s) |
| 3 | `websocket` | live | STOMP 1.2 přes SockJS websocket + REST snapshot, `subscribe()` push | 0 za emit; resync 6 požadavků / 30 s | push ≈ 15 zpráv/s, emit max. á 300 ms, heartbeat emit á 5 s |
| 5 | `browser-fetch` | prematch + live | stejné endpointy přes `ctx.browser.fetchInPage()` na stránce www.ifortuna.cz (fallback, kdyby API začalo blokovat ne-prohlížeče) | prematch 14 (bez detailů), live 2 (+4) | prematch ≈ 8 s, live ≈ 0,3 s (+ start Chromia ~4 s) |

Poznámka k runneru: žebříček startuje od nejnižšího levelu, takže live jede přes `rest-api`
polling a websocket (L3) se použije až při jeho selhání. Pokud má mít push přednost, je potřeba
změna ve frameworku (viz report) – strategie samotná je hotová a otestovaná.

Počty z 28. 9. 2026 ~23:00: prematch 1249 událostí (fotbal 746, tenis 300, hokej 114, basket 89),
≈ 3900 trhů; live 23 událostí (večer), 77 trhů (REST typovaný) / 47 trhů (WS výchozí sada).

## Endpointy

Základ `https://api.ifortuna.cz/offer`. Parametry polí se opakují (`fixtureIds=a&fixtureIds=b`).
Velikosti: komprimovaně (br/gzip) / raw JSON.

| účel | endpoint | poznámka |
|---|---|---|
| sporty | `/structure/api/v1_0/sports`, `/structure/api/v1_0/live/sports` | health check (1,7 kB) |
| výpis prematch | `/structure/api/v1_0/sport/{sportId}/matches?timeFilter=all&pageSize=500&page=N` | `pageSize` max 500, stránka parametrem `page` (ne `pageNumber`!). Vrací `categories`, `tournaments`, `fixtures`, `pagingInfo`. Fotbal 2 stránky (34 kB / 440 kB na stránku). Obsahuje i LIVE zápasy (`kind`) a e-sporty. |
| výpis live | `/structure/api/v1_0/live/sport/{sportId}/matches?pageSize=500` | ≈ 2 kB / 16 kB |
| hlavní trhy (hromadně) | `/markets/api/v1_0/fixtures/markets/overview?fixtureIds=…[&marketTypeIds=ufo:mtyp:00-0u…]` | mapa `fixtureId -> Market[]`. **Jen trhy s příznakem overview.** S `marketTypeIds` vrací víc linií (fotbal OU 12 místo 5, hokej OU 3×) a jen dané typy (typy jsou sportově prefixované, lze míchat sporty v jednom požadavku). 180 zápasů ≈ 29 kB / 790 kB. URL nad ~8 kB → **HTTP 414**, proto dávky po 180 ID. |
| detail zápasu | `/markets/api/v1_0/fixture/{fixtureId}/markets` | všechny trhy; nejde filtrovat (parametry ignoruje). Velký zápas 65 kB / 1,9 MB (hráčské trhy), Euroliga 12 kB / 270 kB. |
| stav live (hromadně) | `/stats-v2/api/v2_0/miniscoreboards?fixtureIds=…` | ≈ 1 kB / 10 kB pro 35 zápasů |
| plný scoreboard | `/stats-v2/api/v2_0/fixture/{id}/scoreboard` | `eventTime` (s), `remainingTimeInPeriod`, `timerRunning`; hromadné `/scoreboards` **ignoruje filtr** a vrací všech ~15 700 zápasů (171 kB / 2 MB) – nepoužito |
| config | `https://api.ifortuna.cz/cms-client/configuration/web_global` | `miniscoreboardWebSocketUrl = https://ws-offer.ifortuna.cz/stomp` |

Stránka zápasu: `https://www.ifortuna.cz/sazeni/{sportSeoName}/{categorySeoName}/{tournamentSeoName}/{seoName}`.

### Prematch sběr (`collectPrematch`)
1. výpis pro každý sport (5 požadavků), filtr `kind=PREMATCH`, `status=ACTIVE`, bez e-sportů;
2. overview po sportech s explicitními typy (`OVERVIEW_TYPES`, 9 požadavků);
3. detail pro nejbližší zápasy: okno 3 h (hokej 24 h, protože *vítěz vč. prodloužení* `0w-0d` má v
   prematch `overview:false` a v hromadném endpointu chybí), max. 45 sledovaných, ≤ 15 detailů
   na fetch (nejstarší první), obnova po 90 s, detail starší než 4 min se do výstupu nedává.
   V cache se drží jen namapovatelné typy trhů (detail velkého zápasu má 1700 trhů).
   Vypnutí/úprava: `DEFAULT_DETAIL` v `strategies.ts` (`detail: null` = jen overview).

Co je jen v detailu (tedy jen pro zápasy v okně): fotbal AH, BTTS, poločasy, týmové totaly;
hokej ML|MATCH, handicapy, třetiny, totaly „do rozhodnutí“; basket OU|MATCH, poločasy/čtvrtiny;
tenis gemové handicapy/totaly, sety handicap/počet. V overview je: fotbal 1X2, DNB, OU; hokej
1X2, OU; basket 1X2 (3-cestný), ML, AH; tenis ML, vítěz 1. setu.

### Live sběr (`collectLive`)
Výpis live (4 požadavky, cache 10 s) → 1× overview (typované, všechny sporty) → 1× miniscoreboards.
Zápasy, které se objeví mezi obnovami výpisu, přibudou do 10 s.

## Formát

Fixture: `participants[]` s `type: HOME|AWAY` (pořadí v poli neodpovídá – vždy podle `type`),
`startDatetime` ms, `kind` PREMATCH/LIVE, `status` ACTIVE. Market: `marketTypeId`
(`ufo:mtyp:{sportCode}-{xx}`), `name` (konkrétní, s linií/periodou, občas anglicky, NBSP),
`syntheticGroupKey` (anglický klíč per trh, např. `2nd_period_-_draw_no_bet`, `1st_set`,
`handicap(incl._ot_and_decisive_so)`), `outcomes[]` s `name`, `odds`, `displayType`
(`OPEN` | `LOCKED` | `SUSPENDED` | `CLOSED`; vše kromě OPEN = `open:false`).

Sporty (`sportId` / kód): fotbal `ufo:sprt:00`, hokej `0w`, basket `0i`, tenis `0x`.
**E-sporty** jsou pod reálnými sporty v kategoriích s cizím kódem (`ufo:ctgr:0c-00` eFotbal,
`35-00` eHokej, `0e-00` eBasketbal) a jejich trhy mají typy `0c-…`, `35-…`, `0e-…` → filtr podle
kódu kategorie + názvu turnaje (`Esports Battle`, `(4x5 min.)`).

### Mapování trhů (`DEFS` v `parse.ts`)
Výběry: `1`/`0`/`2` (1X2, ML, DNB), `+ 2.5`/`- 2.5` (OU), `Tým (-1)` / `1 (+0.5)` (handicap –
linie z pohledu domácích, hosté musí mít opačnou, jinak se trh zahodí), `Ano`/`Ne`, `Lichý`/`Sudý`.
Perioda se čte z `name` („2. třetiny“, „1.setu“, „1. Period“) a `syntheticGroupKey`; když si
odporují nebo chybí, trh se vynechá.

| sport | REG (základní doba) | MATCH (vč. prodl./nájezdů) | periody |
|---|---|---|---|
| fotbal | `00-00` 1X2, `00-03` DNB, `00-0u` OU, `00-0b` AH (2-cestný, asijské celé linie = vrácení), `00-1c` BTTS, `00-10`/`00-13` týmové OU | – | H1: `00-2d` 1X2, `00-2g` DNB, `00-2i` OU, `00-2h` AH, `00-2n` BTTS, `00-2m` OE, `00-2j`/`00-2k`; H2: `00-2w`, `00-2z`, `00-3b`, `00-3g`, `00-3c`/`00-3d` |
| hokej | `0w-00` 1X2, `0w-02` DNB, `0w-04` AH, `0w-05` OU, `0w-0b` BTTS, `0w-06`/`0w-08` | `0w-0d` ML „do rozhodnutí“, `0w-0e` AH, `0w-0f` OU, `0w-0g`/`0w-0h` | P1–P3: `0w-0j` 1X2, `0w-0q` DNB, `0w-0l` OU, `0w-0r` AH, `0w-0o` BTTS, `0w-0m`/`0w-0n` |
| basket | `0i-00` 1X2 (3-cestný) | `0i-04` ML, `0i-06` AH, `0i-07` OU, `0i-08`/`0i-09`, `0i-0a` OE (vše „včetně prodloužení“) | H1: `0i-0h`, `0i-0i`, `0i-0j`, `0i-0k`, `0i-0n`, `0i-0l`/`0i-0m`; Q: `0i-0b`, `0i-0c`, `0i-0e`, `0i-1b`, `0i-0o`/`0i-0p` |
| tenis | – | `0x-01` ML, `0x-02` AH (gemy), `0x-03` AH_SETS, `0x-04` OU (gemy), `0x-05`/`0x-06` OU hráčů, `0x-0i` OU_SETS | S: `0x-0e` ML, `0x-0f` AH, `0x-0g` OU |

Vynecháno: dvojtipy, kombinace (výsledek/počet), přesné výsledky, multigóly, „kdo dá gól“, hráčské
trhy, vítěz gamu (`0x-1s`), „vítěz se vrací při 1:2“ (`0x-3t`), evropské 3-cestné handicapy
(`00-5z`, `00-61`).

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
| `Přerušeno` / `Zápas přerušen` | `clockRunning false` (bez breakFlag) |
| `Zápas skončil` | `finished true` |
| `Začne brzy`, `Začíná …`, `29.09.26 3:00:00` | zápas ještě nezačal → `live: false`, jen `statusText` |

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
  * `/topic/offer/v2/cs/scoreboard.{fixtureId}` – plný scoreboard (hodiny) per zápas.
* Stav = REST snapshot s **výchozí** (netypovanou) overview sadou – to je přesně to, co web zobrazuje
  a websocket aktualizuje (u linií navíc z typovaného požadavku přišel za 45 s update jen u 2 z 27,
  proti 45 ze 77 u výchozí sady – nelze se spolehnout, že je WS udržuje, proto se nepoužívají) + zprávy; resync každých 30 s, reconnect s backoffem 1–30 s, emit při změně
  (throttle 300 ms) a nejméně každých 5 s (watchdog runneru má 15 s). `fetch()` vrací aktuální
  stav z paměti (po prvním snapshotu 0 požadavků).

## Co selhalo / omezení

* `…/scoreboards` (hromadně, plný) ignoruje `fixtureIds` → vrací vše (2 MB raw) – nepoužitelné pro 1 s polling.
* `…/fixture/{id}/markets` nejde filtrovat typem – detail velkých zápasů je 1,9 MB raw.
* overview vrací jen trhy s `overview:true` (u hokejového ML v prematch je `false`) → detail rozpočet.
* `/structure/api/v1_0/fixtures?sportId=` → 400 (vyžaduje `fixtureIds`), `/sport/{id}/fixtures` → 404.
* URL > ~8 kB → 414.
* Rate limit nepozorován (desítky požadavků/min, websocket hodiny). Headless Chromium web načte bez problémů.

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
   miniscoreboards, WS snapshot + 400 zpráv); detaily zkrácené na namapované typy + 8 vzorků.
