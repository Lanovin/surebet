# Jak psát adaptér sázkovky

Každá sázkovka má vlastní adaptér v `src/adapters/<bookmaker>/`. Adaptér vrací **kompletní aktuální
nabídku** pro daný scope (`prematch` nebo `live`) ve sjednoceném tvaru `RawOdds`
(`src/core/types.ts`). Párování týmů mezi sázkovkami, detekci přestávek i arbů dělá zbytek systému –
adaptér jen věrně a přesně převede data sázkovky.

## Soubory

| Soubor | Obsah |
|---|---|
| `src/adapters/<bk>/index.ts` | `export default` továrna `AdapterFactory` → `{ bookmaker, strategies }`, strategie seřazené podle `level` (od nejlehčí) |
| `src/adapters/<bk>/parse.ts` | **čisté funkce** bez I/O: surová odpověď → `RawEvent[]`. Veškeré mapování sportů, trhů, výběrů a herního stavu je tady |
| `src/adapters/<bk>/strategies.ts` (nebo složka) | třídy implementující `Strategy` (používají `ctx.http` / `ctx.browser`) |
| `src/adapters/<bk>/<bk>.test.ts` | vitest nad nahranými fixtures – pro **každou funkční strategii** |
| `fixtures/<bk>/*.json` | nahrané surové odpovědi (zkrácené, ideálně < 1 MB na soubor) |
| `docs/bookmakers/<bk>.md` | endpointy, formát, rate limity, cookies/hlavičky, co selhalo a proč |

Framework (`src/core/*`, `src/adapters/{types,http,browser,fixtures}.ts`) needituj – když potřebuješ
změnu, napiš ji do reportu.

## Žebříček strategií

| level | strategie | poznámka |
|---|---|---|
| 1 | oficiální / veřejné API | zřídka existuje |
| 2 | interní JSON/REST, který volá web | preferovaná cesta |
| 3 | websocket feed webu | ideální pro LIVE (`subscribe()`) |
| 4 | server-rendered HTML | parsování HTML/`__NEXT_DATA__`/inline JSON |
| 5 | Playwright | `ctx.browser.capture()` (zachytávání síťových odpovědí – preferuj), `ctx.browser.fetchInPage()` (fetch uvnitř stránky se všemi cookies), nebo čtení DOM |

Když je level 2 blokovaný (Cloudflare 403), typická funkční cesta je level 5: načíst web v prohlížeči
a buď zachytit JSON odpovědi, které si stránka sama stahuje, nebo zavolat stejný interní endpoint přes
`fetchInPage()`. Parsování pak sdílí `parse.ts` s levelem 2. Druhá varianta: získat cookies z
prohlížeče (`ctx.browser.cookieHeader(url)`) a předat je `ctx.http.setCookieHeader()`.

## Kanonické trhy – buď přesný

Klíč trhu **vždy** přes `marketKey(type, scope, line?)` ze `src/core/markets.ts`.

* `scope` je kritický: arb mezi „základní dobou“ a „včetně prodloužení“ je falešný.
  * `REG` = základní hrací doba (fotbal 90', hokej 60', basket 4 čtvrtiny bez prodloužení)
  * `MATCH` = celý zápas vč. prodloužení/nájezdů (hokej „vítěz zápasu“, basket většinou vč. prodl., tenis zápas)
  * `H1`, `H2`, `P1–P3`, `Q1–Q4`, `S1–S5` = poločas, třetina, čtvrtina, set
* Typy: `1X2` (HOME/DRAW/AWAY), `ML` (HOME/AWAY), `DNB`, `OU` (OVER/UNDER, jednotka = góly/body/gemy),
  `AH` (HOME/AWAY, **linie z pohledu domácích**: domácí −1.5 → `AH|REG|-1.5`), `BTTS` (YES/NO), `OE`,
  `OU_HOME`, `OU_AWAY`, `OU_SETS`, `AH_SETS`.
* HOME = první uvedený účastník události tak, jak ho uvádí sázkovka. Prohozené pořadí mezi
  sázkovkami řeší matcher.
* Evropský (3-cestný) handicap, kombinované sázky, hráčské trhy, „kdo dá gól“ … **vynech**.
* Nejsi-li si jistý významem trhu, **vynech ho**. Chybějící trh je levný, špatně namapovaný drahý.
* Kurzy desetinně (`2.35`), rozsah 1.01–1000. Suspendovaný trh `open: false`, suspendovaný výběr
  `open: false` (kurz ponech, pokud ho feed dodává).

Priorita trhů: `1X2|REG` (fotbal, hokej), `ML|MATCH` (tenis, basket, hokej), `OU`, `AH`, `BTTS`, `DNB`,
potom periody (`H1`, `P1`, `S1`, `Q1`) a totaly/handicapy setů. Víc trhů = víc arbů, ale přesnost je
přednější.

## Dvojtip a ekvivalentní trhy

* `DC|scope` = dvojtip, výběry `HOME_DRAW` (1X), `HOME_AWAY` (12), `DRAW_AWAY` (X2). Jen pro rozsahy, které
  můžou skončit remízou (`REG`, `H1`, `H2`, `P1–P3`, `Q1–Q4`). Sám o sobě arb netvoří – detektor ho kombinuje
  s 1X2 a s asijským handicapem ±0.5 (`src/core/groups.ts`: 1 vs. X2, 2 vs. 1X, X vs. 12).
