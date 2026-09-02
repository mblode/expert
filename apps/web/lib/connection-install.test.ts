import { describe, expect, it, vi } from "vitest";

import { installConnection } from "./connection-install";

describe("installConnection", () => {
  it("returns a file-shaped view with no credential and will write the Eve source", async () => {
    const secret = "sk-live-not-for-html";
    const write = vi.fn(async (path: string, source: string) => {
      expect(path).toBe("/workspace/eve/bots/agent/connections/done-bear.ts");
      expect(source).toContain("defineMcpClientConnection");
      expect(source).not.toContain(secret);
      return true;
    });
    const result = await installConnection({
      authKind: "static",
      credential: secret,
      name: "Done Bear",
      url: "https://mcp.donebear.app",
      write,
    });
    expect(result).not.toHaveProperty("error");
    if ("error" in result) {
      return;
    }
    expect(result.installed).toBe(true);
    expect(result.plugin.hasCredential).toBe(true);
    expect(result.plugin.oauthStatus).toBe("connected");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(write).toHaveBeenCalledOnce();
  });

  it("still returns the view when the guest write is not wired", async () => {
    const result = await installConnection({
      authKind: "oauth",
      url: "https://mcp.linear.app/mcp",
    });
    expect(result).not.toHaveProperty("error");
    if ("error" in result) {
      return;
    }
    expect(result.installed).toBe(false);
    expect(result.plugin.oauthStatus).toBe("needs_login");
    expect(result.plugin.hasCredential).toBe(false);
    expect(result.plugin.path).toContain("/workspace/eve/bots/agent/connections/");
  });
});
