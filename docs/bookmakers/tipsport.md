# Tipsport.cz (platforma sdílená s Chance.cz)

**Stav k 2026-09-28: BLOKOVÁNO – žádná povolená strategie nefunguje.** Adaptér
(`src/adapters/tipsport/index.ts`) proto vrací prázdný seznam strategií. Kód platformy
(`src/adapters/tipsport/platform.ts`) umí blokaci poznat (`detectBlock`) a levně ověřit přístup
(`probeAccess` = 1× GET `/rest/offer/v6/sports`). Chance.cz běží na stejné platformě a má stejný
blok, viz [chance.md](chance.md).

## Co se děje

Web chrání Cloudflare bot management + vlastní WAF pravidlo (a navíc pravděpodobně F5 Bot Defense:
cookies `TS01…`, skript `/twister/js/common.js?async&seed=…`). Blokovaný požadavek dostane **HTTP 403**
s chybovou stránkou Tipsportu (`<title>Chyba</title>`, „Omlouváme se, ale došlo k chybě v požadavku na
server. ID: C1-<RayID>“, „Vaše IP adresa je: …“). Není to interaktivní výzva (žádné `cf-mitigated:
challenge`, žádný Turnstile / „Just a moment…“) – nic „k vyřešení“ tu není.

Chování podle klienta:

| klient | výsledek |
|---|---|
| curl (Chrome UA), Node fetch (`HttpClient` frameworku) | 403 hned na všech aplikačních cestách (otisk TLS/HTTP2 → nízké bot score) |
| Playwright chromium-headless-shell (UA/`sec-ch-ua` obsahuje `HeadlessChrome`) | 403 hned na první dokument |
| systémový Chrome 154 headless s konzistentním UA `Chrome/154`, **čistý profil** | 1. dokument **200** (SSR `/kurzy`, `/`), `GET /rest/common/v1/init-web` 200; pak doběhne Cloudflare JS detekce (`/cdn-cgi/challenge-platform/…/jsd/oneshot`) a **všechna další** `/rest/*` (vč. `/rest/offer/v6/sports`, `/rest/offer/v1/matches/top`) i `/imgproxy/*` jsou 403; reload dokumentu 403 |
| týž profil znovu (cookies `__cf_bm` + `cf_clearance` z předchozí návštěvy) | 403 hned na dokument – profil je „spálený“ |
| cookies ze session originu (`JSESSIONID`, `APISID`, `TS*`, `wepc`) předané do `HttpClient` | stále 403 |

Povolené bez ohledu na klienta jsou jen `/robots.txt`, `/favicon.ico`, `/.well-known/security.txt`,
`/cdn-cgi/trace` a pár cest, které origin vrací jako Next.js 404 (`/ads.txt`, `/humans.txt`) – bez kurzů.

**Proč nejde pokračovat:** JS detekce Cloudflare pozná automatizovaný prohlížeč (Playwright nastavuje
`navigator.webdriver = true`) a od té chvíle je session blokovaná. Projít by šlo jen skrytím
automatizace (stealth flagy typu `--disable-blink-features=AutomationControlled`, stealth plugin),
blokováním detekčních skriptů, TLS impersonací nebo střídáním IP/profilů – to vše je obcházení ochrany
a projekt to zakazuje, takže se to nezkoušelo. Headed prohlížeč nejde spustit (bez displeje, bez Xvfb)
a podle chování by stejně nepomohl – detekce se týká automatizace, ne headless režimu.

SSR HTML, které projde, **kurzy neobsahuje** (ověřeno na `/kurzy/fotbal/fotbal-muzi/ceska-chance-liga-120`
a detailu zápasu – jen SEO metadata v RSC payloadu). Level 4 tedy není cesta ani při přístupu.

Totéž vidí Internet Archive (web.archive.org, CDX API): od 2025 z `tipsport.cz/rest/*` 1166× 403 vs. 88× 200
a všech 88 úspěchů je `/rest/common/v1/init-web`; každé `/rest/offer/*` 403 (v2024 ještě 200 JSON).
HTML stránky Archive dostává (200) ještě v září 2026. Přesně odpovídá vzorci výše – blok není specifický
pro naši IP.

Vzorek blokované odpovědi (zkrácený, IP nahrazena `192.0.2.1`): `fixtures/tipsport/waf-403-rest.json`
(`GET /rest/offer/v6/sports`, 403, `server: cloudflare`, `cf-ray`, tělo 121 kB → bez inline fontů 9 kB).

## Oficiální cesta: partnerské API

`https://partners.tipsport.cz/rest/external/...` (i `partners.chance.cz`) je odsud dostupné bez WAF, ale
vrací `401 {"errorCode":"SESSION_DOES_NOT_EXIST"}` – vyžaduje partnerský účet
(`POST /rest/external/common/v2/session` s `username`/`password`/`productId` → `sessionToken`, pak
`Authorization: Bearer …`; výpis `GET /rest/external/offer/v1/matches?allEvents=true&idSuperSport=…`,
viz open-source `michalskop/tipsport.cz`). Je to přihlášení → mimo pravidla projektu; dává smysl jen se
smlouvou s Tipsportem a výslovným svolením uživatele (pak by to byl level 1).

