# Chance.cz

**Stav k 2026-10-01: funguje přes Camoufox** – stejná strategie i parser jako Tipsport
(`createPlatformAdapter('chance')`, `CAMOUFOX_BRANDS` v `src/adapters/tipsport/platform.ts`), endpointy a
mapování trhů viz [tipsport.md](tipsport.md). Ověřeno živě 2026-10-01: prematch 1465 událostí v 11 sportech,
live 78 událostí.

⚠️ **Chance sdílí s Tipsportem nabídku i kurzy**: stejná ID zápasů a při porovnání hokejové nabídky
(175 zápasů) se kurzy lišily u jediného zápasu – nejspíš jen okamžik aktualizace. Arby Tipsport × Chance
proto prakticky nevzniknou (a „arb“ mezi nimi bude nejspíš jen časový rozdíl stažení); Chance má smysl
hlavně jako záloha za Tipsport a pro arby proti ostatním sázkovkám.

## Historie: blokace z 28. 9. 2026 (Playwright Chromium, plain HTTP)

Chance.cz je značka skupiny
Tipsport na **stejné platformě** (stejný Next.js frontend, origin vrací `x-nextjs-brandsite: CHANCE`,
stejné `/rest/offer/...` API, stejná Cloudflare/F5 ochrana a stejná šablona chybové stránky). Veškerá
diagnostika, protokol a postup opravy jsou v [tipsport.md](tipsport.md); kód sdílí
`src/adapters/tipsport/platform.ts` (`BRANDS.chance`, origin `https://www.chance.cz`).

Ověřeno přímo na chance.cz:

| co | výsledek |
|---|---|
| `https://www.chance.cz/`, `/rest/offer/v6/sports` (curl, Node fetch) | 403, chybová stránka `Chyba` (brand ch-cz, ID `C1-<RayID>`, tel. +420 311 633 118), 73 kB |
| systémový Chrome 154 headless, čistý profil | `/` 200 („Online sázení, LIVE sázky, kasino \| Chance“), `/rest/common/v1/init-web` 200; po doběhnutí Cloudflare JS detekce 403 na `/rest/offer/v6/sports?fromResults=false&withLive=true&mySelectionWithLiveMatches=true`, `/rest/offer/v1/matches/top…` i všechny další `/rest/*`; reload 403 |
| chromium-headless-shell (Playwright default) | 403 hned |
| `/robots.txt`, `/cdn-cgi/trace` | 200 |
| `/humans.txt`, `/ads.txt` | 200 – Next.js 404 „CHANCE 404“ z originu, bez kurzů |
| `m.chance.cz` | 301 → `www.chance.cz` |
| `partners.chance.cz/rest/external/offer/v1/matches` | 401 (partnerské API, vyžaduje přihlášení → mimo pravidla) |
| Internet Archive | žádné archivované `chance.cz/rest/*` odpovědi |

Vzorek odpovědi: `fixtures/chance/waf-403-rest.json` (zkrácený, IP nahrazena `192.0.2.1`).

Strategie a `parse.ts` jsou napsané jednou v `src/adapters/tipsport/` parametricky podle `BrandConfig`,
Chance je jen převezme – liší se jen origin.