* Asijský handicap `0` a `±0.5` mapuj normálně jako `AH` – detektor ví, že AH 0 = DNB a AH −0.5 domácích = „1“,
  u hokeje/basketu/házené vč. prodloužení AH ±0.5 = vítěz (`ML|MATCH`).

## Další sporty – konvence

Jednotka OU/AH: házená góly, volejbal/americký fotbal/stolní tenis body, baseball běhy, šipky legy,
snooker framy. Sporty jednotlivců (tenis, stolní tenis, šipky, snooker, MMA, box) párují jména hráčů.

| sport | trhy | pozor |
|---|---|---|
| házená `handball` | `1X2|REG` (60 min), `DNB`, `DC`, `OU|REG`, `AH|REG`, `OE`, poločasy `H1/H2`; `ML|MATCH` jen výslovně vč. prodloužení a 7m | vyřazovací zápasy mají prodloužení – bez něj je to `REG` |
| volejbal `volleyball` | `ML|MATCH`, `AH_SETS|MATCH`, `OU_SETS|MATCH`, `OU|MATCH` (body celkem), `AH|MATCH` (body), sety `ML|Sn`, `OU|Sn`, `AH|Sn` | remíza neexistuje; zlatý set / „2 sety do“ formát vynech |
| baseball `baseball` | `ML|MATCH`, `AH|MATCH` (run line), `OU|MATCH` – vše vč. extra směn; `1X2|REG` = 9 směn | trhy „jen s nadhazovači“ (void při změně nadhazovače) vynech; první 3/5 směn vynech |
| americký fotbal `american_football` | `ML|MATCH`, `AH|MATCH`, `OU|MATCH` vč. prodloužení; `1X2|REG`; `H1/H2`, `Q1–Q4` | NFL může skončit remízou i po prodloužení – `ML` jen když sázkovka při remíze vrací vklad; jinak vynech |
| MMA `mma`, box `boxing` | `1X2|REG` = výsledek vč. remízy, `DNB|REG` = vítěz s vrácením vkladu při remíze | `ML` nepoužívej (remíza je možná); totaly kol a způsob výhry vynech |
| šipky `darts` | `ML|MATCH` (turnajové zápasy bez remízy), `1X2|REG` kde remíza jde; `AH/OU|MATCH` jen na **legy**, na sety `AH_SETS/OU_SETS` | nemíchej handicap na legy a na sety |
| snooker `snooker` | `ML|MATCH`, `AH|MATCH` a `OU|MATCH` na framy | |
| stolní tenis `table_tennis` | `ML|MATCH`, `AH_SETS|MATCH`, `OU_SETS|MATCH`, `OU|MATCH` / `AH|MATCH` na body, sety `ML|Sn`, `OU|Sn` | |

U jednotlivců (tenis, stolní tenis, šipky, snooker) se liší pravidla při skreči/nenastoupení – trh, u kterého
sázkovka výslovně uvádí nestandardní pravidlo (např. vyhodnocení i při nedohraném zápase), popiš v docs.
E-sporty a virtuální/simulované zápasy dál vynech.

## Události a herní stav

* `sourceId` = stabilní ID události u sázkovky, `startTime` epoch ms, `live` = právě se hraje.
* `competition` a `country` surově (např. „1. liga“, „Česko“).
* `state` jen z toho, co feed opravdu dává: `statusText` (surový text stavu, např. „Poločas“, „HT“,
  „Přestávka“, „2. třetina“), `period`, `breakFlag` (feed výslovně hlásí přestávku), `clockSec`
  (uplynulý čas od začátku zápasu), `periodRemainingSec`, `clockRunning`, `score`, `periodScores`,
  `games`/`points` (tenis), `finished`. Na tomhle stojí detekce režimu PAUSED.
* Sporty: `SPORTS` v `src/core/types.ts` (fotbal, tenis, basket, lední hokej, házená, volejbal, baseball,
  americký fotbal, MMA, box, šipky, snooker, stolní tenis). Runner posílá v `req.sports` všechny – adaptér
  vrací jen ty, které umí. E-sporty, virtuální/simulované zápasy a speciály zahoď.

## Chování vůči sázkovce

* Žádné přihlášení, žádné řešení CAPTCHA, žádné stealth pluginy. Jen to, co vidí anonymní návštěvník.
* Rozumné tempo: `HttpClient` má `minIntervalMs`; prematch sken by měl zvládnout desítky požadavků,
  ne stovky. Live polling se volá každou ~1 s – musí to být **jeden až pár** požadavků.
* Prohlížeč jen jeden, stránek co nejméně, zavírej je. Stroj má 32 GB RAM (limity v `docker-compose.yml`), ale počet stránek kvůli RAM neomezuj zbytečně – spíš kvůli zátěži sázkovek.

## Testy

```bash
npx vitest run src/adapters/<bk>           # testy nad fixtures
npx tsx scripts/try-adapter.ts <bk> prematch --save   # živá zkouška + uložení vzorku
npx tsx scripts/try-adapter.ts <bk> live
```

Test musí nad fixture ověřit: počet událostí > 0, sporty, konkrétní událost (jména, čas), klíče trhů a
konkrétní kurzy, správný `scope` trhů a že `validateRawOdds()` projde.
