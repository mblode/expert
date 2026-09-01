import { defineDynamic, defineMcpClientConnection } from "eve/connections";
import { once } from "eve/tools/approval";

/**
 * Optional MCP server on this machine. Eve runs beside the hub, so a
 * server bound to 127.0.0.1 here is a legitimate target. Unset
 * COMPUTER_MCP_URL registers no connection.
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
        approval: once(),
      });
    },
  },
});
