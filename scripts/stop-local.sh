#!/usr/bin/env bash
# Zastaví lokálně běžící služby (ingest, detector, gateway, web) – infrastrukturu nechá běžet.
pids=$(pgrep -f "src/services/(ingest|detector|gateway)/main.ts|next dev -p 3000|next-server|tsx scripts/dev.ts" || true)
[ -z "$pids" ] && { echo "nic neběží"; exit 0; }
kill $pids 2>/dev/null
for i in $(seq 1 20); do
  sleep 0.5
  pgrep -f "src/services/(ingest|detector|gateway)/main.ts|next-server" >/dev/null || { echo "zastaveno"; exit 0; }
done
pkill -9 -f "src/services/(ingest|detector|gateway)/main.ts|next-server" 2>/dev/null
echo "zastaveno (násilně)"
