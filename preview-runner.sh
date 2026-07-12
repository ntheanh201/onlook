#!/bin/sh
set -eu
cd /app
last=""
child=""
start_app() {
  if [ -n "$child" ]; then
    kill "$child" >/dev/null 2>&1 || true
    wait "$child" >/dev/null 2>&1 || true
  fi
  bun install >/tmp/local-preview-install.log 2>&1
  bun run dev >/tmp/local-preview-dev.log 2>&1 &
  child=$!
}
start_app
while true; do
  marker="$(cat .onlook-restart 2>/dev/null || true)"
  if [ "$marker" != "$last" ]; then
    last="$marker"
    start_app
  fi
  sleep 1
done
