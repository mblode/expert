import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { WhatsAppOwner } from "../src/service/whatsapp-owner.ts";
import { rpc, startHub } from "./helper.ts";

it("only an owner can prepare the connector or bind the phone", async () => {
  const owner = new WhatsAppOwner("expert");
  const h = await startHub({ sharedWhatsApp: { owner, deliverySecret: "test-delivery-secret" } });
  try {
    const seat = await h.pair();
    const endpoint = "/computer.v1.Seat/WhatsAppConnect";
    const denied = await fetch(`${h.url}${endpoint}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${h.agent}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "prepare" }),
    });
    expect(denied.status).toBe(401);
    const prepared = (await rpc(h.url, endpoint, { action: "prepare" }, seat)) as {
      connector_secret: string;
      connector_id: string;
    };
    expect(prepared.connector_id).toBe("whatsapp-expert");
    const repeated = await rpc(h.url, endpoint, { action: "prepare" }, seat);
    expect(repeated).toEqual(prepared);
    await rpc(h.url, endpoint, { action: "bind", jid: "61400000000@s.whatsapp.net" }, seat);
    expect(owner.identity.jid).toBe("61400000000@s.whatsapp.net");
  } finally {
    await h.close();
  }
});

it("persists a verified owner and refuses replacement after restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "expert-owner-"));
  try {
    const path = join(dir, "owner.json");
    const owner = new WhatsAppOwner("expert", path);
    expect(() => owner.bind("61400000000@lid")).toThrow();
    owner.bind("61400000000@s.whatsapp.net");
    const restarted = new WhatsAppOwner("expert", path);
    expect(restarted.identity).toEqual(owner.identity);
    restarted.bind(owner.identity.jid);
    expect(() => restarted.bind("61400000001@s.whatsapp.net")).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
