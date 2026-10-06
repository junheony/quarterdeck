#!/usr/bin/env bash
# Installs deck as a user LaunchAgent (com.deck.server): starts at login, restarted by launchd
# whenever it exits (KeepAlive) — which is how `npm run restart` (graceful) comes back up.
#   scripts/install-launchd.sh              # install or update, then (re)start under launchd
#   scripts/install-launchd.sh --uninstall  # stop (gracefully) and remove the agent
# Run it from the checkout launchd should serve (the plist points at this directory).
# A server already listening on the port (e.g. a manual `npm start`) is stopped gracefully first.
set -euo pipefail

LABEL="com.deck.server"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_SRC="$REPO/scripts/launchd/$LABEL.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
CONF_DIR="$HOME/.config/deck"
ENV_FILE="$CONF_DIR/env"
DOMAIN="gui/$(id -u)"

envval() { [[ -f "$ENV_FILE" ]] && sed -n "s/^[[:space:]]*$1=//p" "$ENV_FILE" | tail -n1 | tr -d "\"'" || true; }
PORT="$(envval DECK_PORT)"; PORT="${PORT:-${DECK_PORT:-9320}}"
DRAIN_MIN="$(envval DECK_DRAIN_MAX_MIN)"; DRAIN_MIN="${DRAIN_MIN:-15}"
DRAIN_S="$(awk -v m="$DRAIN_MIN" 'BEGIN { s = int(m * 60); print (s > 0 ? s : 900) }')"

listener() { lsof -nP -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -n1; }
loaded() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }

# SIGTERM = graceful drain (new turns refused, running ones finish); a second SIGTERM after the window.
stop_listener() {
  local pid
  pid="$(listener || true)"
  [[ -z "$pid" ]] && return 0
  echo "deck: 포트 $PORT 의 서버(pid $pid)에 SIGTERM — 진행 중인 턴이 끝나길 최대 ${DRAIN_MIN}분 기다립니다"
  echo "      (이 변경 전 버전의 서버라면 기다리지 않고 바로 끝나며 진행 중인 턴도 끊깁니다)"
  kill -TERM "$pid" 2>/dev/null || true
  local waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if (( waited >= DRAIN_S + 30 )); then
      echo "deck: 대기 시간 초과 — 즉시 종료 신호를 다시 보냅니다"
      kill -TERM "$pid" 2>/dev/null || true
      sleep 3
      break
    fi
    sleep 2; waited=$((waited + 2))
    (( waited % 30 == 0 )) && echo "deck: 아직 종료 대기 중 (${waited}s)"
  done
  for _ in $(seq 1 15); do [[ -z "$(listener || true)" ]] && return 0; sleep 1; done
  echo "deck: 포트 $PORT 가 아직 사용 중입니다 — 확인 후 다시 실행하세요 (lsof -iTCP:$PORT -sTCP:LISTEN)" >&2
  exit 1
}

unload() {
  if loaded; then
    echo "deck: 기존 LaunchAgent 내림 (SIGTERM → 드레인, 최대 ${DRAIN_MIN}분)"
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    for _ in $(seq 1 $((DRAIN_S + 60))); do loaded || break; sleep 1; done
  fi
}

if [[ "${1:-}" == "--uninstall" ]]; then
  unload
  rm -f "$PLIST_DST"
  echo "deck: LaunchAgent 제거 완료 ($PLIST_DST)"
  exit 0
fi

NODE="$(command -v node || true)"
[[ -n "$NODE" ]] || { echo "deck: node 를 찾을 수 없습니다 (PATH 확인)" >&2; exit 1; }
NODE_DIR="$(dirname "$NODE")"
LAUNCH_PATH="$NODE_DIR:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
[[ -e "$REPO/node_modules/tsx" ]] || { echo "deck: $REPO/node_modules 가 없습니다 — npm install 먼저" >&2; exit 1; }
[[ -f "$REPO/dist/ui/index.html" ]] || echo "deck: 경고 — dist/ui 가 없습니다. npm run build 를 먼저 하세요 (UI 가 안 뜹니다)"

mkdir -p "$CONF_DIR" "$HOME/Library/LaunchAgents"
if [[ ! -f "$ENV_FILE" ]]; then
  {
    echo "# deck 서버 환경 (launchd 가 시작할 때마다 scripts/launchd/run.sh 가 읽음). KEY=value 한 줄씩."
    echo "DECK_EXTRA_HOSTS=${DECK_EXTRA_HOSTS:-}"
    echo "# DECK_DRAIN_MAX_MIN=15   # 재시작 때 진행 중 작업을 기다리는 최대 분"
    echo "# DECK_BG_MAX_MIN=120     # 턴 뒤 백그라운드 작업을 기다리는 최대 분"
    echo "# DECK_STEER=0            # 실행 중 보낸 메시지를 턴에 끼워 넣지 않고 턴 뒤로 미룸 (기본 켜짐)"
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "deck: $ENV_FILE 생성 (DECK_EXTRA_HOSTS=${DECK_EXTRA_HOSTS:-비어 있음})"
fi

TMP="$(mktemp)"
sed -e "s|__REPO__|$REPO|g" -e "s|__HOME__|$HOME|g" -e "s|__PATH__|$LAUNCH_PATH|g" -e "s|__EXIT_TIMEOUT__|$((DRAIN_S + 60))|g" "$PLIST_SRC" > "$TMP"
plutil -lint "$TMP" >/dev/null

unload
stop_listener
mv "$TMP" "$PLIST_DST"
chmod 644 "$PLIST_DST"
launchctl bootstrap "$DOMAIN" "$PLIST_DST"
launchctl enable "$DOMAIN/$LABEL" 2>/dev/null || true

for _ in $(seq 1 30); do
  if pid="$(listener)" && [[ -n "$pid" ]]; then
    echo "deck: launchd 로 실행 중 (pid $pid, 포트 $PORT) · 로그 $CONF_DIR/deck.log"
    echo "      재시작: npm run restart · 상태: launchctl print $DOMAIN/$LABEL · 제거: $0 --uninstall"
    exit 0
  fi
  sleep 1
done
echo "deck: 30초 안에 포트 $PORT 가 열리지 않았습니다 — $CONF_DIR/deck.log 를 확인하세요" >&2
exit 1
