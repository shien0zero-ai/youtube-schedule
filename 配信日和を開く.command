#!/usr/bin/env bash

cd -- "$(dirname -- "${BASH_SOURCE[0]}")" || exit 1
if command -v node >/dev/null 2>&1; then
  node scripts/open-codespace.mjs "$@"
  status=$?
else
  printf '%s\n' 'Node.js 24.5 以降をインストールしてから、もう一度開いてください。' >&2
  status=1
fi

if ((status != 0)) && [[ -t 0 ]]; then
  read -r -p 'Enter キーで閉じます。' _
fi
exit "$status"