## Jak to opravit / co zkusit

1. Bez změny pravidel projektu **nelze**. Rozhodnutí je na uživateli: partnerský přístup (výše), nebo
   Tipsport/Chance z detektoru vynechat.
2. `probeAccess()` (1 požadavek, `HttpClient`) řekne, jestli se politika změnila (`ok: true` = `/rest`
   vrací JSON). Až to nastane: nahrát fixtures (`/rest/offer/v6/sports`, `POST /rest/offer/v2/offer`,
   live endpointy níže), napsat `parse.ts` parametricky pro `BrandConfig` a přidat strategie (level 2
   přes `HttpClient`, fallback level 5 `fetchInPage`).

## Protokol (z veřejných JS bundlů `https://www.tipsport.org/web/128/_next/static/chunks/*`, neověřeno živě)

Frontend: Next.js (turbopack), statika na `www.tipsport.org`, API same-origin `https://www.tipsport.cz/rest/…`,
cookies `JSESSIONID`, `APISID` (HttpOnly, SameSite=None). Init: `GET /rest/common/v1/init-web`
(konfigurace; `configuration.socketIoEnabled: true`, `ODDS_INITIAL_MATCH_LOAD_NUMBER=75`,
`ODDS_MATCH_LOAD_NUMBER=50`, `ODDS_TOURNAMENT_TREE_AUTO_REFRESH_INTERVAL=15`).

Prematch:
- `GET /rest/offer/v6/sports?fromResults=false&withLive=true&mySelectionWithLiveMatches=true[&dateFrom&dateTo&oddFrom&oddTo]` – strom sportů/soutěží.
- `POST /rest/offer/v2/offer?limit=N` – obsah nabídky (tělo dříve `{results:false, highlightAnyTime:false, limit, type:'SUPERSPORT'|…, id, fulltexts:[], matchIds:[], matchViewFilters:[]}`).
- `POST /rest/offer/v2/matches`, `GET /rest/offer/v1/matches/top?carouselOutOfTopMaches=true&onlyPrematch=false&tab=TOP_MATCHES`,
  detail `GET /rest/offer/v3/matches/{id}?fromResults=false&ticketBuilderId=…` (s `eventTables`).

Live:
- `POST /rest/offer/v1/live/event-groups/matches` s `{section, filter, order, fulltext}` (section `IN_PLAY`/`FOLLOWS`) – seznam live zápasů + hlavní kurzy.
- inkrementální patche: `GET /rest/offer/v1/live/in-play/entities?since=…`, `GET /rest/offer/v1/live/in-play/event-groups/odds?since=…`.
- detail: `GET /rest/offer/v3/live/matches/{id}/patches?withEventTables=true[&since=…]&ticketBuilderId=…`.
- push: socket.io (transport websocket) na same-origin; namespace = prefix + jazyk (`cs`), prefixy `LEI`/`LEF`
  (live entities in-play/follows), `LMEGI`/`LMEGF` (live match event groups), událost `LIVE_MATCH_EVENT_GROUPS`
  nese patch. Level-3 `subscribe()` by šel postavit nad tím; handshake je ale za stejnou ochranou.

Tvar dat (archivované odpovědi z 2024, API v2 – aktuální v3/v6 se mohou lišit):
- výpis: zápasy s `id`, `name`, `idCompetition`, `nameCompetition`, `idSuperSport` (16 = fotbal, 43 = tenis),
  `nameSuperSport`, `homeParticipant`, `visitingParticipant`, `datetimeClosed`, `matchUrl`,
  `oppRows[].oppsTab[]` (`id`, `label` „1/0/2“, `odd`, `bettingEnabled`).
- detail: `eventTables[]` (`name` např. „Vítěz zápasu“, `mySelectionId` např. `43-WINNER_2W-1`) →
  `boxes[]` → `cells[]` (`name`, `odd`, `active`, `eventId`).
- live stav: `status` („1. set“), `statusName` (`SET_1`), `score.scoreOffer` („0:0“), `score.statusOffer`
  („1.set - 1:0 (00:00*)“), `score.parts.home/away[]` (periody), `score.gameParts` (tenis body),
  `score.mainParts` (sety), `score.period`, `score.scoreboardStatus`, `ended`, `notStarted`.
  Jak feed značí přestávky (poločas, přestávky hokeje/basketu, pauzy mezi sety) **nešlo ověřit** –
  pravděpodobně `statusName`/`scoreboardStatus` (např. „Poločas“, „Přestávka“); ověřit na živých datech.

## Rate limity / počty požadavků

Nezměřeno (žádná data). Průzkum: ~70 HTTP požadavků na tipsport.cz za session (sondy 1×/5 min) a
8 krátkých běhů headless prohlížeče. Web sám polluje live patche cca 1×/s a prematch strom každých 15 s.
