# Surebet – živá detekce arbitráží

Sbírá kurzy z českých sázkovek, páruje zápasy, hledá arbitráže (Σ 1/kurz < 1), počítá vklady
zaokrouhlené na celé koruny a živě je ukazuje v dashboardu na http://localhost:3000.
**Nic nesází** – sázky podáváš ručně, tlačítka v detailu arbu jen zapisují, co se stalo.
Každý arb se ukládá včetně délky života, aby šlo predikovat, jak dlouho vydrží.

## Spuštění

### Docker (jedním příkazem)

```bash
docker compose up -d --build                  # testovací kurzy ze simulátoru
DATA_SOURCE=real docker compose up -d --build # skutečné sázkovky
docker compose --profile analytics up -d      # + noční retrénink modelu (fáze 2)
```

### Lokálně bez Dockeru (bez rootu)

```bash
npm install
npm run dev                          # Postgres+Timescale a Redis (scripts/local-infra.sh), migrace, všechny služby, web
DATA_SOURCE=real npm run dev         # skutečné sázkovky
DATA_SOURCE=real BOOKMAKERS=fortuna,kingsbet npm run dev   # jen vybrané
WEB=prod npm run dev                 # next build + start (méně paměti než next dev)
bash scripts/stop-local.sh           # zastavit služby (infra běží dál; scripts/local-infra.sh stop)
```

`scripts/local-infra.sh` stáhne balíčky Postgres 16, TimescaleDB 2.30 a Redis 7 přes `apt-get download` do `.infra/`
– nepotřebuje sudo ani Docker.

## Architektura

```
adaptéry (src/adapters/<sázkovka>)  ──►  ingest  ──Redis pub/sub odds:diff──►  detector  ──arb:events──►  gateway ──WebSocket──► dashboard
  žebříček strategií + circuit breaker    │ validace (zod + sanity + konsenzus)       │ arby, vklady, predikce        │ REST /api/*
                                          │ párování (aliasy + fuzzy + čas ±15 min)   │ životní cyklus + důvod zániku
                                          ▼                                           ▼
                                  Postgres/Timescale: odds_snapshots, events, aliasy …   arbs, arb_ticks, user_actions, adapter_health
```

| Služba | Soubor | Úloha |
|---|---|---|
| ingest | `src/services/ingest/main.ts` | spouští adaptéry podle režimu, validuje, páruje, zapisuje stav a změny |
| detector | `src/services/detector/main.ts` | nejlepší kurzy, arby, vklady, konec arbů, predikce životnosti |
| gateway | `src/services/gateway/main.ts` | REST API + WebSocket push (žádný polling z frontendu) |
| web | `web/` | Next.js (App Router) + Tailwind |
| analytics | `analytics/train.py` | Cox PH (lifelines) + srovnání s XGBoost AFT, export do `survival_models` |

## Režimy

Výchozí hodnoty jsou v `config/modes.ts`, za běhu se mění v **Nastavení** (bez restartu).

| Režim | Sběr | Min. marže | Max stáří nohy |
|---|---|---|---|
| PREMATCH | 30–60 s | 0,5 % | 150 s |
| PAUSED | 3–5 s | 1,0 % | 15 s |
| LIVE | websocket, jinak 0,7–1 s | 1,5 % | 5 s |

PAUSED se pozná primárně ze stavových polí feedu (HT, „Poločas“, „Přestávka“, „Konec 1. třetiny“, breakFlag),
fallbackem z hodin: čas stojí déle než X s na konci periody, trh otevřený, skóre se nemění.
Přestávka nese typ, začátek a očekávanou délku (fotbal/basket poločas 15 min, hokej 17 min,
tenis mezi sety 120 s, basket mezi čtvrtinami 2 min). Arb, jehož predikovaný medián životnosti
přesahuje zbývající čas přestávky, je označen ⚠ jako rizikový.

## Sázkovky (stav)

