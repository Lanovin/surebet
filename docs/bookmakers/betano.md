# Betano (betano.cz)

**Stav: BLOCKED – žádná strategie v rámci pravidel projektu nefunguje** (ověřeno 28. 9. 2026,
IP 217.30.68.246, T-Mobile CZ, Praha). `src/adapters/betano/index.ts` vrací `strategies: []`,
registry adaptér přeskočí (hlásí ho jako chybějící).

## Je to blokace, nebo landing page?

**Blokace.** Cloudflare (bot management / WAF pravidlo) vrací na *všechny* cesty HTTP **403**
s tělem „Betano Splash Screen“ (1,3–1,7 kB): `<iframe src="https://landingpages.kaizengaming.com/betano-splash-screen-bz/index.html">`
+ vložený skript Cloudflare JS Detections (`/cdn-cgi/challenge-platform/scripts/jsd/main.js`).
Iframe obsahuje jen text *„Access to this page is restricted due to security and compliance
measures.“* a loga sponzoringu – žádný odkaz dál, žádná výzva k vyřešení (není to CAPTCHA ani
„Checking your browser“). Skutečný web se při průchodu načte normálně (HTTP 200, „Online Sázení a
nejlepší Sázkové Kurzy | Betano“). Stejně (403 pro curl) odpovídají i www.betano.de/.pt/.com a stoiximan.gr –
nejde o geoblokaci (česká IP), ale o klasifikaci klienta jako bota. Vzorek: `fixtures/betano/blocked-splash-403.html`.

## Co bylo vyzkoušeno

| # | pokus | výsledek |
|---|---|---|
| 1 | curl / Node `fetch` (undici), Chrome UA, `accept-language: cs` | 403 splash na `/`, `/sport/`, `/live/`, `/api/sport/fotbal/`, `/api/static-content/…`, `/danae-webapi/api/live/overview/latest`, `POST /contenthub/negotiate` |
| 2 | curl s kompletní sadou hlaviček Chrome 153 (`sec-ch-ua*`, `sec-fetch-*`, `upgrade-insecure-requests`, br) | 403 → rozhoduje TLS/HTTP2 otisk, ne hlavičky |
| 3 | headless Chromium z frameworku (`BrowserPool`, Playwright 1.63, Chromium 153) | 403 splash hned na prvním dokumentu – UA `HeadlessChrome/153…` a `sec-ch-ua: "HeadlessChrome"`; dostane `cf_clearance`, ale i s ním 403 |
| 4 | *diagnostika*: headless Chromium s přepsaným UA + `sec-ch-ua` (Chrome 153, Linux) | první dokument 200 (`/sport/fotbal/`, 300 kB, `window["initial_state"]` jen s navigací – bez zápasů), 200 i `/api/static-content/assets/{leagues,regions,teams,players}?apiVersion=2.2`, `/api/kb-config/`, `/api/sports/FOOT/hot/…`; **po ~3 s doběhne Cloudflare JSD „oneshot“ a od té chvíle každý `/api/…` (i `/danae-webapi/…`) vrací 403 splash (358 B)** a další navigace (`/live/`) 403. Pořadí: `fixtures/betano/diagnostic-request-sequence.json`. |
| 5 | cookies z prohlížeče → plain HTTP | nepomůže: `cf_clearance` po JSD nese verdikt „bot“ a plain HTTP je blokované už otiskem (pokus 1–2 bez cookies i s `_cfuvid`) |

Pokus 4 není strategie (přepis UA/client hints je už maskování automatizace a stejně nestačí):
Cloudflare JS detekce v prohlížeči pozná Playwright (`navigator.webdriver === true` atd.). Projít by
šlo jen skrýváním automatizace (stealth patche, úprava `navigator`, blokování JSD skriptu,
rotace kontextů/cookies) – to je výslovně mimo pravidla. Headed Chrome na tomto stroji nejde
(bez displeje) a i headed Playwright má `navigator.webdriver = true`.

## Platforma (pro budoucí implementaci)

Kaizen Gaming „danae“ – **nesdílí platformu s Fortunou** (ta běží na FEG „ufo“: `api.ifortuna.cz`,
`ws-offer.ifortuna.cz`). Z jediného průchodu (výřez configu: `fixtures/betano/kb-config-excerpt.json`):

* stránky SSR s `window["initial_state"]` (JSON `data`, `structureComponents`, …),
* JSON API pod stejnou doménou, zrcadlí URL stránky: `/api/sport/fotbal/…`, `/api/sports/FOOT/hot/trending/leagues/{id}/events?req=s,stnf,c,mb`,
  `/api/static-content/assets/{leagues,regions,teams,players}?apiVersion=2.2`, `/api/kb-config/`,
  `/api/v1/translations/kcv/sportsbookbetting/cs/{v}/`; kódy sportů `FOOT`, `BASK`, `TENN`, `ICEH`,
* live: `/danae-webapi/api/live/overview/latest[?sportIds=]`, `/danae-webapi/api/live/overview/sync`,
  `/danae-webapi/api/live/events`, `/danae-webapi/api/layout/live`, `/danae-webapi/api/live/availabilities/latest`,
* push: SignalR hub `/contenthub?platformType=1` (metody `joinLiveOverviewGroup` / `leaveLiveOverviewGroup` /
  `getLiveOverviewVersion`, `joinLiveEventGroup` / `leaveLiveEventGroup` / `getLiveEventVersion`),
  zákaznický hub `/customerhub`.
* Ukázka tvaru událostí (z `/api/smart-picks`, prošlo před blokací; jde o boostnuté kombinace, ne běžné
  trhy): `eventId`, `leagueName`, `regionName`, `eventStartDate` (ms), `participants[{id,name}]`,
  `market.selections[{id, originalPrice, boostedPrice}]`. Běžné trhy (`/api/sport/…`) se stáhnout nepodařilo.

Vše je za stejnou Cloudflare zónou – žádný host mimo ni (websocket/SignalR jde přes `www.betano.cz`).

## Co by to mohlo odblokovat (mimo tento repozitář / rozhodnutí uživatele)

1. Skutečný (neautomatizovaný) prohlížeč uživatele – např. vlastní rozšíření v běžném Chrome, které
   posílá JSON z `/api/…` do ingestu. Pak by stačila L2/L4 parse vrstva nad formátem výše.
2. Oficiální / partnerský feed od Kaizen Gaming.
3. Změna pravidel Betana (občas se po čase zmírní) – test: `curl -s -o /dev/null -w '%{http_code}' https://www.betano.cz/`
   (200 = zkusit znovu level 2 přes `/api/…`), resp. headless Chromium bez úprav (title ≠ „Betano Splash Screen“).
