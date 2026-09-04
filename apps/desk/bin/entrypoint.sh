#!/bin/bash
# Local desk PID 1 (under tini): bring every claimed window up, then wait.
# On SIGTERM, ask the desktop to stop so Chromium closes its profile cleanly
# instead of being SIGKILLed with the lock held on the config volume.
set -euo pipefail

/usr/local/bin/desk-up

stop() {
  # Highest screen first, down to the primary. The bound is `MAX_DISPLAYS`
  # (see start-window); a screen above it cannot have been claimed, and one
  # below a stale bound would be left running with its Chromium holding the
  # profile lock.
  for n in $(seq 16 -1 1); do
    if [[ -e "/tmp/.X11-unix/X$n" ]]; then
      /usr/local/bin/stop-window "$n" || true
    fi
  done
  exit 0
}
trap stop TERM INT

sleep infinity &
wait $!
