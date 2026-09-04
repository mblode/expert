// File presence enables the door; the stem is the channel id and has to match
// the connector's kind (`npm run bot -- connector add <id> incident qa`).
import { webhookChannel } from "../../../../lib/channels/webhook.ts";

export default webhookChannel({
  handling: `Triage it: is anything actually broken for a person right now?
Follow \`skills/incident\`. Open the incident file first, verify against the
real product before you believe the alert, and page the human with
\`send_message\` only when something is down, wrong, or losing data. A
recovered alert is a line in the incident file, not a message.`,
  kind: "incident",
  purpose: "Something upstream thinks a product is unhealthy.",
});
