#!/usr/bin/env bash
# Installs this plugin into a throwaway Paseo home under /tmp with the real CLI and daemon.
# Never touches ~/.paseo or the daemon on port 6767: the temp daemon listens on a unix socket,
# every CLI call targets that socket with --host, and cleanup only signals the daemon it started.
# The git install uses the committed HEAD, so it runs the manifest build step.
# Optional: COMPARE_DIR=/path/to/other/plugin installs a second plugin for comparison.
set -euo pipefail

PASEO="${PASEO:-$HOME/.local/bin/paseo}"
PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CHECK_HOME="$(mktemp -d /tmp/paseo-doc-viewer-check.XXXXXX)"
case "$CHECK_HOME" in
  /tmp/* | /private/tmp/*) ;;
  *) echo "refusing non-/tmp home: $CHECK_HOME" >&2; exit 2 ;;
esac
SOCKET="$CHECK_HOME/daemon.sock"

cat >"$CHECK_HOME/config.json" <<EOF
{
  "version": 1,
  "daemon": {
    "listen": "$SOCKET",
    "relay": { "enabled": false },
    "mcp": { "enabled": false }
  },
  "pluginsEnabled": true
}
EOF

paseo() { PASEO_HOME="$CHECK_HOME" "$PASEO" "$@" --host "unix://$SOCKET"; }

PASEO_HOME="$CHECK_HOME" PASEO_LISTEN="$SOCKET" "$PASEO" daemon run --home "$CHECK_HOME" \
  >"$CHECK_HOME/daemon.out" 2>&1 &
DAEMON_PID=$!

cleanup() {
  kill "$DAEMON_PID" >/dev/null 2>&1 || true
  wait "$DAEMON_PID" 2>/dev/null || true
  if [ "${KEEP_HOME:-0}" = "1" ]; then echo "kept $CHECK_HOME"; else rm -rf "$CHECK_HOME"; fi
}
trap cleanup EXIT

for _ in $(seq 1 120); do
  if [ -S "$SOCKET" ] && paseo status >/dev/null 2>&1; then break; fi
  if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
    echo "isolated daemon exited early" >&2
    cat "$CHECK_HOME/daemon.out" >&2
    exit 1
  fi
  sleep 0.5
done
paseo status >/dev/null

status=0
install() {
  local dir="$1" id="$2"
  echo "== install $id from $dir"
  if paseo plugin install "$dir" --id "$id" --json; then
    paseo plugin ls "$id" --json || true
    paseo plugin logs "$id" || true
  else
    echo "INSTALL FAILED: $id"
    return 1
  fi
}

install "$PLUGIN_DIR" paseo-doc-viewer || status=1
install "file://$PLUGIN_DIR" paseo-doc-viewer-git || status=1
if [ -n "${COMPARE_DIR:-}" ]; then
  install "$COMPARE_DIR" compare-plugin || echo "comparison plugin failed to install (expected for the 0.7-era file viewer)"
fi

for id in paseo-doc-viewer paseo-doc-viewer-git; do
  if paseo plugin ls "$id" --json | grep -q '"failed"'; then status=1; fi
done
exit "$status"
