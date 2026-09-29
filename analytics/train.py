"""Fáze 2 – model přežití arbu (Cox PH) + srovnání s XGBoost AFT.

Spuštění:  python train.py [--source sim|real] [--min 1000] [--force] [--dry-run]

- Arby ukončené restartem, zastaráním, změnou prahu, začátkem zápasu nebo koncem přestávky
  jsou CENZUROVANÉ (nepočítají se jako "zanikl").
- Evaluace na časově posledních 20 % (bez úniku budoucnosti): concordance index + kalibrace
  predikovaného S(t) proti Kaplan–Meier v kvintilech rizika.
- Export: koeficienty + baseline kumulativní hazard do tabulky survival_models (JSON), který
  TS detektor skóruje (src/core/cox.ts) – bez Pythonu za běhu.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg
from lifelines import CoxPHFitter, KaplanMeierFitter
from lifelines.utils import concordance_index

CENSOR_PREFIXES = (
    "system_restart",
    "stale",
    "threshold_changed",
    "unlinked",
    "event_started",
    "pause_started",
    "pause_ended",
    "event_finished",
)
CATEGORICAL = ["mode", "sport", "marketType", "pair"]
NUMERIC = ["margin"]
HORIZONS_S = [5, 10, 30, 60]
MAX_PAIRS = 15
MODELS_DIR = Path(__file__).parent / "models"


def is_censored(reason: str) -> bool:
    return any(reason == p or reason.startswith(p + ":") for p in CENSOR_PREFIXES)


def load(dsn: str, sim: bool) -> pd.DataFrame:
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, mode, sport, market_type, bookmaker_pair, margin_at_detection, duration_ms,
                   end_reason, first_seen
            FROM arbs
            WHERE end_reason IS NOT NULL AND duration_ms IS NOT NULL AND is_sim = %(sim)s
            ORDER BY first_seen
            """,
            {"sim": sim},
        )
        cols = [d.name for d in cur.description]
        df = pd.DataFrame(cur.fetchall(), columns=cols)
    df["event"] = (~df["end_reason"].map(is_censored)).astype(int)
    df["T"] = np.maximum(df["duration_ms"].astype(float), 1.0)  # ms
    df = df.rename(columns={"market_type": "marketType", "bookmaker_pair": "pair", "margin_at_detection": "margin"})
    return df


def design(df: pd.DataFrame, levels: dict[str, list[str]], stats: dict[str, tuple[float, float]]) -> pd.DataFrame:
    """One-hot (referenční úroveň = první v levels) + standardizované numerické proměnné."""
    X = pd.DataFrame(index=df.index)
    for c in CATEGORICAL:
        vals = df[c].where(df[c].isin(levels[c]), "other")
        for lvl in levels[c][1:]:
            X[f"{c}={lvl}"] = (vals == lvl).astype(float)
    for n in NUMERIC:
        mean, std = stats[n]
        X[n] = (df[n].astype(float) - mean) / (std or 1.0)
    return X


def fit_levels(train: pd.DataFrame) -> tuple[dict[str, list[str]], dict[str, tuple[float, float]]]:
    levels: dict[str, list[str]] = {}
    for c in CATEGORICAL:
        counts = train[c].value_counts()
        keep = list(counts.index[: MAX_PAIRS if c == "pair" else 50])
        # nejčastější úroveň jako reference; málo časté spadnou do "other"
        keep = [k for k in keep if counts[k] >= 5] or list(counts.index[:1])
        if len(counts) > len(keep):
            keep.append("other")
        levels[c] = keep
    stats = {n: (float(train[n].mean()), float(train[n].std(ddof=0) or 1.0)) for n in NUMERIC}
    return levels, stats


def calibration(cph: CoxPHFitter, X: pd.DataFrame, df: pd.DataFrame) -> list[dict]:
    """Predikované vs pozorované (KM) P(přežije > t) v kvintilech rizika."""
    risk = cph.predict_partial_hazard(X).to_numpy()
    q = pd.qcut(risk, 5, labels=False, duplicates="drop")
    out = []
    times_ms = [h * 1000 for h in HORIZONS_S]
    surv = cph.predict_survival_function(X, times=times_ms).T  # rows = obs
    for g in sorted(set(q)):
        m = q == g
        km = KaplanMeierFitter().fit(df["T"][m], df["event"][m])
        row = {"quintile": int(g) + 1, "n": int(m.sum())}
        for h, t in zip(HORIZONS_S, times_ms):
            row[f"pred_{h}s"] = round(float(surv[t][m].mean()), 3)
            row[f"obs_{h}s"] = round(float(km.survival_function_at_times(t).iloc[0]), 3)
        out.append(row)
    return out


def parity_checks(cph: CoxPHFitter, X: pd.DataFrame, df: pd.DataFrame, n: int = 5) -> list[dict]:
    idx = list(df.index[: min(n, len(df))])
    times = [h * 1000 for h in HORIZONS_S]
    surv = cph.predict_survival_function(X.loc[idx], times=times)
    out = []
    for i in idx:
        r = df.loc[i]
        out.append({
            "x": {"mode": r["mode"], "sport": r["sport"], "marketType": r["marketType"], "pair": r["pair"], "margin": float(r["margin"])},
            "surv": {str(h): float(surv[i][t]) for h, t in zip(HORIZONS_S, times)},
        })
    return out


