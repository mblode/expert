#!/bin/bash
# PID 1 on the Fly Machine: volumes → desk windows → Eve (one per roster bot) → hub.
# The hub is the process Fly health-checks. Desk and Eve children live beside it.
set -euo pipefail

export HOME="${HOME:-/home/box}"
export COMPUTER_CLOUD="${COMPUTER_CLOUD:-fly}"
export COMPUTER_BIND="${COMPUTER_BIND:-0.0.0.0}"
export COMPUTER_PORT="${COMPUTER_PORT:-8080}"
export COMPUTER_DESK="${COMPUTER_DESK:-local}"
export COMPUTER_DATA="${COMPUTER_DATA:-/workspace/.computer/bots.json}"
export COMPUTER_VNC_HOST="${COMPUTER_VNC_HOST:-127.0.0.1}"
export COMPUTER_VNC_PORT="${COMPUTER_VNC_PORT:-5900}"
export COMPUTER_ROLE="${COMPUTER_ROLE:-guest}"
export COMPUTER_NOVNC_BASE="${COMPUTER_NOVNC_BASE:-6080}"
export COMPUTER_VNC_TOKEN_DIR="${COMPUTER_VNC_TOKEN_DIR:-/tmp/computer-vnc}"
export COMPUTER_URL="${COMPUTER_URL:-http://127.0.0.1:8080}"
export COMPUTER_EVE_BOTS="${COMPUTER_EVE_BOTS:-/opt/computer/apps/eve/bots}"

mkdir -p /workspace /workspace/.computer /home/box/.config
chown -R box:box /workspace /home/box

if [[ -z "${COMPUTER_PUBLIC_URL:-}" && -n "${FLY_APP_NAME:-}" ]]; then
  export COMPUTER_PUBLIC_URL="https://${FLY_APP_NAME}.fly.dev"
fi

# Persist a pairing code across sleep/update so the operator is not
# re-issued a secret every cold start. Fly secrets win if set.
if [[ -z "${COMPUTER_SETUP_CODE:-}" ]]; then
  if [[ -f /workspace/.computer/setup-code ]]; then
    COMPUTER_SETUP_CODE="$(cat /workspace/.computer/setup-code)"
  else
    COMPUTER_SETUP_CODE="$(openssl rand -hex 16)"
    umask 077
    printf '%s\n' "$COMPUTER_SETUP_CODE" > /workspace/.computer/setup-code
    chown box:box /workspace/.computer/setup-code
  fi
  export COMPUTER_SETUP_CODE
fi

echo "computer guest: desk-up, then Eve per roster bot, then hub on ${COMPUTER_BIND}:${COMPUTER_PORT}"
runuser -u box -- env HOME=/home/box /usr/local/bin/desk-up

# Tokens and the hub→Eve secret live on the volume. `eve build` already ran
# in the image; this only starts `eve start` on loopback. Read the secret
# from the file — boot-eves logs must not become COMPUTER_EVE_SECRET.
cd /opt/computer
runuser -u box -- env HOME=/home/box \
  COMPUTER_DATA="$COMPUTER_DATA" \
  COMPUTER_URL="$COMPUTER_URL" \
  COMPUTER_PORT="$COMPUTER_PORT" \
  COMPUTER_EVE_BOTS="$COMPUTER_EVE_BOTS" \
  COMPUTER_EVE_SECRET="${COMPUTER_EVE_SECRET:-}" \
  AI_GATEWAY_API_KEY="${AI_GATEWAY_API_KEY:-}" \
  npm exec --workspace=apps/hub -- tsx src/host/boot-eves.ts
export COMPUTER_EVE_SECRET
COMPUTER_EVE_SECRET="$(tr -d '\n' < /workspace/.computer/eve-secret)"

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
  COMPUTER_EVE_SECRET="$COMPUTER_EVE_SECRET" \
  COMPUTER_URL="$COMPUTER_URL" \
  AI_GATEWAY_API_KEY="${AI_GATEWAY_API_KEY:-}" \
  COMPUTER_WEB_DIR=/opt/computer/apps/web/out \
  npm run start --workspace=apps/hub
