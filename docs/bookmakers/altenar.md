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
| `GetLiveOverview?…&sportId=0` | `liveSports` = počty živých zápasů podle sportu (~4 kB, CDN 3 s) – live polling podle něj stahuje jen sporty s živými zápasy |
| `GetSportInfo?…` | healthCheck |

sportId (`GetSportMenu`, stejné u obou webů): fotbal 66, tenis 68, basket 67, hokej 70, házená 73, volejbal 69,
americký fotbal 75, baseball 76, box 71, MMA 84, snooker 81, stolní tenis 77, šipky 78 (e-sporty 145–148,
„Speciální“ 90 a ostatní sporty se ignorují). Hlavní trhy listingu
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

## Dvojtip a další sporty (ověřeno 1. 10. 2026 ~00:10 CEST, zkrácené payloady jsou v `fixtures/*/altenar-api-*-newsports-2026-10-01.json`)

### Dvojtip (`DC`)

UOF 10 (základní doba), 63 (1. poločas), 85 (2. poločas), 529 (třetiny hokeje) – **výsledky 9 = 1X, 10 = 12, 11 = X2**
(`odd.typeId`; názvy se liší: Kingsbet „1X/12/X2“, MerkurXtip „Neprohra Zlín / Nebude remíza / Neprohra Slavia“, takže
se mapuje jen podle typeId; ověřeno proti 1X2 téže události). Názvy: fotbal „Výsledek zápasu – dvojtip“, „1./2. poločas – dvojtip“,
hokej „Dvojtip“ (základní doba → `REG`), „1 třetina - dvojitá šance“ / „Výsledek 1. třetiny – dvojtip“ (číslo periody **bez tečky** –
`PERIOD_IN_NAME` to bere). Nemapuje se: „dvojtip a počet gólů / oba týmy dají gól“ (547, 542, 3291…), „1. poločas/zápas – dvojtip“
(17625, 17711), 1179 „Dvojitá šance – výsledek 1. poločasu nebo zápasu“. Kingsbet má dvojtip v listingu u ~99 % fotbalových zápasů (445 / 449),
MerkurXtip u ~96 % (753 / 784); u basketu ani házené ho Altenar nenabízí (tabulka ho pro ně ale zná: basket REG/H1, házená REG/H1/H2). V live
se dvojtip počítá s aktuálním skóre (jako 1X2) a pozastavené výběry (cena 1 / `oddStatus` ≠ 0) chybí.

### Nové sporty – mapování (`UOF_BY_SPORT` v `common/uof.ts`, kontrola názvu `n(regex, …)` tam, kde UOF id mění jednotku)

| sport | trhy (UOF) | klíče | poznámka |
|---|---|---|---|
| házená 73 | 1, 11, 16, 18, (10, 19, 20, 26, poločasy 60–92) | `1X2\|REG` (60 min), `DNB`, `AH\|REG`, `OU\|REG` (góly) | jen tyto 4 trhy (+ 1X2 s remízou); vyřazovací prodloužení nemapujeme (nejsou v nabídce); `ML\|MATCH` **ne** |
| volejbal 69 | 186, 188, 202, 237, 238, 310 | `ML\|MATCH`, `AH_SETS\|MATCH`, `ML\|Sn`, `AH\|MATCH` (body), `OU\|MATCH` (body), `OU\|Sn` (body v setu) | 237 „Handicap – body“ jen v live; „Přesný výsledek“ (199), lichá/sudá (26, 311) vynecháno |
| americký fotbal 75 | 219, 223, 225, 227/228, 229; 1 (nenabízeno); H1 60/64/66/68/69/70; H2 83; Q 235/236/302/303 | `ML/AH/OU/OU_HOME/OU_AWAY/OE\|MATCH`, `1X2/DNB/AH/OU\|H1`, `1X2\|H2`, `1X2/OU/DNB/AH\|Q1–Q3` | vše „(vč. prodl.)“; 2. poločas vč. prodl. (231/232/294) a **4. čtvrtina vč. prodl. (613–615) se nemapují** (scope by nebyl REG ani MATCH) |
| baseball 76 | 251, 256, 258, 260/261 | `ML\|MATCH`, `AH\|MATCH` (run line ±1.5…), `OU\|MATCH`, `OU_HOME/OU_AWAY\|MATCH` | názvy „(vč. extra směny)“; **nic s nadhazovači**, „N. směna“, „směny N až M“, „bude extra směna“, „vítězný rozdíl“ se nemapuje |
| box 71, MMA 84 | 186 | `DNB\|REG` | 2-cestný „Vítěz zápasu“, při remíze (nebo no-contest) vrácení → DNB, **nikdy ML**; „Počet kol“ (18) vynecháno; 1X2 s remízou Altenar nenabízí |
| snooker 81 | 186, 493, 494 | `ML\|MATCH`, `AH\|MATCH` (framy), `OU\|MATCH` (framy) | „N. frame – vítěz/celkem bodů“ (499, 501) vynecháno |
| šipky 78 | 186, 188, 314, 367 | `ML\|MATCH`, `AH_SETS\|MATCH`, `OU_SETS\|MATCH`, `OU\|MATCH` (**legy**) | název musí obsahovat „sety“ resp. „legy“; handicap na legy (366) v datech nebyl; „Více 180 v zápasu“ (381, 1/X/2) a další 180ky se nemapují |
| stolní tenis 77 | 186, 187, 237, 238 | `ML\|MATCH`, `AH_SETS\|MATCH` (187 = **sety**, v tenise gemy!), `AH\|MATCH` (237 body), `OU\|MATCH` (238 body) | Kingsbet má v listingu jen 186, MerkurXtip i 237/238 (158/161 zápasů) |

