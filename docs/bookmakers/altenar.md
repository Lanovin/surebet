# Altenar (platforma Kingsbetu a MerkurXtipu)

Oba weby mají sportsbook **Altenar** (widget SDK `altenarWSDK`) a stahují kurzy ze stejného veřejného
widget API; liší se jen parametrem `integration` (`kingsbet` / `merkurxtip`), nabídkou, maržemi a tím,
jak web kurz zobrazí. Kód je společný:

| soubor | obsah |
|---|---|
| `src/adapters/common/altenar.ts` | čisté parsování: trhy (UOF id z `./uof.ts` + kontrola názvu), herní stav, kurzy podle webu |
| `src/adapters/common/altenar-api.ts` | URL, transport (Node fetch / fetch v prohlížeči), `AltenarCore`, strategie L2 `altenar-api` a L5 |
| `src/adapters/<kingsbet|merkurxtip>/index.ts` | `AltenarSite`: integrace, origin, zaokrouhlení kurzů, URL zápasu |

## Endpointy

Základ `https://sb2frontend-altenar2.biahosted.com/api/widget/`, společné parametry
`culture=cs-CZ&timezoneOffset=-120&integration=<integrace>&deviceType=1&numFormat=en-GB&countryCode=CZ`.
Bez cookies a tokenu, CORS `Access-Control-Allow-Origin: *` (posíláme `Origin/Referer` webu).

| endpoint | použití |
|---|---|
| `GetEvents?…&eventCount=0&sportId=X` | prematch listing sportu – všechny zápasy (bez outrightů) s hlavními trhy (`headers`) |
| `GetLiveEvents?…&eventCount=0&sportId=X` | live listing sportu: hlavní trhy + stav (`ls`, `score`, `timer`, …) |
| `GetEventDetails?…&eventId=N&showNonBoosts=false` | všechny trhy a linie zápasu (prematch: nejbližších 50 zápasů do 24 h) |
| `GetSportInfo?…` | healthCheck |

sportId: fotbal 66, tenis 68, basket 67, hokej 70 (e-sporty 145–148 se ignorují). Hlavní trhy listingu
se liší podle integrace (Kingsbet má u hokeje navíc `16` handicap a `18` total základní doby).

**Cache:** odpovědi jdou přes CDN s `cache-control: public,max-age=3` a hlavičkou `Age`; parametr
`_=` cache neobchází. `fetchedAt` = čas požadavku − `Age` (nejstarší ze všech odpovědí fetch()).
Nový objekt vzniká nejdřív po 3 s, live se proto polluje po 1 s (dřív 2,5 s → stáří nohy běžně
přes 5 s = LIVE limit a arby končily jako `stale`).

## Formát a mapování trhů

Normalizované entity: `events[]` (`marketIds`, `competitorIds` [domácí, hosté], `status`, `et`),
`markets[]` (`typeId` = **UOF id trhu**, `name`, `sv`, `oddIds`/`desktopOddIds`, `isAlt`, `isBB`),
`odds[]` (`typeId` = UOF id výsledku, `price`, `oddStatus` 0 = otevřeno, `sv` = linie), `competitors[]`,
`champs[]`, `categories[]`.

* Typ trhu podle UOF (`uofDef()` v `common/uof.ts`), výběry 1/2/3, 4/5, 12/13, 1714/1715, 74/76, 70/72.
  **Neznámý výsledek (např. 7 „Nikdo“) → celý trh pryč.**
* **Kontrola názvu** (pojistka proti posunu významu typeId): celozápasové trhy nesmí zmiňovat periodu,
  poločasové musí mít „1./2. poločas“, periodové „N. třetina/čtvrtina/set“ (číslo periody se bere
  **z názvu**), MATCH trhy hokeje/basketu musí mít „vč. prodloužení“, REG a periody ho mít nesmí,
  „N. gól“, „zbytek“, „minut“, „interval“, „závod“ … se nemapují.
