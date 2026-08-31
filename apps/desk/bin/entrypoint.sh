#!/bin/bash
set -euo pipefail

export HOME="${HOME:-/home/box}"
mkdir -p "$HOME/.vnc" /workspace "$HOME/.config/chromium"

# Security is the hub, not RFB: every window runs -SecurityTypes None with
# RFB input refused, and compose publishes the ports on loopback only.

# Primary window :1 on rfb 5901.
/usr/local/bin/start-window 1 "${COMPUTER_WINDOW_OWNER:-}" "${COMPUTER_PRIMARY_BOT:-main}"

# Restore the forks this box had before the restart. The roster lives on the
# workspace volume, so recreating the container does not cost a Bot its
# screen; the hub re-claims them under its own owner hashes at its next boot.
ASSIGN=/workspace/.window-assignments.json
if [[ -f "$ASSIGN" ]]; then
  python3 - "$ASSIGN" <<'PYRESTORE' | while IFS='|' read -r n owner bot; do
import json, sys
try:
    with open(sys.argv[1]) as f:
        data = json.load(f)
except (ValueError, FileNotFoundError):
    data = {}
for n, entry in sorted(data.items()):
    if n != "1":
        print(f"{n}|{entry.get('owner') or ''}|{entry.get('bot_id') or ''}")
PYRESTORE
    echo "restoring window $n"
    /usr/local/bin/start-window "$n" "$owner" "$bot" --force || true
  done
fi

# Keep PID 1 alive. Recreate keeps the volume.
echo "desk ready; window 1 on :1 1280x800"
tail -f /dev/null
