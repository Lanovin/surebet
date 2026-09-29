"""Noční retrénink (pro Docker službu `analytics`): každý den v RETRAIN_AT (výchozí 03:30 Europe/Prague)."""
from __future__ import annotations

import os
import subprocess
import sys
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Europe/Prague")
AT = os.environ.get("RETRAIN_AT", "03:30")


def next_run(now: datetime) -> datetime:
    h, m = map(int, AT.split(":"))
    t = now.replace(hour=h, minute=m, second=0, microsecond=0)
    return t if t > now else t + timedelta(days=1)


def main() -> None:
    source = os.environ.get("DATA_SOURCE", "real")
    while True:
        now = datetime.now(TZ)
        nxt = next_run(now)
        print(f"další trénink {nxt.isoformat()}", flush=True)
        time.sleep(max(1.0, (nxt - now).total_seconds()))
        rc = subprocess.call([sys.executable, "train.py", "--source", source])
        print(f"trénink skončil s kódem {rc}", flush=True)


if __name__ == "__main__":
    main()
