#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
port=${PORT:-3000}
if [[ ! $port =~ ^[0-9]{1,5}$ ]] || ((10#$port < 1 || 10#$port > 65535)); then
  printf 'PORT に 1〜65535 の整数を指定してください。\n' >&2
  exit 1
fi
port=$((10#$port))
url="http://127.0.0.1:$port"

lock_dir="/tmp/haishin-biyori-start-$UID-$port"
mkdir -m 700 -p -- "$lock_dir"
exec 9<"$lock_dir"
if ! flock -w 15 9; then
  printf '起動中の配信日和を確認できませんでした（ポート %s）。\n' "$port" >&2
  exit 1
fi

app_is_healthy() {
  local health
  health=$(curl --disable --fail --silent --noproxy '*' --max-time 1 --max-filesize 16384 "$url/healthz") || return 1
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    try {
      process.exitCode = JSON.parse(readFileSync(0, "utf8"))?.app === "haishin-biyori" ? 0 : 1;
    } catch {
      process.exitCode = 1;
    }
  ' <<< "$health"
}

if app_is_healthy; then
  exit 0
fi

if page=$(curl --disable --silent --noproxy '*' --max-time 1 --max-filesize 262144 --write-out $'\n%{http_code}' "$url/"); then
  if [[ ${page##*$'\n'} == 200 && $page == *'<title>配信日和｜ライブ配信スケジュール</title>'* &&
        $page == *'<script type="module" src="/app.js"></script>'* && $page == *'id="schedule-panel"'* ]]; then
    # Reuse versions that served the schedule before the health route was added.
    exit 0
  fi
  printf 'ポート %s は別のサービスが使用しています。\n' "$port" >&2
  exit 1
fi

log=$(mktemp /tmp/haishin-biyori.XXXXXX.log)
HOST=0.0.0.0 PORT="$port" nohup node --use-env-proxy src/server.mjs > "$log" 2>&1 </dev/null 9<&- &
pid=$!

deadline=$((SECONDS + 10))
while ((SECONDS < deadline)); do
  if app_is_healthy; then
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
