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

## Události a herní stav

* `sourceId` = stabilní ID události u sázkovky, `startTime` epoch ms, `live` = právě se hraje.
* `competition` a `country` surově (např. „1. liga“, „Česko“).
* `state` jen z toho, co feed opravdu dává: `statusText` (surový text stavu, např. „Poločas“, „HT“,
  „Přestávka“, „2. třetina“), `period`, `breakFlag` (feed výslovně hlásí přestávku), `clockSec`
  (uplynulý čas od začátku zápasu), `periodRemainingSec`, `clockRunning`, `score`, `periodScores`,
  `games`/`points` (tenis), `finished`. Na tomhle stojí detekce režimu PAUSED.
* Sporty: `football`, `tennis`, `basketball`, `hockey` (lední hokej). Ostatní sporty zahoď
  (e-sporty, virtuální/simulované zápasy, speciály).

## Chování vůči sázkovce

* Žádné přihlášení, žádné řešení CAPTCHA, žádné stealth pluginy. Jen to, co vidí anonymní návštěvník.
* Rozumné tempo: `HttpClient` má `minIntervalMs`; prematch sken by měl zvládnout desítky požadavků,
  ne stovky. Live polling se volá každou ~1 s – musí to být **jeden až pár** požadavků.
* Prohlížeč jen jeden, stránek co nejméně, zavírej je. Stroj má 3,8 GB RAM.

## Testy

```bash
npx vitest run src/adapters/<bk>           # testy nad fixtures
npx tsx scripts/try-adapter.ts <bk> prematch --save   # živá zkouška + uložení vzorku
npx tsx scripts/try-adapter.ts <bk> live
```

Test musí nad fixture ověřit: počet událostí > 0, sporty, konkrétní událost (jména, čas), klíče trhů a
konkrétní kurzy, správný `scope` trhů a že `validateRawOdds()` projde.
