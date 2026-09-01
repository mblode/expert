#!/bin/bash
# Always-on edge. Does not start X. Status/roster never wake the guest.
set -euo pipefail
export COMPUTER_ROLE="${COMPUTER_ROLE:-edge}"
export COMPUTER_CLOUD="${COMPUTER_CLOUD:-fly}"
export COMPUTER_BIND="${COMPUTER_BIND:-0.0.0.0}"
export COMPUTER_PORT="${COMPUTER_PORT:-8080}"
cd /opt/computer
exec npm exec --workspace=apps/hub -- tsx src/host/edge-cli.ts
