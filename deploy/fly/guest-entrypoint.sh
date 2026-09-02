#!/bin/bash
# The Fly Machine's init (under tini): volume → desk windows → Eve (one per
# roster bot) → hub. The hub is the process Fly health-checks; desk and Eve
# children live beside it.
set -euo pipefail

export HOME="${HOME:-/home/box}"
export COMPUTER_CLOUD="${COMPUTER_CLOUD:-fly}"
export COMPUTER_BIND="${COMPUTER_BIND:-0.0.0.0}"
export COMPUTER_PORT="${COMPUTER_PORT:-8080}"
export COMPUTER_DESK="${COMPUTER_DESK:-local}"
export COMPUTER_DATA="${COMPUTER_DATA:-/workspace/.computer/bots.json}"
export COMPUTER_VNC_HOST="${COMPUTER_VNC_HOST:-127.0.0.1}"
export COMPUTER_VNC_PORT="${COMPUTER_VNC_PORT:-5900}"
export COMPUTER_VNC_TOKEN_DIR="${COMPUTER_VNC_TOKEN_DIR:-/tmp/computer-vnc}"
export COMPUTER_URL="${COMPUTER_URL:-http://127.0.0.1:8080}"
export COMPUTER_EVE_BOTS="${COMPUTER_EVE_BOTS:-/opt/computer/apps/eve/bots}"

# The volume mounts root-owned. Only its top level and the hub's own state dir
# are fixed up: a recursive chown over a 128 GB workspace on every boot would
# outlast the health-check grace period.
mkdir -p /workspace/.computer
chown box:box /workspace /workspace/.computer
chown -R box:box /home/box

if [[ -z "${COMPUTER_PUBLIC_URL:-}" && -n "${FLY_APP_NAME:-}" ]]; then
  export COMPUTER_PUBLIC_URL="https://${FLY_APP_NAME}.fly.dev"
fi

# The pairing code should be a Fly secret (`fly secrets set COMPUTER_SETUP_CODE`).
# Without one, a code is minted onto the volume so the box still pairs, but
# then it is readable by anything running as `box`, the model included.
if [[ -z "${COMPUTER_SETUP_CODE:-}" ]]; then
  if [[ -f /workspace/.computer/setup-code ]]; then
    COMPUTER_SETUP_CODE="$(cat /workspace/.computer/setup-code)"
  else
    echo "computer guest: COMPUTER_SETUP_CODE is not a Fly secret; minting one onto the volume" >&2
    COMPUTER_SETUP_CODE="$(openssl rand -hex 16)"
    ( umask 077; printf '%s\n' "$COMPUTER_SETUP_CODE" > /workspace/.computer/setup-code )
    chown box:box /workspace/.computer/setup-code
  fi
  export COMPUTER_SETUP_CODE
fi

echo "computer guest: desk-up, then Eve per roster bot, then hub on ${COMPUTER_BIND}:${COMPUTER_PORT}"
# HOME is already exported. Do not re-list secrets on the runuser command
# line: that puts the gateway key, setup code, and Eve secret in `ps`.
runuser -u box --preserve-environment -- /usr/local/bin/desk-up

# Tokens and the hub→Eve secret live on the volume. `eve build` already ran
# in the image; this only starts `eve start` on loopback. Fly already injects
# AI_GATEWAY_API_KEY (and friends). Preserve that environment into box,
# do not rewrite secrets onto the runuser argv.
cd /opt/computer
runuser -u box --preserve-environment -- \
  npm exec --workspace=apps/hub -- tsx src/host/boot-eves.ts

# Read the secret from the file, since boot-eves logs must not become
# COMPUTER_EVE_SECRET. Export so the hub inherits it without argv.
COMPUTER_EVE_SECRET="$(tr -d '\n' < /workspace/.computer/eve-secret)"
export COMPUTER_EVE_SECRET

cd /opt/computer
exec runuser -u box --preserve-environment -- \
  npm run start --workspace=apps/hub
