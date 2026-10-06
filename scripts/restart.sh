#!/usr/bin/env bash
# Graceful restart of the running deck server: SIGUSR2 → it stops taking new turns, waits for running
# turns and background work (DECK_DRAIN_MAX_MIN, default 15 min), then exits; launchd (KeepAlive)
# starts it again. Without launchd the server just stops — start it again yourself.
#   npm run restart            # signal and return
#   npm run restart -- --wait  # also wait until a new server listens again
set -euo pipefail

PORT="${DECK_PORT:-9320}"
WAIT=0
[[ "${1:-}" == "--wait" ]] && WAIT=1

listener() { lsof -nP -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -n1; }

pid="$(listener || true)"
if [[ -z "$pid" ]]; then
  echo "deck: 포트 $PORT 에서 실행 중인 서버가 없습니다" >&2
  exit 1
fi
kill -USR2 "$pid"
echo "deck: 재시작 요청 보냄 (pid $pid) — 진행 중인 작업이 끝나면 종료되고 launchd 가 다시 띄웁니다"
[[ $WAIT -eq 1 ]] || exit 0

while kill -0 "$pid" 2>/dev/null; do sleep 2; done
echo "deck: 이전 서버 종료됨 (pid $pid)"
for _ in $(seq 1 30); do
  new="$(listener || true)"
  if [[ -n "$new" && "$new" != "$pid" ]]; then echo "deck: 새 서버 실행 중 (pid $new)"; exit 0; fi
  sleep 1
done
echo "deck: 30초 안에 새 서버가 뜨지 않았습니다 — launchd 로 실행 중인지 확인하세요 (launchctl print gui/$(id -u)/com.deck.server)" >&2
exit 1
