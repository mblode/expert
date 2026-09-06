#!/usr/bin/env bash
# What is left of the Vibey cutover (docs/plans/vibey-on-expert.md) after
# Blode was destroyed on 2026-09-06. vcmc-computer runs Vibey's agent, the
# group's Bot, and Matt's number is routed to it as one of its users; there
# is no personal-assistant mode on it and nothing left to mirror. Nothing here is
# a secret; every value is read from the service that already holds it and
# written to the one that needs it. Run from the repo root with fly, railway
# and vercel signed in.
#
#   scripts/vibey-cutover.sh test        # one turn through the connector door, from the box
#   scripts/vibey-cutover.sh route       # Railway: Matt's DMs to vcmc-computer (done 2026-09-06; idempotent)
set -euo pipefail

VCMC_APP=vcmc-computer
VCMC_AGENT_DIR="${VCMC_AGENT_DIR:-../vcmc-agent}"
CONNECTOR_SECRET_FILE=/workspace/.computer/connector-whatsapp-vcmc.secret

test_turn() {
  curl -s -m 60 -o /dev/null https://$VCMC_APP.fly.dev/healthz
  fly ssh console -a "$VCMC_APP" -C "sh -c 'S=\$(cat $CONNECTOR_SECRET_FILE); curl -sS -m 170 -w \"\\nHTTP %{http_code}\\n\" -X POST http://127.0.0.1:8080/connectors/whatsapp-vcmc/message -H content-type:application/json -H \"x-connector-secret: \$S\" -d \"{\\\"token\\\":\\\"61400000000@s.whatsapp.net\\\",\\\"sender\\\":\\\"61400000000@s.whatsapp.net\\\",\\\"senderName\\\":\\\"Test\\\",\\\"surface\\\":\\\"dm\\\",\\\"message\\\":\\\"who are you, one line, and what group are you in?\\\"}\"'"
  echo "A Vibey-voiced line naming VCMC means the identity file, the archive and the model are live."
}

route() {
  local secret
  secret=$(fly ssh console -a "$VCMC_APP" -C "cat $CONNECTOR_SECRET_FILE" 2>/dev/null | tr -d '\r\n' | tail -c 43)
  [ ${#secret} -eq 43 ] || { echo "could not read the connector secret off the box" >&2; exit 1; }
  cd "$VCMC_AGENT_DIR/bridge"
  # Plain values in one call, the secret on its own: `--set` and
  # `--set-from-stdin` in one invocation silently applies only the stdin one.
  railway variables --set "EXPERT_URL=https://$VCMC_APP.fly.dev" --set "EXPERT_CONNECTOR_ID=whatsapp-vcmc"
  railway variables --set-from-stdin EXPERT_CONNECTOR_SECRET <<< "$secret"
  railway variables --kv | grep -E '^EXPERT_(URL|CONNECTOR_ID|DM_JIDS)='
  echo "Matt's DMs (+61456455551) now reach Vibey on $VCMC_APP. Send one and check the bridge logs for target=expert."
}

case "${1:-}" in
  test) test_turn ;;
  route) route ;;
  *) sed -n 2,10p "$0"; exit 1 ;;
esac
