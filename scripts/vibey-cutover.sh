#!/usr/bin/env bash
# What is left of the Vibey cutover (docs/plans/vibey-on-expert.md) after
# Blode was destroyed on 2026-09-06: the steps that move a secret between
# Matt's services, so an operator runs them in one sitting. Nothing here is
# a secret; every value is read from the service that already holds it and
# written to the one that needs it. Run from the repo root with fly, railway
# and vercel signed in.
#
#   scripts/vibey-cutover.sh test        # one turn through the connector door, from the box
#   scripts/vibey-cutover.sh pa          # the personal-assistant config onto vcmc-computer (one import)
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

# The durable 202 path, coding sessions and hello.expert work links need what
# docs/DEPLOY.md "WhatsApp PA pilot" describes. The clock lists vcmc-computer
# and holds its registration secret (2026-09-06); this reads that secret back
# off the clock and the bridge admin secret off Railway, where it lives as
# EXPERT_DELIVERY_SECRET (the same value Blode held as WHATSAPP_BRIDGE_SECRET),
# adds the plain values, and restarts vcmc-computer once. The hub refuses to
# boot with a partial PA config, which is why it is one import.
pa() {
  local tmp
  tmp=$(mktemp)
  trap 'rm -f "$tmp"' RETURN
  local clock
  clock=$(fly ssh console -a expert-clock -C "printenv CLOCK_REGISTRATION_SECRETS" 2>/dev/null |
    grep -v '^Connecting' | tr -d '\r' | tail -1 |
    python3 -c 'import json,sys; print(json.load(sys.stdin).get("vcmc-computer",""))')
  [ ${#clock} -ge 32 ] || { echo "expert-clock has no registration secret for vcmc-computer" >&2; exit 1; }
  local bridge
  bridge=$(cd "$VCMC_AGENT_DIR/bridge" && railway variables --kv 2>/dev/null | grep '^EXPERT_DELIVERY_SECRET=' | cut -d= -f2-)
  [ -n "$bridge" ] || { echo "Railway has no EXPERT_DELIVERY_SECRET; the bridge's admin secret is what the hub must present" >&2; exit 1; }
  {
    printf 'WHATSAPP_BRIDGE_SECRET=%s\n' "$bridge"
    printf 'COMPUTER_CLOCK_SECRET=%s\n' "$clock"
    cat <<'PLAIN'
COMPUTER_CLOCK_URL=http://expert-clock.internal:8080
COMPUTER_CLOCK_TENANT=vcmc-computer
COMPUTER_PA_ACCOUNT=vcmc
COMPUTER_PA_OWNER_JID=61456455551@s.whatsapp.net
COMPUTER_SHARED_WHATSAPP=on
COMPUTER_BRIDGE_URL=https://vcmc-bridge-production.up.railway.app
COMPUTER_WEB_URL=https://hello.expert
COMPUTER_PUBLIC_URL=https://vcmc-computer.fly.dev
PLAIN
  } > "$tmp"
  echo "setting: $(cut -d= -f1 "$tmp" | tr '\n' ' ')"
  fly secrets import -a "$VCMC_APP" < "$tmp"
  echo "vcmc-computer is restarting in personal-assistant mode; wait for /healthz, then DM Vibey: the reply should be a 202 on the bridge and a WhatsApp message back."
}

case "${1:-}" in
  test) test_turn ;;
  route) route ;;
  pa) pa ;;
  *) sed -n 2,11p "$0"; exit 1 ;;
esac
