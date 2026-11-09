#!/usr/bin/env bash
# Fork 2b: healthcheck cold-start skip, tested with a stubbed systemctl.
# Fails the file (exit != 0) on any mismatch.
set -u
cd "$(dirname "$0")/../.." || exit 1
SCRIPT="fork/deploy/omniroute-healthcheck.sh"
FAIL=0

stub() {
  # $1 = socket state, $2 = backend state
  local dir; dir=$(mktemp -d)
  cat > "$dir/systemctl" << EOF
#!/usr/bin/env bash
# stub: is-active <unit> / show / restart
if [ "\$1 \$2" = "--user is-active" ]; then
  case "\$3" in
    omniroute-beta.socket) echo "$1";;
    omniroute-beta-backend.service) echo "$2";;
    *) echo "inactive";;
  esac
  exit 0
fi
if [ "\$1 \$2" = "--user show" ]; then echo "0"; exit 0; fi
if [ "\$1 \$2" = "--user restart" ]; then echo "RESTART-CALLED \$3"; exit 0; fi
echo "unexpected: \$*" >&2; exit 1
EOF
  chmod +x "$dir/systemctl"
  echo "$dir"
}

run_case() {
  local name="$1" socket_state="$2" backend_state="$3" expect="$4"
  local dir; dir=$(stub "$socket_state" "$backend_state")
  local runtime; runtime=$(mktemp -d)
  out=$(PATH="$dir:$PATH" XDG_RUNTIME_DIR="$runtime" \
    OMNIROUTE_HEALTHCHECK_UNIT=omniroute-beta-backend.service \
    OMNIROUTE_HEALTHCHECK_SOCKET=omniroute-beta.socket \
    OMNIROUTE_HEALTHCHECK_URL=http://127.0.0.1:20139/api/health \
    bash "$SCRIPT" 2>&1)
  rc=$?
  rm -rf "$dir" "$runtime"
  if [ "$expect" = "asleep" ]; then
    # Must exit 0 without probing (no curl output, no restart).
    if [ "$rc" -eq 0 ] && [[ "$out" != *"probe failed"* && "$out" != *"RESTART"* ]]; then
      echo "PASS: $name (exit 0, no probe)"
    else
      echo "FAIL: $name (rc=$rc out=$out)"; FAIL=1
    fi
  else
    # Backend awake (or socket down): must NOT take the asleep path.
    # Awake+refused probe logs "probe failed" (curl to dead :20139).
    if [[ "$out" == *"probe failed"* ]]; then
      echo "PASS: $name (probed as expected)"
    else
      echo "FAIL: $name (rc=$rc out=$out)"; FAIL=1
    fi
  fi
}

run_case "socket active + backend inactive = asleep, no probe" active inactive asleep
run_case "socket active + backend active = probe" active active probe
# No socket configured (plain prod path): pre-existing "unit not active"
# guard exits 0 silently — correct, nothing to probe.
run_plain() {
  local dir; dir=$(stub active active)
  local runtime; runtime=$(mktemp -d)
  out=$(PATH="$dir:$PATH" XDG_RUNTIME_DIR="$runtime" \
    OMNIROUTE_HEALTHCHECK_UNIT=omniroute-beta-backend.service \
    bash "$SCRIPT" 2>&1)
  rc=$?
  rm -rf "$dir" "$runtime"
  if [ "$rc" -eq 0 ] && [ -z "$out" ]; then
    echo "PASS: no socket configured = silent exit 0 via unit guard"
  else
    echo "FAIL: no socket configured (rc=$rc out=$out)"; FAIL=1
  fi
}
run_plain

exit $FAIL
