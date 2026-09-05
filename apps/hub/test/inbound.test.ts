import { ClockClient } from "../src/service/clock.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { InboundService } from "../src/service/inbound.ts";

describe("inbound message receipts", () => {
  it("coalesces concurrent duplicates and recovers the reply after restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "expert-inbound-"));
    try {
      const path = join(directory, "inbound.json");
      const service = new InboundService(path);
      const payload = Buffer.from("one message");
      let calls = 0;
      const work = async () => {
        calls += 1;
        return { status: 200, body: '{"reply":"done"}' };
      };
      const [first, duplicate] = await Promise.all([
        service.execute("account:message", payload, work),
        service.execute("account:message", payload, work),
      ]);
      expect(duplicate).toEqual(first);
      expect(await new InboundService(path).execute("account:message", payload, work)).toEqual(
        first,
      );
      expect(calls).toBe(1);
      expect(() => service.execute("account:message", Buffer.from("changed"), work)).toThrow(
        /different content/,
      );
      await service.execute("another-account:message", payload, work);
      expect(calls).toBe(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("never reruns a request whose external outcome was lost", async () => {
    const directory = mkdtempSync(join(tmpdir(), "expert-inbound-"));
    try {
      const path = join(directory, "inbound.json");
      const payload = Buffer.from("one message");
      let calls = 0;
      const work = async () => {
        calls += 1;
        throw new Error("lost response");
      };
      await expect(new InboundService(path).execute("key", payload, work)).rejects.toThrow(
        "lost response",
      );
      expect(() => new InboundService(path).execute("key", payload, work)).toThrow(/interrupted/);
      expect(calls).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

it("accepts durably, then delivers once through the independent driver", async () => {
  const directory = mkdtempSync(join(tmpdir(), "expert-outbox-"));
  try {
    const path = join(directory, "inbound.json");
    const clock = new ClockClient("http://unused", "one", "secret");
    vi.spyOn(clock, "hold").mockResolvedValue();
    vi.spyOn(clock, "checkAt").mockResolvedValue();
    const service = new InboundService(path);
    let finish!: (reply: { status: number; body: string }) => void;
    await service.accept(
      "key",
      Buffer.from("request"),
      { acct: "one", jid: "owner" },
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      clock,
    );
    const send = vi.fn().mockResolvedValue({ sent: true });
    await service.flush(send);
    expect(send.mock.calls[0]?.[2]).toContain("On it");
    finish({ status: 200, body: '{"reply":"finished"}' });
    await service.execute("key", Buffer.from("request"), async () => {
      throw new Error("must not repeat");
    });
    await new InboundService(path).flush(send);
    expect(send.mock.calls[1]?.[2]).toBe("finished");
    await new InboundService(path).flush(send);
    expect(send).toHaveBeenCalledTimes(2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