| Sázkovka | Stav | Strategie | Poznámka |
|---|---|---|---|
| Fortuna | ✅ | L2 REST `api.ifortuna.cz`, L3 websocket (live push), L5 prohlížeč | ~1 250 zápasů prematch |
| Kingsbet | ✅ | L2 veřejné Altenar API, L5 prohlížeč | ~850 zápasů |
| BetX | ✅ | L2 API `sportapis-cz.betx.bet`, L5 prohlížeč | web je na **bet-x.cz** (betx.cz je parkovaná doména); live cache ~10 s |
| Sazka (Allwyn) | ✅ | L2 OpenBet REST, L3 websocket push (live) | Akamai cachuje odpovědi 30–60 s (prematch data až ~60 s stará); prohlížeč Akamai blokuje |
| MerkurXtip | ✅ | L2 veřejné Altenar API, L5 prohlížeč | ~1 385 zápasů; live jen hlavní trhy |
| SYNOT TIP | ✅ | L2 interní API `sport.synottip.cz` (prematch protobuf, live JSON), L5 prohlížeč | ~1 070 zápasů; vedlejší trhy jen do 24 h; live jen hlavní trhy, viz `docs/bookmakers/synot.md` |
| Tipsport | ⛔ blokováno | – | Cloudflare/F5 pozná automatizaci (i v Chrome), viz `docs/bookmakers/tipsport.md` |
| Chance | ⛔ blokováno | – | stejná platforma a ochrana jako Tipsport |
| Betano | ⛔ blokováno | – | Cloudflare bot management, viz `docs/bookmakers/betano.md` |

Blokované sázkovky adaptér nemají – ochrana proti botům se neobchází (žádné stealth pluginy,
podvrhování otisků ani řešení CAPTCHA). `src/adapters/tipsport/platform.ts` umí jedním požadavkem
ověřit, jestli se přístup neuvolnil. Jak psát adaptér: `docs/adapters.md`.

## Párování

Kanonické entity (sport, soutěž, tým/hráč, událost, trh, výběr) + tabulka aliasů. Fuzzy shoda:
diakritika, šum (FC, SK, AC…), značky které se musí shodovat (U21, ženy, B-tým), zkratky
(„Ml. Boleslav“, „Din.Moskva“), akronymy (QPR), exonyma a státy (Mnichov/München/Munich,
Libérie/Liberia), přepisy z ruštiny (Čeljabinsk/Chelyabinsk, Kurhan/Kurgan), kódy NBA/NHL,
tenisová jména v libovolném pořadí vč. českého přechýlení (Sabalenková = Sabalenka) a čtyřher,
překlepy (Jaro–Winkler). Čas začátku ±15 min. Nejisté páry jdou do fronty **Nepárované** –
potvrzení se uloží jako alias a pár se příště spáruje sám.

## Predikce životnosti

* **Fáze 1** (od začátku): Kaplan–Meier po segmentech režim × sport × trh × pár sázkovek × pásmo
  marže; při < 30 vzorcích nadřazený segment. Medián, P25/P75, P(> 5/10/30/60 s).
* **Fáze 2** (od ~1 000 ukončených arbů): `analytics/train.py` – Cox PH, evaluace concordance
  indexem a kalibrací na časově posledních 20 %, srovnání s XGBoost AFT, export koeficientů +
  baseline hazardu do `survival_models`; detektor ho skóruje v TS (`src/core/cox.ts`, parita s lifelines je v testu).
* Cenzurované (nepočítají se jako zánik): `system_restart`, `stale:*`, `threshold_changed`, `unlinked`,
  `event_started`, `pause_started`, `pause_ended`, `event_finished`.
* Arby s P(přežije > reakční doba + zpoždění přijetí sázkovky) pod prahem jsou ztlumené a bez zvuku.
  Reakční doba a zpoždění přijetí se měří z `user_actions`.

```bash
cd analytics && ../.infra/bin/uv venv .venv && ../.infra/bin/uv pip install --python .venv/bin/python lifelines pandas numpy "psycopg[binary]" xgboost
.venv/bin/python train.py --source real      # --source sim pro testovací data, --force pro méně než 1 000 arbů
```

## Testy

```bash
npm test                  # vitest: jádro, párování, detektor, circuit breaker, adaptéry nad fixtures
npm run typecheck
npx tsx scripts/try-adapter.ts fortuna live   # živá zkouška adaptéru
```
