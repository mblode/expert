#!/bin/bash
set -euo pipefail

export HOME="${HOME:-/home/box}"
mkdir -p "$HOME/.vnc" /workspace "$HOME/.config/chromium"

# Passwordless VNC on loopback inside compose; hub is the only publisher.
VNC_PASS="${VNC_PASSWORD:-desk}"
printf '%s\n' "$VNC_PASS" | vncpasswd -f > "$HOME/.vnc/passwd"
chmod 600 "$HOME/.vnc/passwd"

# Primary window :1 on rfb 5901. Forks (:2+) are claimed by the hub
# via start-window as Bots are configured. Input from the phone/agent
# is uinput or XTEST, not RFB.
/usr/local/bin/start-window 1 "${COMPUTER_WINDOW_OWNER:-}" "${COMPUTER_PRIMARY_BOT:-main}"

# Keep PID 1 alive. Recreate keeps the volume.
echo "desk ready; window 1 on :1 1280x800"
tail -f /dev/null
