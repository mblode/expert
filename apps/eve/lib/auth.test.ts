import { describe, expect, it } from "vitest";
import { eveHubSecretMatches, hubLoopbackAuth } from "./auth.ts";

describe("Eve channel: hub loopback auth", () => {
  it("accepts the shared secret header", async () => {
    const auth = hubLoopbackAuth("s3cret");
    const ctx = await auth(
      new Request("http://127.0.0.1:2000/eve/v1/session", {
        headers: { "x-computer-eve-secret": "s3cret" },
      }),
    );
    expect(ctx).toMatchObject({
      authenticator: "computer-hub",
      principalId: "hub",
      principalType: "service",
    });
  });

  it("skips a missing or wrong secret so the walk can 401", async () => {
    const auth = hubLoopbackAuth("s3cret");
    expect(await auth(new Request("http://127.0.0.1:2000/eve/v1/session"))).toBeNull();
    expect(
      await auth(
        new Request("http://127.0.0.1:2000/eve/v1/session", {
          headers: { "x-computer-eve-secret": "nope" },
        }),
      ),
    ).toBeNull();
  });

  it("throws when the process has no secret at all", async () => {
    const auth = hubLoopbackAuth();
    try {
      await auth(new Request("http://127.0.0.1:2000/eve/v1/session"));
      throw new Error("expected UnauthenticatedError");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("COMPUTER_EVE_SECRET is not set");
      expect((error as { response?: Response }).response?.status).toBe(401);
    }
  });

  it("compares secrets in constant time", () => {
    expect(eveHubSecretMatches("abc", "abc")).toBe(true);
    expect(eveHubSecretMatches("abc", "abd")).toBe(false);
    expect(eveHubSecretMatches("ab", "abc")).toBe(false);
    expect(eveHubSecretMatches(null, "abc")).toBe(false);
  });
});
