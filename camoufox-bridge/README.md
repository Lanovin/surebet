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

Paměť (změřeno 2026-10-01, Camoufox 152, `idlePath=/robots.txt`): jedna sázkovka ~750–870 MB anon
(většinu bere samotný Firefox), Betano + Tipsport + Chance najednou ~1,2–1,5 GB (Firefox se přizpůsobí
limitu – s `MemoryMax=1500M` držel ~1,4 GB, s 1700M až ~1,55 GB, OOM v žádném z běhů). Bez `idlePath`
(plná SPA sázkovky v každé stránce) se tři sázkovky do 1,5 GB nevešly.

Proměnné: `CAMOUFOX_HOST`, `CAMOUFOX_PORT`, `CAMOUFOX_HEADLESS` (`virtual` = Xvfb, vyžaduje nainstalovaný `Xvfb`; `1`; `0`),
`CAMOUFOX_IDLE_CLOSE_S` (zavře prohlížeč po nečinnosti, výchozí 600).

## Zkouška

```bash
npx tsx scripts/try-adapter.ts betano prematch     # 13 sportů × 2 požadavky na kalendář
npx tsx scripts/try-adapter.ts tipsport prematch   # 13 superSportů po jednom POSTu
npx tsx scripts/try-adapter.ts chance live
```

První poll sázkovky trvá ~15–35 s (start prohlížeče, plná stránka kvůli Cloudflare cookies, přechod na
`idlePath`), další polly prematch ~2–4 s, live ~0,2–1 s.

Adaptéry dodávají známé endpointy (`targets`), takže se po sportech nenaviguje – bridge jen jednou otevře
origin a pak volá `fetch()` uvnitř stránky. Každá sázkovka má vlastní stránku (context); se třemi sázkovkami
najednou Firefox spotřebuje ~1–1,5 GB, `/close {bk}` zavře stránku jedné z nich.