def xgb_compare(Xtr, dtr, Xte, dte) -> float | None:
    try:
        import xgboost as xgb
    except ImportError:
        return None
    lower = dtr["T"].to_numpy() / 1000
    upper = np.where(dtr["event"].to_numpy() == 1, lower, np.inf)
    d = xgb.DMatrix(Xtr.to_numpy(), label_lower_bound=lower, label_upper_bound=upper)
    params = {"objective": "survival:aft", "eval_metric": "aft-nloglik", "aft_loss_distribution": "normal",
              "aft_loss_distribution_scale": 1.2, "tree_method": "hist", "learning_rate": 0.05, "max_depth": 4}
    bst = xgb.train(params, d, num_boost_round=300)
    pred = bst.predict(xgb.DMatrix(Xte.to_numpy()))
    return float(concordance_index(dte["T"], pred, dte["event"]))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", choices=["sim", "real"], default=os.environ.get("DATA_SOURCE", "real"))
    ap.add_argument("--min", type=int, default=1000, help="minimální počet ukončených arbů")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--dry-run", action="store_true", help="neukládat model do DB")
    a = ap.parse_args()
    dsn = os.environ.get("DATABASE_URL", "postgresql://surebet@127.0.0.1:5432/surebet").replace("postgres://", "postgresql://")

    df = load(dsn, a.source == "sim")
    n_events = int(df["event"].sum())
    print(f"[{a.source}] ukončených arbů: {len(df)} (zaniklo {n_events}, cenzurováno {len(df) - n_events})")
    if len(df) < a.min and not a.force:
        print(f"málo dat – potřeba aspoň {a.min} (použij --force pro test)")
        return 2
    if n_events < 30:
        print("příliš málo necenzurovaných pozorování")
        return 2

    split = int(len(df) * 0.8)
    train, test = df.iloc[:split].copy(), df.iloc[split:].copy()
    levels, stats = fit_levels(train)
    Xtr, Xte = design(train, levels, stats), design(test, levels, stats)
    # sloupce bez variability by rozbily fit
    keep = [c for c in Xtr.columns if Xtr[c].std() > 0]
    Xtr, Xte = Xtr[keep], Xte[keep]

    cph = CoxPHFitter(penalizer=0.05)
    cph.fit(pd.concat([Xtr, train[["T", "event"]]], axis=1), duration_col="T", event_col="event")
    c_train = float(cph.concordance_index_)
    c_test = float(concordance_index(test["T"], -cph.predict_partial_hazard(Xte), test["event"]))
    cal = calibration(cph, Xte, test)
    c_xgb = xgb_compare(Xtr, train, Xte, test)

    print(f"C-index Cox: train {c_train:.3f}, test {c_test:.3f}" + (f" | XGBoost AFT test {c_xgb:.3f}" if c_xgb else ""))
    print("kalibrace (test, kvintily rizika – predikce vs Kaplan–Meier):")
    print(pd.DataFrame(cal).to_string(index=False))

    bh = cph.baseline_cumulative_hazard_
    step = max(1, len(bh) // 400)
    baseline = [{"t": float(t), "H": float(h)} for t, h in zip(bh.index[::step], bh.iloc[::step, 0])]
    if baseline[-1]["t"] != float(bh.index[-1]):
        baseline.append({"t": float(bh.index[-1]), "H": float(bh.iloc[-1, 0])})
    # lifelines centruje kovariáty – baseline odpovídá průměrnému x; převedeme na x = 0 (TS nepočítá průměry)
    offset = float(np.dot(cph.params_.to_numpy(), cph._norm_mean.to_numpy()))
    baseline = [{"t": b["t"], "H": b["H"] * float(np.exp(-offset))} for b in baseline]

    payload = {
        "kind": "cox",
        "version": 1,
        "trainedAt": datetime.now(timezone.utc).isoformat(),
        "nTrain": int(len(train)),
        "cIndex": round(c_test, 4),
        "categorical": [{"name": c, "levels": levels[c]} for c in CATEGORICAL],
        "numeric": [{"name": n, "mean": stats[n][0], "std": stats[n][1]} for n in NUMERIC],
        "coef": {k: float(v) for k, v in cph.params_.items()},
        "baseline": baseline,
        "metrics": {"cIndexTrain": c_train, "cIndexTest": c_test, "cIndexXgbAft": c_xgb, "calibration": cal},
        # referenční predikce lifelines – TS test ověřuje, že skórování v detektoru dává totéž
        "checks": parity_checks(cph, Xte, test),
    }
    MODELS_DIR.mkdir(exist_ok=True)
    out = MODELS_DIR / f"cox-{a.source}.json"
    out.write_text(json.dumps(payload, indent=1, ensure_ascii=False))
    print(f"model uložen: {out}")

    if not a.dry_run:
        kind = "cox_sim" if a.source == "sim" else "cox"
        with psycopg.connect(dsn) as conn:
            conn.execute("UPDATE survival_models SET active = false WHERE kind = %s", (kind,))
            conn.execute(
                "INSERT INTO survival_models (kind, n_train, c_index, payload, active) VALUES (%s, %s, %s, %s, true)",
                (kind, len(train), c_test, json.dumps(payload)),
            )
        print(f"aktivní model '{kind}' zapsán do survival_models – detektor ho načte do minuty")
    return 0


if __name__ == "__main__":
    sys.exit(main())
