import { describe, expect, it } from "vitest";
import { Agent, ALL_METHODS, Seat } from "@computer/proto";
import { AuthRegistry } from "../src/handler/auth.ts";
import { ConnectRouter } from "../src/handler/router.ts";

describe("router", () => {
  it("assertAllPolicies fails if a Connect method is missing", () => {
    const auth = new AuthRegistry({ agentTokens: () => [], setupCode: "s" });
    const router = new ConnectRouter(auth);
    expect(() => router.assertAllPolicies()).toThrow(/auth policy/);
    for (const path of ALL_METHODS) {
      router.rpc(path, "public", async () => ({}));
    }
    expect(() => router.assertAllPolicies()).not.toThrow();
  });

  it("ALL_METHODS is derived from buf-generated service descriptors", () => {
    const fromGen = [
      ...Agent.methods.map((m) => `/${Agent.typeName}/${m.name}`),
      ...Seat.methods.map((m) => `/${Seat.typeName}/${m.name}`),
    ];
    expect([...ALL_METHODS]).toEqual(fromGen);
    expect(ALL_METHODS).toContain("/computer.v1.Agent/Computer");
    expect(ALL_METHODS).toContain("/computer.v1.Seat/Type");
  });

  it("rpc() throws when policy is omitted", () => {
    const auth = new AuthRegistry({ agentTokens: () => [], setupCode: "s" });
    const router = new ConnectRouter(auth);
    expect(() =>
      router.rpc("/computer.v1.Agent/Spec", undefined as never, async () => ({})),
    ).toThrow(/auth policy/);
  });
});
