import { describe, expect, it } from "vitest";
import { PhoneProvisioner } from "./phone-provision";
import type { PhoneAccount } from "./phone-account";

const row: PhoneAccount = {
  id: "test",
  jid: "15555550199@s.whatsapp.net",
  app: "expert-0123456789abcdef0123456789abcdef",
  setup_code: "private-setup",
  clock_secret: "private-clock",
  delivery_secret: "private-delivery",
  model_key: "model-key",
  stage: "app",
  lease: "lease",
  lease_until: Date.now() + 180_000,
  user_id: null,
  claim_hash: null,
  claim_until: 0,
};
const env = {
  EXPERT_FLY_TOKEN: "platform-fly-key",
  EXPERT_MODEL_KEY: "model-key",
  EXPERT_COMPUTER_IMAGE: "registry.fly.io/test:image",
};
describe("phone computer provisioning", () => {
  it("reconciles an existing app, volume and machine without creating duplicates", async () => {
    const calls: string[] = [];
    const provider = new PhoneProvisioner(env, (async (url, init) => {
      calls.push(`${init?.method} ${url}`);
      return Response.json(
        String(url).endsWith("/machines")
          ? [{ id: "machine" }]
          : String(url).endsWith("/volumes")
            ? [{ id: "volume" }]
            : { name: row.app, organization: { slug: "personal" } },
      );
    }) as typeof fetch);
    for (const stage of ["app", "volume", "machine"]) await provider.step({ ...row, stage });
    expect(calls.every((call) => call.startsWith("GET "))).toBe(true);
  });
  it("sets account secrets in the vault without copying Cursor or platform administration keys", async () => {
    let sent = "";
    await new PhoneProvisioner({ ...env, CURSOR_API_KEY: "owners-cursor-key" }, (async (
      _url,
      init,
    ) => {
      sent = String(init?.body);
      return Response.json({ data: {} });
    }) as typeof fetch).step({ ...row, stage: "secrets" });
    expect(sent).toContain("private-setup");
    expect(sent).toContain(row.jid);
    expect(sent).not.toContain("owners-cursor-key");
    expect(sent).not.toContain("platform-fly-key");
  });
  it("does not put credentials into readable machine config", async () => {
    let config: Record<string, unknown> | undefined;
    const provider = new PhoneProvisioner(env, (async (url, init) => {
      if (init?.method === "POST") {
        config = JSON.parse(String(init.body));
        return Response.json({ id: "machine" });
      }
      return Response.json(String(url).endsWith("/volumes") ? [{ id: "volume" }] : []);
    }) as typeof fetch);
    await provider.step({ ...row, stage: "machine" });
    const text = JSON.stringify(config);
    expect(text).not.toContain("private-");
    expect(text).not.toContain("model-key");
    expect(text).toContain("suspend");
    expect(text).toContain("2048");
  });
  it("rejects ambiguous resources and keeps provider response bodies out of errors", async () => {
    await expect(
      new PhoneProvisioner(env, (async () =>
        Response.json([{ id: "one" }, { id: "two" }])) as typeof fetch).step({
        ...row,
        stage: "volume",
      }),
    ).rejects.toThrow("Ambiguous");
    await expect(
      new PhoneProvisioner(
        env,
        (async () => new Response("secret-value", { status: 500 })) as typeof fetch,
      ).step(row),
    ).rejects.toThrow("failed (500)");
  });
});
