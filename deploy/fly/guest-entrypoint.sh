#!/bin/bash
# PID 1 on the Fly Machine: volumes → desk windows → hub.
# The hub is the process Fly health-checks. Desk children live beside it.
set -euo pipefail

export HOME="${HOME:-/home/box}"
export COMPUTER_CLOUD="${COMPUTER_CLOUD:-fly}"
export COMPUTER_BIND="${COMPUTER_BIND:-0.0.0.0}"
export COMPUTER_PORT="${COMPUTER_PORT:-8080}"
export COMPUTER_DESK="${COMPUTER_DESK:-local}"
export COMPUTER_DATA="${COMPUTER_DATA:-/data/bots.json}"
export COMPUTER_VNC_HOST="${COMPUTER_VNC_HOST:-127.0.0.1}"
export COMPUTER_VNC_PORT="${COMPUTER_VNC_PORT:-5900}"
export COMPUTER_ROLE="${COMPUTER_ROLE:-guest}"
export COMPUTER_NOVNC_BASE="${COMPUTER_NOVNC_BASE:-6080}"
export COMPUTER_VNC_TOKEN_DIR="${COMPUTER_VNC_TOKEN_DIR:-/tmp/computer-vnc}"

mkdir -p /workspace /home/box/.config /data
chown -R box:box /workspace /home/box /data

if [[ -z "${COMPUTER_PUBLIC_URL:-}" && -n "${FLY_APP_NAME:-}" ]]; then
  export COMPUTER_PUBLIC_URL="https://${FLY_APP_NAME}.fly.dev"
fi

# Persist a pairing code across sleep/update so the operator is not
# re-issued a secret every cold start. Fly secrets win if set.
if [[ -z "${COMPUTER_SETUP_CODE:-}" ]]; then
  if [[ -f /data/setup-code ]]; then
    COMPUTER_SETUP_CODE="$(cat /data/setup-code)"
  else
    COMPUTER_SETUP_CODE="$(openssl rand -hex 16)"
    umask 077
    printf '%s\n' "$COMPUTER_SETUP_CODE" > /data/setup-code
    chown box:box /data/setup-code
  fi
  export COMPUTER_SETUP_CODE
fi

echo "computer guest: desk-up then hub on ${COMPUTER_BIND}:${COMPUTER_PORT}"
runuser -u box -- env HOME=/home/box /usr/local/bin/desk-up

# Hub is PID 1 from Fly's point of view after exec.
cd /opt/computer
exec runuser -u box -- env HOME=/home/box \
  COMPUTER_CLOUD="$COMPUTER_CLOUD" \
  COMPUTER_BIND="$COMPUTER_BIND" \
  COMPUTER_PORT="$COMPUTER_PORT" \
  COMPUTER_DESK="$COMPUTER_DESK" \
  COMPUTER_DATA="$COMPUTER_DATA" \
  COMPUTER_VNC_HOST="$COMPUTER_VNC_HOST" \
  COMPUTER_VNC_PORT="$COMPUTER_VNC_PORT" \
  COMPUTER_ROLE="$COMPUTER_ROLE" \
  COMPUTER_NOVNC_BASE="$COMPUTER_NOVNC_BASE" \
  COMPUTER_VNC_TOKEN_DIR="$COMPUTER_VNC_TOKEN_DIR" \
  COMPUTER_PUBLIC_URL="${COMPUTER_PUBLIC_URL:-}" \
  COMPUTER_SETUP_CODE="$COMPUTER_SETUP_CODE" \
  COMPUTER_WEB_DIR=/opt/computer/apps/web/out \
  npm run start --workspace=apps/hub
