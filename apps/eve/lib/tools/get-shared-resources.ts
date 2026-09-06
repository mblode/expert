import { defineTool } from "eve/tools";
import { z } from "zod";

import { bridgeConfigured, bridgeGet } from "../vibey/bridge-client.ts";
import { groupJidFromAuth } from "../vibey/session.ts";

/**
 * Recent links/resources shared in the group, fetched from the Baileys bridge.
 * Use it for "what links/resources were shared" asks. The group JID comes from
 * the WhatsApp session auth; on other channels there's no group, so the tool
 * returns `available: false` rather than throwing.
 */

interface BridgeResource {
  t: number;
  s: string;
  n: string | null;
  url: string;
}

export default defineTool({
  description:
    "Get links/resources recently shared in this WhatsApp group. Use it for 'what links were shared' / 'any resources on X' / 'send me that link' asks. Returns oldest→newest with date, who shared it, and the URL.",
  async execute(input, ctx) {
    const jid = groupJidFromAuth(ctx.session.auth);
    if (!bridgeConfigured() || !jid) {
      return {
        available: false,
        note: "Shared resources are only available inside the WhatsApp group.",
        resources: [],
      };
    }

    const limit = input.limit ?? 40;
    try {
      const data = await bridgeGet<{ resources: BridgeResource[] }>(
        `/resources?group=${encodeURIComponent(jid)}&n=${limit}`,
      );
      const resources = data.resources.map((r) => ({
        date: new Date(r.t * 1000).toISOString(),
        from: r.n || r.s,
        url: r.url,
      }));
      return { available: true, count: resources.length, resources };
    } catch (error) {
      return { available: false, error: String(error), resources: [] };
    }
  },
  inputSchema: z.object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("How many recent resources to fetch (default 40)."),
  }),
});