* **Linie**: detail – `odd.sv` na každém kurzu (u handicapu vždy linie domácích, i u výběru hostů);
  listing – `market.sv`. `market.sv` s víc specifikátory **není vždy v abecedním pořadí**
  (basket `236` „40.5|1“ = total|čtvrtina, `303` „+1.5|1“ = hcp|čtvrtina) → linie je ta část, která
  není číslem periody z názvu. Jen linie x.0/x.5 – čtvrtinové (±0.25, 2.75) jsou dělené sázky.
* `isBB` = kopie trhu pro BetBuilder (podmnožina linií) → vynechat. Evropský handicap (14, 65, 87),
  kombinace a hráčské trhy nejsou v UOF tabulce → vynechány.

### Pasti ověřené na živých datech (30. 9. 2026)

1. **Náhradní trh „N. gól“ se stejným typeId jako 1X2.** Když je 1X2 zavřené, live listing dá do
   `marketIds` trh `{"typeId": 1, "name": "5. gól", "isAlt": true}` s výběry 1 / Nikdo / 2. Starý
   parser Kingsbetu z něj dělal `1X2|REG` → falešné live arby (hokej 4:1 „marže 69 %“: Kingsbet
   „domácí 2.1“ byl ve skutečnosti další gól; Portugalsko U21 – Gibraltar „výhra hostů 9.0“).
   Teď: `isAlt` → pryč, a i bez příznaku by trh padl na neznámém výsledku 7 a na názvu „N. gól“.
2. **`status: 5` = pozastaveno** – i celé hodiny po konci zápasu zůstává v live feedu s „otevřenými“
   kurzy (Lehečka – Bergs 16 h po začátku: 1.083 / 8). Všechny výběry takové události jsou `open: false`.
   `status: 0` v live feedu = „Zápas ještě nezačal“ → do live nepatří (a prematch ho po čase začátku
   už nevrací), takže se vynechá.
3. **Kurzy mají 4 desetinná místa** (zlomkové kurzy, 13/7 → 2.8572), ale každý web s nimi zachází jinak
   (`AltenarSite.rounding`, ověřeno Playwrightem na webu i tiketu):
   * Kingsbet `round`: web ukazuje 2.86 a tiket počítá výhru 100 × 2.86 = 286.00 → zaokrouhlení na 2 místa
     (1.875 → 1.88, 2.125 → 2.13);
   * MerkurXtip `floor`: web ukazuje 2.16 (API 2.1667), tiket ale vyplatí 216.67 ze 100 → bereme
     oříznutou hodnotu (sedí s webem, výplatu nikdy nenadhodnotí).
4. Basket má v `timer` **odpočet čtvrtiny** (`isTimerCountDown: true`, `duration: 600000`) →
   `periodRemainingSec`, ne `clockSec` (dřív se odpočet přičítal k uplynulému času).
5. Live asijský handicap i totaly se počítají **na celý zápas** včetně padlých gólů (Skotsko U21 3:1
   v poločase: domácí −2.5 za 1.45 = musí vyhrát o 3+), stejně jako u ostatních sázkovek.

## Live stav

`statusText` = `ls` („1. poločas“, „Poločas“, „2. třetina“, „První/Druhá přestávka“, „Přestávka“,
„3. čtvrtina“, „1. set“), `period` z textu, `breakFlag` pro poločas/přestávky (fotbal i `matchPhase 3`),
`score` (tenis sety), `games` = `currentSetScore`, `points` = `pointScore`; hodiny z `timer`
(`playtime` k `timeUtc`, `isPaused`, `isTimerCountDown`), jinak minuta z `liveTime` („19'“ → 1140 s).

## Ověření

Parser se kontroloval proti živému API i webu (Playwright, texty včetně shadow DOM widgetu):
`npx tsx scripts/try-adapter.ts kingsbet live`, testy `npx vitest run src/adapters/kingsbet src/adapters/merkurxtip`
(fixture `fixtures/kingsbet/altenar-api-live-2026-09-30.json` obsahuje všechny pasti výše).
