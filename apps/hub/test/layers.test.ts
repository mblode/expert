import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Agent, ALL_METHODS, Seat } from "@computer/proto";
import { AuthRegistry } from "../src/handler/auth.ts";
import { ConnectRouter } from "../src/handler/router.ts";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("layers", () => {
  it("desk may not import handler", () => {
    const root = join(import.meta.dirname, "../src/desk");
    for (const file of walk(root)) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/from\s+["'][^"']*handler/);
    }
  });

  it("assertAllPolicies fails if a Connect method is missing", () => {
    const auth = new AuthRegistry({ setupCode: "s", agentToken: "a" });
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
    const auth = new AuthRegistry({ setupCode: "s", agentToken: "a" });
    const router = new ConnectRouter(auth);
    expect(() =>
      router.rpc("/computer.v1.Agent/Spec", undefined as never, async () => ({})),
    ).toThrow(/auth policy/);
  });
});
