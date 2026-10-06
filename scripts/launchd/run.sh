#!/bin/bash
# launchd entry point for com.deck.server: load ~/.config/deck/env (KEY=value lines, e.g.
# DECK_EXTRA_HOSTS=…), then run the server as one node process (signals reach it directly).
set -euo pipefail
ENV_FILE="${DECK_ENV_FILE:-$HOME/.config/deck/env}"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi
cd "$(dirname "$0")/../.."
echo "deck: launchd 시작 $(date '+%Y-%m-%d %H:%M:%S') · node $(node --version) · $(pwd)"
exec node --import tsx src/server/main.ts
