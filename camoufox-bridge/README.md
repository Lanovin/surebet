# camoufox-bridge

Python sidecar s jedním Camoufoxem (upravený Firefox) pro sázkovky, které blokují Playwright Chromium
(Betano, Tipsport). Node klient: `src/adapters/camoufox.ts`, strategie: `src/adapters/common/camoufox-replay.ts`.
Běží zvlášť, protože Camoufox potřebuje Playwright < 1.63 a Node část projektu je na 1.63.

## Instalace

Bez `python3-venv` (např. bez sudo) použij `uv`:

```bash
cd camoufox-bridge
uv venv .venv && uv pip install --python .venv/bin/python -r requirements.txt
.venv/bin/python -m camoufox fetch      # stáhne prohlížeč (~1,3 GB do ~/.cache/camoufox)
```

## Spuštění

```bash
CAMOUFOX_HEADLESS=1 .venv/bin/python bridge.py     # 127.0.0.1:8765
```

Na stroji s malou RAM (bez swapu) ho pusť jako uživatelskou službu s limitem paměti – při přetečení
OOM killer zabije jen bridge (ne zbytek systému) a systemd ho za 5 s nahodí znovu:

```bash
systemd-run --user --unit=camoufox-bridge --working-directory=$PWD \
  -p MemoryMax=1700M -p MemorySwapMax=0 -p Restart=on-failure -p RestartSec=5 \
  -E CAMOUFOX_HEADLESS=1 $PWD/.venv/bin/python bridge.py
journalctl --user -u camoufox-bridge -f        # log
systemctl --user stop camoufox-bridge          # stop (po pádu i `systemctl --user reset-failed camoufox-bridge`)
```

Každá sázkovka má **vlastní Camoufox** (proces + fingerprint): ve sdíleném prohlížeči Tipsport a Chance
(stejné F5) souběžně dostávaly 403 a se třemi sázkovkami se navigace i `fetch()` zasekávaly do timeoutu.
Tři sázkovky tak berou ~3,5 GB (Windows, změřeno 2026-10-01). Starší měření se sdíleným prohlížečem:

Paměť (změřeno 2026-10-01, Camoufox 152, `idlePath=/robots.txt`): jedna sázkovka ~750–870 MB anon
(většinu bere samotný Firefox), Betano + Tipsport + Chance najednou ~1,2–1,5 GB (Firefox se přizpůsobí
limitu – s `MemoryMax=1500M` držel ~1,4 GB, s 1700M až ~1,55 GB, OOM v žádném z běhů). Bez `idlePath`
(plná SPA sázkovky v každé stránce) se tři sázkovky do 1,5 GB nevešly.

Proměnné: `CAMOUFOX_HOST`, `CAMOUFOX_PORT`, `CAMOUFOX_HEADLESS` (`virtual` = Xvfb, vyžaduje nainstalovaný `Xvfb`; `1`; `0`),
`CAMOUFOX_IDLE_CLOSE_S` (zavře prohlížeč sázkovky po nečinnosti, výchozí 600). Ingest v Dockeru volá bridge
přes `host.docker.internal`, takže bridge musí poslouchat i mimo localhost: `CAMOUFOX_HOST=0.0.0.0`.

## Záložní engine (Patchright) a Cloudflare výzvy

Když Camoufox u sázkovky narazí 3× po sobě na blokaci (403/429, „Just a moment“, pád prohlížeče),
přepne bridge tu sázkovku na **Patchright** (Chromium s opravenými úniky CDP – engine, na kterém stojí
[Turnstilesolver](https://github.com/surafelabeje/Turnstilesolver)) a po 30 min zkusí znovu Camoufox.
Na stránce s Cloudflare výzvou oba enginy nejdřív ~25 s čekají a odklikávají Turnstile checkbox.
`GET /health` ukazuje engine každé sázkovky (`engines`) a jestli je záloha k dispozici (`fallback`).

```bash
uv pip install --python .venv/bin/python -r requirements-fallback.txt
.venv/bin/patchright install chromium          # ~170 MB, sdílí ~/.cache/ms-playwright
```

Proměnné: `CAMOUFOX_FALLBACK` (`auto` = jen s `CAMOUFOX_HEADLESS=0`; `patchright`; `off`),
`CAMOUFOX_FALLBACK_AFTER` (3), `CAMOUFOX_FALLBACK_RETRY_S` (1800), `CAMOUFOX_FORCE_ENGINE` (test jednoho enginu).

Ověřeno 2026-10-01 (Linux, headless): Patchright Chromium dostane od Betana splash 403 a od Tipsportu
„Chyba“ 403 i s opraveným UA, proto je ve výchozím stavu záloha zapnutá jen s viditelným oknem
(Windows / `CAMOUFOX_HEADLESS=0`). Chromium bere ~300–450 MB na sázkovku; při přepnutí se Camoufox
té sázkovky zavře, takže paměť nenaroste.

Zvažované a nepoužité: CloudDestroyer (`cloudscraper` + `selenium-stealth` – čisté HTTP a obyčejný
Chromium sázkovky blokují, bez licence), rpa-worker-selenium (Docker image 2–4 GB se SeleniumBase,
Docker tu není a na 4 GB RAM se nevejde).

## Zkouška

```bash
npx tsx scripts/try-adapter.ts betano prematch     # 13 sportů × 2 požadavky na kalendář
npx tsx scripts/try-adapter.ts tipsport prematch   # 13 superSportů po jednom POSTu
npx tsx scripts/try-adapter.ts chance live
```

První poll sázkovky trvá ~15–35 s (start prohlížeče, plná stránka kvůli Cloudflare cookies, přechod na
`idlePath`), další polly prematch ~2–4 s, live ~0,2–1 s.

Adaptéry dodávají známé endpointy (`targets`), takže se po sportech nenaviguje – bridge jen jednou otevře
origin a pak volá `fetch()` uvnitř stránky. Navigace je per sázkovka serializovaná, `fetch()` běží souběžně
(live poll nečeká na prematch). `/close {bk}` zavře prohlížeč jedné sázkovky.
