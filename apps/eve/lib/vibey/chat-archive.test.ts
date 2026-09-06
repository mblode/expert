import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ARCHIVE_FILE, readArchiveSource, tenantDataDir } from "./chat-archive-source.ts";
import {
  archiveAvailable,
  getArchiveIndex,
  loadArchive,
  resetArchiveCache,
} from "./chat-archive.ts";

/**
 * The archive is a file on the tenant's volume, not a constant in the build,
 * so what these guard is the read: the line-wrapped base64 the import script
 * writes (`renderFile` wraps at 120 chars so reingests diff line by line) has
 * to decode, and a computer with no archive has to look like a computer with
 * no archive rather than throw or invent one.
 */

const ROWS = [
  { s: "Ada", t: "1/3/2025", x: "shipping the thing" },
  { s: "Grace", t: "2/3/2025", x: "opus 4.7 is out", r: [{ e: "🔥", n: 3 }] },
];

function wrapped(b64: string): string {
  return b64.replaceAll(/(.{40})/g, "$1\n");
}

describe("the tenant's chat archive", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vibey-archive-"));
    process.env.COMPUTER_BOT_DATA = dir;
    resetArchiveCache();
  });

  afterEach(() => {
    delete process.env.COMPUTER_BOT_DATA;
    resetArchiveCache();
    rmSync(dir, { force: true, recursive: true });
  });

  it("resolves the data directory from the Bot id unless told otherwise", () => {
    expect(tenantDataDir({ COMPUTER_BOT_ID: "main" })).toBe("/workspace/.bots/main/data");
    expect(tenantDataDir({})).toBe("/workspace/.bots/main/data");
    expect(tenantDataDir({ COMPUTER_BOT_DATA: "/tmp/x" })).toBe("/tmp/x");
  });

  it("is empty and unavailable on a computer with no archive", () => {
    expect(readArchiveSource()).toBeNull();
    expect(loadArchive()).toEqual([]);
    expect(archiveAvailable()).toBe(false);
    expect(getArchiveIndex().messages).toEqual([]);
  });

  it("decodes a line-wrapped gzip+base64 file and indexes it once", () => {
    const b64 = gzipSync(Buffer.from(JSON.stringify(ROWS))).toString("base64");
    writeFileSync(join(dir, ARCHIVE_FILE), `${wrapped(b64)}\n`);
    expect(readArchiveSource()).toContain("\n");
    expect(loadArchive()).toEqual(ROWS);
    expect(archiveAvailable()).toBe(true);
    const first = getArchiveIndex();
    expect(first.messages).toBe(loadArchive());
    expect(getArchiveIndex()).toBe(first);
    expect(first.messages.some((m) => (m.r?.length ?? 0) > 0)).toBe(true);
  });

  it("treats an empty file as no archive", () => {
    writeFileSync(join(dir, ARCHIVE_FILE), "\n");
    expect(readArchiveSource()).toBeNull();
    expect(archiveAvailable()).toBe(false);
  });
});
