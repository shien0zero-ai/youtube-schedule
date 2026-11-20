#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
port=${PORT:-3000}
url="http://127.0.0.1:$port/"

if curl --fail --silent --max-time 1 "$url" --output /dev/null; then
  exit 0
fi

log=$(mktemp /tmp/haishin-biyori.XXXXXX.log)
HOST=0.0.0.0 PORT="$port" nohup node --use-env-proxy src/server.mjs > "$log" 2>&1 </dev/null &
pid=$!

for ((attempt = 0; attempt < 40; attempt++)); do
  if curl --fail --silent --max-time 1 "$url" --output /dev/null; then
    exit 0
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    cat "$log" >&2
    exit 1
  fi
  sleep 0.25
done

cat "$log" >&2
kill "$pid" 2>/dev/null || true
exit 1
