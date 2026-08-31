#!/bin/bash
set -euo pipefail

export DISPLAY="${DISPLAY:-:1}"
export HOME="${HOME:-/home/box}"
mkdir -p "$HOME/.vnc" /workspace "$HOME/.config/chromium"

# Passwordless VNC on loopback inside compose; hub is the only publisher.
VNC_PASS="${VNC_PASSWORD:-desk}"
printf '%s\n' "$VNC_PASS" | vncpasswd -f > "$HOME/.vnc/passwd"
chmod 600 "$HOME/.vnc/passwd"

# TigerVNC 1280×800. Input from the phone/agent is uinput, not RFB.
vncserver "$DISPLAY" \
  -geometry 1280x800 \
  -depth 24 \
  -localhost no \
  -xstartup /bin/openbox \
  -SecurityTypes None \
  || vncserver "$DISPLAY" -geometry 1280x800 -depth 24 -localhost no

sleep 0.4

# Chromium on the persistent profile. Address bar is pixels + keys.
CHROMIUM="$(command -v chromium-browser || command -v chromium || true)"
if [[ -n "$CHROMIUM" ]]; then
  "$CHROMIUM" \
    --no-first-run \
    --disable-sync \
    --disable-gpu \
    --user-data-dir="$HOME/.config/chromium" \
    --window-size=1280,800 \
    --window-position=0,0 \
    about:blank >/tmp/chromium.log 2>&1 &
fi

# Keep PID 1 alive. Recreate keeps the volume.
echo "desk ready on ${DISPLAY} 1280x800"
tail -f /dev/null
