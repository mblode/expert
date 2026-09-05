import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { DeliveryReceipts } from "./delivery.ts";

test("delivery retries survive restart without repeating or claiming an uncertain send succeeded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "expert-delivery-"));
  try {
    const receipts = new DeliveryReceipts(dir);
    let sent = 0;
    const deliver = async () => {
      sent += 1;
    };
    await Promise.all([
      receipts.send("one", "owner", "hello", deliver),
      receipts.send("one", "owner", "hello", deliver),
    ]);
    assert.equal(await new DeliveryReceipts(dir).send("one", "owner", "hello", deliver), true);
    assert.equal(sent, 1);
    await assert.rejects(receipts.send("one", "stranger", "hello", deliver), /different content/);
    await assert.rejects(
      receipts.send("two", "owner", "hello", async () => {
        throw new Error("lost acknowledgement");
      }),
      /lost acknowledgement/,
    );
    await assert.rejects(
      new DeliveryReceipts(dir).send("two", "owner", "hello", deliver),
      /uncertain/,
    );
    assert.equal(sent, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
