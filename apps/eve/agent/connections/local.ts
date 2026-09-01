import { defineDynamic, defineMcpClientConnection } from "eve/connections";
import { once } from "eve/tools/approval";

/**
 * An MCP server running on this machine.
 *
 * This is the one capability a cloud desktop agent structurally cannot have.
 * Its box runs in someone else's datacenter, so `localhost` there is the
 * datacenter's loopback, not the user's — it can only ever attach MCP servers
 * already exposed to the public internet. This box is the user's own machine
 * behind Tailscale, and Eve runs beside the hub on it, so a server bound to
 * 127.0.0.1 here, or to any host on the tailnet, is a legitimate target.
 *
 * eve speaks Streamable HTTP or SSE and takes a `url`; there is no stdio
 * transport. A stdio-only MCP server needs something in front of it that
 * serves HTTP — the locality is what this unlocks, not the transport.
 *
 * Dynamic rather than a static file because the URL is optional. Returning
 * null registers no connection at all, where a static definition would
 * register a dead one that every session retried.
 */
export default defineDynamic({
  events: {
    "session.started": () => {
      const url = process.env.COMPUTER_MCP_URL;
      if (!url) return null;
      return defineMcpClientConnection({
        url,
        description:
          "Tools from an MCP server running on my computer. Search here for anything tied to this machine or the network it sits on — local databases, developer tooling, files and services that are not on the public internet.",
        // An arbitrary local server, so the same posture as `shell`: ask the
        // human the first time in a session, then let it flow.
        approval: once(),
      });
    },
  },
});
