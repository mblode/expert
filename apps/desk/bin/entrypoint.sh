#!/bin/bash
set -euo pipefail

/usr/local/bin/desk-up

# Keep PID 1 alive. Recreate keeps the volume.
tail -f /dev/null
