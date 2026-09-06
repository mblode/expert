#!/usr/bin/env bash
# The steps of docs/plans/vibey-on-expert.md slices 4 and 5 that move a
# secret from one of Matt's services to another, so an operator runs them
# in one sitting. Nothing here is a secret; every value is read from the
# service that already holds it and written to the one that needs it. Run
# from the expert repo root with fly, railway and vercel signed in.
#
#   scripts/vibey-cutover.sh secrets     # 1. tenant secrets onto vcmc-computer, then restart
#   scripts/vibey-cutover.sh test        # 2. one turn through the connector door, from the box
#   scripts/vibey-cutover.sh route       # 3. Railway: Matt's DMs to vcmc-computer
#   scripts/vibey-cutover.sh kill-blode  # 4. snapshot, rebind hello.expert, destroy mblode-computer
set -euo pipefail

VCMC_APP=vcmc-computer
BLODE_APP=mblode-computer
VCMC_AGENT_DIR="${VCMC_AGENT_DIR:-../vcmc-agent}"
CONNECTOR_SECRET_FILE=/workspace/.computer/connector-whatsapp-vcmc.secret

# Read one variable out of a running Machine's PID 1 environment. Fly does
# not read secrets back, but root on the guest can, and PID 1 is init.
guest_env() { # app name
  fly ssh console -a "$1" -C "sh -c 'tr \"\\0\" \"\\n\" < /proc/1/environ | grep \"^$2=\"'" 2>/dev/null |
    grep "^$2=" | cut -d= -f2-
}

secrets() {
  local tmp
  tmp=$(mktemp)
  trap 'rm -f "$tmp"' RETURN
  # Blode's working gateway key (the one on vcmc-computer answers 401), the
  # Cursor key and the repo allowlist for coding sessions.
  for k in AI_GATEWAY_API_KEY CURSOR_API_KEY COMPUTER_PA_REPOS; do
    v=$(guest_env "$BLODE_APP" "$k" || true)
    [ -n "$v" ] && printf '%s=%s\n' "$k" "$v" >> "$tmp"
  done
  # On 2026-09-06 the read above came back empty for all three from an agent
  # session, and the key on vcmc-computer answers 401, so a run without it
  # would restart the Machine into the same failure. Take it at the prompt
  # instead (a fresh key from vercel.com/ai-gateway is fine); a blank line
  # keeps the deployed one.
  if ! grep -q '^AI_GATEWAY_API_KEY=' "$tmp"; then
    read -rs -p "AI_GATEWAY_API_KEY could not be read off $BLODE_APP; paste a working key (blank to keep the deployed one): " v; echo
    [ -n "$v" ] && printf 'AI_GATEWAY_API_KEY=%s\n' "$v" >> "$tmp"
  fi
  # The Vercel project's env is the source for everything Vibey's tools use.
  (cd "$VCMC_AGENT_DIR" && vercel env pull "$tmp.vercel" --environment=production --yes >/dev/null)
  for k in BLOB_READ_WRITE_TOKEN FIRECRAWL_API_KEY BRIDGE_URL DIGEST_SUBSCRIBERS REFRESH_GROUP_JID MEMORY_ALERT_JID; do
    v=$(grep "^$k=" "$tmp.vercel" | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' || true)
    [ -n "$v" ] && printf '%s=%s\n' "$k" "$v" >> "$tmp"
  done
  # The Railway bridge's secret, under the name the supervisor lets through to
  # the Eve child (WHATSAPP_BRIDGE_SECRET is denied there: apps/eve/lib/vibey/bridge-client.ts).
  v=$(grep '^WHATSAPP_BRIDGE_SECRET=' "$tmp.vercel" | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')
  printf 'VIBEY_BRIDGE_SECRET=%s\n' "$v" >> "$tmp"
  rm -f "$tmp.vercel"
  echo "setting: $(cut -d= -f1 "$tmp" | tr '\n' ' ')"
  fly secrets import -a "$VCMC_APP" < "$tmp"
  echo "vcmc-computer is restarting with the new secrets; wait for /healthz, then: $0 test"
}

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

kill_blode() {
  echo "snapshotting Blode's volume"
  fly volumes snapshots create vol_vly9o35g2m8ln3m4 -a "$BLODE_APP"
  # hello.expert: Matt's email binds to vibey now. The value is emails, not a secret.
  (cd apps/web && current=$(vercel env pull /dev/stdout --environment=production --yes 2>/dev/null | grep '^COMPUTER_BINDINGS=' | cut -d= -f2- | tr -d '"') && echo "COMPUTER_BINDINGS was: $current" &&
    printf '%s' "${current//:blode/:vibey}" | vercel env add COMPUTER_BINDINGS production --force >/dev/null && echo "rebound to vibey; redeploy hello.expert for it to take effect")
  read -r -p "destroy $BLODE_APP and its 20 GB volume? type the app name to confirm: " answer
  [ "$answer" = "$BLODE_APP" ] || { echo "not destroyed"; exit 1; }
  fly apps destroy "$BLODE_APP" --yes
  echo "Blode is gone. Remove its row from apps/web/lib/computers.ts and the channels.json aliases (docs/WHATSAPP-PARITY.md Phase 2 follow-up)."
}

case "${1:-}" in
  secrets) secrets ;;
  test) test_turn ;;
  route) route ;;
  kill-blode) kill_blode ;;
  *) sed -n 2,12p "$0"; exit 1 ;;
esac