Ověřeno na datech: handicap `odd.name` „1 (+2.5)“ / „2 (−2.5)“ odpovídá `odd.sv` = linie domácích u všech 2 296 handicapových kurzů; nesedí žádný z 16 102 parsovaných výběrů vůči surovému `price`
(nezávislá kontrola po zaokrouhlení webu).

**Nepotvrzeno (riziko):** pravidla obou webů pro americký fotbal (NFL končí po prodloužení výjimečně remízou) a pro boj (remíza u 186) jsme
nenašli – `ML|MATCH` u amerického fotbalu předpokládá vrácení vkladu při remíze (kdyby sázkovka remízu prohrála, hrozí ztráta vkladu u arbů na NFL;
pravděpodobnost ~0,2 % zápasů, college/CFL remízu nemají), `DNB|REG` u boxu/MMA platí při vrácení při remíze (web Kingsbetu/MerkurXtipu nemá 1X2, takže
mapování k tomu přesně sedí jen pro sázkovky s DNB/1X2 u téhož boje). Nadhazovače baseballu v názvech trhů nejsou (trhy „akce“).

### Počet požadavků

| | před | teď |
|---|---|---|
| prematch | 4 listingy + ≤ 50 detailů = 54 | **13 listingů** (jeden na sport) + ≤ 50 detailů = 63; limit detailů beze změny, detail se stahuje jen pro sporty, kterým přidá namapované trhy (`ALTENAR_DETAIL_SPORTS`: bez MMA, boxu a stolního tenisu – jejich zápasy by každou půlhodinu vyčerpaly 50 míst) |
| live (1 s) | 4 | 1 × `GetLiveOverview` za 15 s (`LIVE_SPORTS_TTL_MS`) + `GetLiveEvents` jen pro sporty s živými zápasy (večer 4–6, v noci 2–5); sport, ve kterém právě začal první zápas, se objeví nejpozději za 15 s |

Naměřeno `try-adapter`: Kingsbet prematch 1 237 událostí (fotbal 449, tenis 248, basket 132, hokej 119, AF 76, MMA 59, box 49, stolní tenis 37, házená 28, baseball 13, volejbal 11, šipky 8, snooker 8), 9,6 s;
MerkurXtip 1 890 událostí (stolní tenis 169, házená 62, šipky 27), 9,9 s.

## Live stav

`statusText` = `ls` („1. poločas“, „Poločas“, „2. třetina“, „První/Druhá přestávka“, „Přestávka“,
„3. čtvrtina“, „1. set“), `period` z textu, `breakFlag` pro poločas/přestávky (fotbal i `matchPhase 3`),
`score` (tenis, stolní tenis, volejbal sety; baseball běhy), `games` = `currentSetScore` (jen tenis), `points` = `pointScore`
(tenis body ve hře; stolní tenis a volejbal body v setu – jen když je `currentSetScore` prázdné: některé ligy stolního tenisu mají body setu
v `currentSetScore` a `pointScore` 0:0, pak se `points` neuvádí); hodiny z `timer`
(`playtime` k `timeUtc`, `isPaused`, `isTimerCountDown`), jinak minuta z `liveTime` („19'“ → 1140 s) – ne u sportů bez herního času (tenis, stolní tenis, volejbal, šipky, snooker, baseball; liveTime je
„3. set“ / „3. směna“) a ne u amerického fotbalu, MMA a boxu (bez živého vzorku je minuta z `liveTime` nejistá).
Nové sporty v live: volejbal `1. set`, **`První přestávka`** (mezi sety → `breakFlag`, `period` 1), baseball `3. směna` (`period` 3, skóre v bězích),
stolní tenis `2. set` (5. set = rozhodující). Handball/AF/box/MMA/šipky/snooker v době ověření (noc) živé zápasy neměly – jen obecné parsování
(`N. poločas`, `N. čtvrtina`, „přestávk*“), bez vzorku.

## Ověření

Parser se kontroloval proti živému API i webu (Playwright, texty včetně shadow DOM widgetu):
`npx tsx scripts/try-adapter.ts kingsbet live`, testy `npx vitest run src/adapters/kingsbet src/adapters/merkurxtip`
(fixture `fixtures/kingsbet/altenar-api-live-2026-09-30.json` obsahuje všechny pasti výše).
