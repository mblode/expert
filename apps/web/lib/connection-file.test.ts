import { describe, expect, it } from "vitest";

import {
  acceptedStaticKey,
  connectionStatusLabel,
  connectionView,
  GUEST_CONNECTIONS_DIR,
  planConnectionFile,
} from "./connection-file";

describe("planConnectionFile", () => {
  it("authors an Eve MCP file for a pasted-key plugin and keeps the key out of source", () => {
    const secret = "sk-live-not-for-html";
    const planned = planConnectionFile({
      authKind: "static",
      credential: secret,
      name: "Done Bear",
      url: "https://mcp.donebear.app",
    });
    expect(planned).not.toHaveProperty("error");
    if ("error" in planned) {
      return;
    }
    expect(planned.name).toBe("done-bear");
    expect(planned.filename).toBe("done-bear.ts");
    expect(planned.guestPath).toBe(`${GUEST_CONNECTIONS_DIR}/done-bear.ts`);
    expect(planned.envVar).toBe("COMPUTER_CONNECTION_DONE_BEAR");
    expect(planned.source).toContain("defineMcpClientConnection");
    expect(planned.source).toContain("process.env.COMPUTER_CONNECTION_DONE_BEAR");
    expect(planned.source).toContain("https://mcp.donebear.app/");
    expect(planned.source).not.toContain(secret);
    expect(JSON.stringify(planned)).not.toContain(secret);

    const view = connectionView(planned, { hasCredential: acceptedStaticKey("static", secret) });
    expect(view).toEqual({
      authKind: "static",
      filename: "done-bear.ts",
      hasCredential: true,
      name: "done-bear",
      oauthStatus: "connected",
      path: planned.guestPath,
      url: "https://mcp.donebear.app/",
    });
    expect(JSON.stringify(view)).not.toContain(secret);
    expect(connectionStatusLabel(view)).toBe("Connected");
  });

  it("authors a Vercel Connect file for oauth and reports needs-login", () => {
    const planned = planConnectionFile({
      authKind: "oauth",
      credential: "should-not-keep",
      url: "https://mcp.linear.app/mcp",
    });
    expect(planned).not.toHaveProperty("error");
    if ("error" in planned) {
      return;
    }
    expect(planned.name).toBe("mcp-linear-app");
    expect(planned.source).toContain('from "@vercel/connect/eve"');
    expect(planned.source).toContain('connect("mcp.linear.app/mcp-linear-app")');
    expect(planned.source).not.toContain("should-not-keep");
    expect(planned).not.toHaveProperty("credential");
    expect(connectionStatusLabel(connectionView(planned))).toBe("Needs login");
  });

  it("rejects a junk address", () => {
    expect(planConnectionFile({ url: "not-a-url" })).toMatchObject({ status: 400 });
    expect(planConnectionFile({ url: "ftp://mcp.example.com" })).toMatchObject({ status: 400 });
  });
});
