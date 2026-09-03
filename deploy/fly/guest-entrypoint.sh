#!/bin/bash
# The Fly Machine's init (under tini): a thin shell around the root init in
# apps/hub/src/host/init.ts, which fixes the volume and supervises desk → Eve (one per roster bot) → bridge → hub as
# box or hub. Secrets come from the platform env; none go on argv.
set -euo pipefail

export HOME="${HOME:-/home/box}"
export COMPUTER_CLOUD="${COMPUTER_CLOUD:-fly}"
export COMPUTER_BIND="${COMPUTER_BIND:-0.0.0.0}"
export COMPUTER_PORT="${COMPUTER_PORT:-8080}"
export COMPUTER_DESK="${COMPUTER_DESK:-local}"
export COMPUTER_DATA="${COMPUTER_DATA:-/workspace/.computer/bots.json}"
export COMPUTER_VNC_HOST="${COMPUTER_VNC_HOST:-127.0.0.1}"
export COMPUTER_VNC_PORT="${COMPUTER_VNC_PORT:-5900}"
export COMPUTER_URL="${COMPUTER_URL:-http://127.0.0.1:8080}"
# Image default. init prefers /workspace/eve/bots when that tree has an Eve
# project (tenant overlay, including a standalone agent/).
export COMPUTER_EVE_BOTS="${COMPUTER_EVE_BOTS:-/opt/computer/apps/eve/bots}"
export COMPUTER_RUN_DIR="${COMPUTER_RUN_DIR:-/run/computer}"

if [[ -z "${COMPUTER_PUBLIC_URL:-}" && -n "${FLY_APP_NAME:-}" ]]; then
  export COMPUTER_PUBLIC_URL="https://${FLY_APP_NAME}.fly.dev"
fi

# The desk's fork-token dir, start-window's own default, box-owned because
# start-window runs as box. COMPUTER_VNC_TOKEN_DIR is deliberately not
# exported: init hands the whole env to the hub child, so one exported path
# became both writers' path, and the hub (uid hub) writes its pixel tokens
# through PixelRegistry. A box-owned 0755 directory holding box-owned 0600
# files is unwritable by hub, so Seat.Status threw EACCES for every fork
# display. Unset, the hub keeps its own default under the hub-owned
# /workspace/.computer/vnc-tokens that init creates at 0700.
mkdir -p /tmp/computer-vnc "$COMPUTER_RUN_DIR"
chown box:box /tmp/computer-vnc

# COMPUTER_SETUP_CODE must be a Fly secret; init refuses to mint one on a
# cloud deployment (set COMPUTER_ALLOW_MINTED_SETUP_CODE=1 to override for
# a throwaway box). The eve secret, roster and bridge secret are minted onto
# the volume by init, hub-owned at 0600.
echo "computer guest: init (desk, eve per roster bot, bridge, hub) on ${COMPUTER_BIND}:${COMPUTER_PORT}"
cd /opt/computer
exec npm exec --workspace=apps/hub -- tsx src/host/init.ts
