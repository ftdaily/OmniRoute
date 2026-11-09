#!/usr/bin/env bash
# Restart omniroute-repo.service when /api/health fails N times in a row.
# Needed because the process can hang (event loop blocked) without crashing,
# so Restart=on-failure never fires.
set -u

UNIT="${OMNIROUTE_HEALTHCHECK_UNIT:-omniroute-repo.service}"
URL="${OMNIROUTE_HEALTHCHECK_URL:-http://127.0.0.1:20128/api/health}"
TIMEOUT=10          # seconds per probe
MAX_FAILS=3         # consecutive failures before restart
GRACE=120           # seconds after (re)start to ignore failures
STATE_DIR="${XDG_RUNTIME_DIR:-/tmp}/omniroute-healthcheck"
STATE="$STATE_DIR/fails"
mkdir -p "$STATE_DIR"
# Fork 2b cold start: when watching the socket-activated backend
# (OMNIROUTE_HEALTHCHECK_UNIT=omniroute-beta-backend.service with
# OMNIROUTE_HEALTHCHECK_SOCKET=omniroute-beta.socket), do NOT probe while the
# backend sleeps — any connection would wake the proxy and defeat idle-exit.
# A sleeping backend is healthy-by-design: reset fails and exit 0.
SOCKET_UNIT="${OMNIROUTE_HEALTHCHECK_SOCKET:-}"
if [ -n "$SOCKET_UNIT" ] \
  && [ "$(systemctl --user is-active "$SOCKET_UNIT")" = "active" ] \
  && [ "$(systemctl --user is-active "$UNIT")" != "active" ]; then
  echo 0 > "$STATE"
  exit 0
fi

log() { echo "[omniroute-healthcheck] $*"; }

# Only act if the unit is supposed to be running.
if [ "$(systemctl --user is-active "$UNIT")" != "active" ]; then
  echo 0 > "$STATE"
  exit 0
fi

# Grace period after (re)start.
since=$(systemctl --user show -p ActiveEnterTimestampMonotonic --value "$UNIT")
now=$(awk '{printf "%d", $1 * 1000000}' /proc/uptime)
if [ -n "$since" ] && [ "$since" -gt 0 ] && [ $(( (now - since) / 1000000 )) -lt "$GRACE" ]; then
  echo 0 > "$STATE"
  exit 0
fi

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" "$URL" 2>/dev/null)
if [ "$code" = "200" ]; then
  [ "$(cat "$STATE" 2>/dev/null || echo 0)" != "0" ] && log "recovered (http $code)"
  echo 0 > "$STATE"
  exit 0
fi

fails=$(( $(cat "$STATE" 2>/dev/null || echo 0) + 1 ))
echo "$fails" > "$STATE"
log "probe failed (http ${code:-none}), consecutive=$fails/$MAX_FAILS"

if [ "$fails" -ge "$MAX_FAILS" ]; then
  log "restarting $UNIT"
  echo 0 > "$STATE"
  systemctl --user restart "$UNIT"
fi
