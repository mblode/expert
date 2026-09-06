import type * as VercelBlob from "@vercel/blob";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The blob SDK is mocked so these run offline and deterministically. The one
 * behaviour that genuinely matters here is the lost-race retry: it's what
 * replaces the bridge's per-process file lock, so if it silently reapplied the
 * mutation to a stale value, two writers would clobber each other exactly the
 * way the old design could across replicas.
 */

class FakePreconditionFailedError extends Error {
  name = "FakePreconditionFailedError";
}

const blobGet = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const blobPut = vi.fn<(...args: unknown[]) => Promise<unknown>>();

// The casts keep the fakes loose (tests hand back partial blob shapes) while
// still satisfying the real module's exported signatures.
vi.mock(import("@vercel/blob"), () => ({
  BlobPreconditionFailedError:
    FakePreconditionFailedError as unknown as typeof VercelBlob.BlobPreconditionFailedError,
  get: ((...args: unknown[]) => blobGet(...args)) as unknown as typeof VercelBlob.get,
  put: ((...args: unknown[]) => blobPut(...args)) as unknown as typeof VercelBlob.put,
}));

const {
  appendMemoryWrites,
  auditKey,
  blobConfigured,
  dayKey,
  episodesKey,
  memoryKey,
  mutateJson,
  readEpisodes,
  readJson,
  recordEpisode,
  safeJid,
  writeGroupMemoryCategory,
} = await import("./memory-store.js");

/**
 * Shape a get() success the way the SDK returns it. A body stream can only be
 * read once, so anything mocking more than one read must build a fresh result
 * per call (`alwaysOk`) rather than reusing one object.
 */
const ok = (value: unknown, etag: string) => ({
  blob: { etag },
  statusCode: 200,
  stream: Response.json(value).body,
});

/** A get() mock that returns a fresh, re-readable result on every call. */
const alwaysOk = (value: unknown, etag: string) => () => Promise.resolve(ok(value, etag));

const resetMocks = (): void => {
  blobGet.mockReset();
  blobPut.mockReset();
  process.env.BLOB_READ_WRITE_TOKEN = "test-token";
  // Every assertion below is on a production pathname, so the namespace has to
  // start empty regardless of what the ambient environment sets.
  process.env.MEMORY_BLOB_PREFIX = "";
};

describe(safeJid, () => {
  beforeEach(resetMocks);

  it("flattens a group jid to a path-safe string", () => {
    expect(safeJid("120363416795798121@g.us")).toBe("120363416795798121_g_us");
  });

  it("matches the bridge's safe() so migrated paths line up", () => {
    expect(safeJid("6140-000:12@s.whatsapp.net")).toBe("6140_000_12_s_whatsapp_net");
  });
});

describe(memoryKey, () => {
  beforeEach(resetMocks);

  it("namespaces under memory/", () => {
    expect(memoryKey("123@g.us")).toBe("memory/123_g_us.json");
  });
});

describe("MEMORY_BLOB_PREFIX", () => {
  beforeEach(resetMocks);

  /**
   * The load-bearing one. `BLOB_READ_WRITE_TOKEN` is in `.env.local`, so
   * `eve eval` runs against the live store; the prefix is what keeps a
   * fixture-writing eval out of the real group's memory. But an accidental
   * prefix in production points every read at an empty namespace and orphans
   * everything already written, so "unset means byte-identical" is pinned here
   * for all three key builders.
   */
  it("changes nothing when it is unset", () => {
    process.env.MEMORY_BLOB_PREFIX = "";
    expect(memoryKey("123@g.us")).toBe("memory/123_g_us.json");
    expect(auditKey("123@g.us")).toBe("audit/123_g_us.json");
    expect(episodesKey("123@g.us")).toBe("episodes/123_g_us.json");
  });

  it("moves the whole namespace sideways when set", () => {
    process.env.MEMORY_BLOB_PREFIX = "eval";
    expect(memoryKey("123@g.us")).toBe("eval/memory/123_g_us.json");
    expect(auditKey("123@g.us")).toBe("eval/audit/123_g_us.json");
    expect(episodesKey("123@g.us")).toBe("eval/episodes/123_g_us.json");
  });

  it("normalises a trailing slash rather than doubling it", () => {
    // `eval/` is the obvious way to write it and would otherwise produce
    // `eval//memory/...`, a different (and confusing) pathname.
    process.env.MEMORY_BLOB_PREFIX = "eval/";
    expect(memoryKey("123@g.us")).toBe("eval/memory/123_g_us.json");
  });

  it("treats whitespace as unset", () => {
    process.env.MEMORY_BLOB_PREFIX = "   ";
    expect(memoryKey("123@g.us")).toBe("memory/123_g_us.json");
  });

  it("is applied to the blob the store actually writes", async () => {
    process.env.MEMORY_BLOB_PREFIX = "eval";
    blobGet.mockResolvedValue(null);
    blobPut.mockResolvedValue({});

    await recordEpisode("123@g.us", {
      day: "2026-08-05",
      messageCount: 1,
      style: "digest",
      t: 1_780_000_000,
      text: "x",
    });

    expect(blobPut.mock.calls[0][0]).toBe("eval/episodes/123_g_us.json");
  });
});

describe(dayKey, () => {
  beforeEach(resetMocks);

  it("is a UTC date, so audit blobs sort chronologically", () => {
    expect(dayKey(new Date("2026-08-05T13:45:00Z"))).toBe("2026-08-05");
  });

  it("uses UTC rather than local time at the day boundary", () => {
    expect(dayKey(new Date("2026-08-05T23:30:00Z"))).toBe("2026-08-05");
  });
});

describe(blobConfigured, () => {
  beforeEach(resetMocks);

  it("is false with no token or store id", () => {
    process.env.BLOB_READ_WRITE_TOKEN = "";
    process.env.BLOB_STORE_ID = "";
    expect(blobConfigured()).toBeFalsy();
  });

  it("is true with a token", () => {
    expect(blobConfigured()).toBeTruthy();
  });
});

describe(readJson, () => {
  beforeEach(resetMocks);

  it("returns null when the blob is missing", async () => {
    blobGet.mockResolvedValue(null);
    await expect(readJson("memory/x.json")).resolves.toBeNull();
  });

  it("returns null on malformed JSON rather than throwing", async () => {
    blobGet.mockResolvedValue({
      blob: { etag: "e1" },
      statusCode: 200,
      stream: new Response("not json").body,
    });
    await expect(readJson("memory/x.json")).resolves.toBeNull();
  });

  it("returns null when the store is unconfigured", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "";
    process.env.BLOB_STORE_ID = "";
    await expect(readJson("memory/x.json")).resolves.toBeNull();
    expect(blobGet).not.toHaveBeenCalled();
  });

  it("strips the weak-validator prefix from a compressed blob's etag", async () => {
    // The bug that turned the whole store read-only. Above ~1KB the blob is
    // served compressed and its etag comes back as `W/"<hash>"`, which `put`'s
    // ifMatch rejects on every attempt — so memory, audit and episodes all
    // stopped accepting writes while reporting contention.
    blobGet.mockImplementation(alwaysOk({ a: 1 }, 'W/"abc123"'));

    await expect(readJson("memory/x.json")).resolves.toMatchObject({
      etag: '"abc123"',
    });
  });

  it("serves the hot path from cache but lets writers bypass it", async () => {
    blobGet.mockImplementation(alwaysOk({ a: 1 }, "e1"));
    await readJson("memory/x.json");
    expect(blobGet.mock.calls[0][1]).toMatchObject({ useCache: true });

    await readJson("memory/x.json", { fresh: true });
    expect(blobGet.mock.calls[1][1]).toMatchObject({ useCache: false });
  });
});

describe(mutateJson, () => {
  beforeEach(resetMocks);

  it("creates without ifMatch when the blob does not exist", async () => {
    blobGet.mockResolvedValue(null);
    blobPut.mockResolvedValue({});

    await mutateJson("memory/x.json", () => ({ a: 1 }));

    // allowOverwrite:false turns a lost create race into an error we can retry.
    expect(blobPut.mock.calls[0][2]).toMatchObject({ allowOverwrite: false });
    expect(blobPut.mock.calls[0][2]).not.toHaveProperty("ifMatch");
  });

  it("writes conditionally on the etag it read", async () => {
    blobGet.mockImplementation(alwaysOk({ a: 1 }, "etag-1"));
    blobPut.mockResolvedValue({});

    await mutateJson<Record<string, number>>("memory/x.json", (cur) => ({
      ...cur,
      b: 2,
    }));

    expect(blobPut.mock.calls[0][2]).toMatchObject({ ifMatch: "etag-1" });
  });

  it("reapplies the mutation to the winner's value after a lost race", async () => {
    // The whole point: the retry must not replay our stale snapshot, or the
    // concurrent writer's category would be silently dropped.
    blobGet
      .mockResolvedValueOnce(ok({ lore: "ours" }, "etag-1"))
      .mockResolvedValueOnce(ok({ decisions: "theirs", lore: "ours" }, "etag-2"));
    blobPut
      .mockRejectedValueOnce(new FakePreconditionFailedError("stale"))
      .mockResolvedValueOnce({});

    const result = await mutateJson<Record<string, string>>("memory/x.json", (cur) => ({
      ...cur,
      members: "added",
    }));

    expect(result).toStrictEqual({
      decisions: "theirs",
      lore: "ours",
      members: "added",
    });
    expect(blobPut.mock.calls[1][2]).toMatchObject({ ifMatch: "etag-2" });
  });

  it("rethrows a non-precondition error instead of retrying", async () => {
    blobGet.mockImplementation(alwaysOk({ a: 1 }, "etag-1"));
    blobPut.mockRejectedValue(new Error("token expired"));

    await expect(mutateJson("memory/x.json", (cur) => cur)).rejects.toThrow("token expired");
    expect(blobPut).toHaveBeenCalledOnce();
  });

  it("gives up rather than spinning forever under sustained contention", async () => {
    // Real contention moves the blob under us: a different etag on every read.
    let n = 0;
    blobGet.mockImplementation(() => {
      n += 1;
      return Promise.resolve(ok({ a: n }, `etag-${n}`));
    });
    blobPut.mockRejectedValue(new FakePreconditionFailedError("stale"));

    await expect(mutateJson("memory/x.json", (cur) => cur)).rejects.toThrow(/contended/u);
  });

  it("does not call a permanent rejection contention", async () => {
    // The weak-etag failure: the precondition is refused while the blob sits
    // perfectly still. Retrying can only reproduce it, and calling it
    // contention is what sent the first investigation looking for a second
    // writer that never existed.
    blobGet.mockImplementation(alwaysOk({ a: 1 }, "etag-1"));
    blobPut.mockRejectedValue(new FakePreconditionFailedError("stale"));

    await expect(mutateJson("memory/x.json", (cur) => cur)).rejects.toThrow(
      /has not changed — this is not contention/u,
    );
    // Fails on the second read, not after burning the whole budget.
    expect(blobPut).toHaveBeenCalledOnce();
  });

  it("aborts the write when the mutation returns null", async () => {
    blobGet.mockImplementation(alwaysOk({ a: 1 }, "etag-1"));

    await expect(mutateJson("memory/x.json", () => null)).resolves.toBeNull();
    expect(blobPut).not.toHaveBeenCalled();
  });
});

describe(writeGroupMemoryCategory, () => {
  beforeEach(resetMocks);

  it("replaces one category and leaves the others intact", async () => {
    blobGet.mockImplementation(alwaysOk({ decisions: "keep", lore: "old" }, "e1"));
    blobPut.mockResolvedValue({});

    const next = await writeGroupMemoryCategory("123@g.us", "lore", "new");

    expect(next).toStrictEqual({ decisions: "keep", lore: "new" });
  });

  it("works when the group has no memory yet", async () => {
    blobGet.mockResolvedValue(null);
    blobPut.mockResolvedValue({});

    await expect(writeGroupMemoryCategory("123@g.us", "lore", "first")).resolves.toStrictEqual({
      lore: "first",
    });
  });
});

describe(recordEpisode, () => {
  beforeEach(resetMocks);

  const episode = {
    day: "2026-08-05",
    messageCount: 24,
    style: "digest",
    t: 1_780_000_000,
    text: "Fraser talked at BuildPass. Everyone argued about Cursor.",
  };

  it("writes a day's recap", async () => {
    blobGet.mockResolvedValue(null);
    blobPut.mockResolvedValue({});

    await expect(recordEpisode("123@g.us", episode)).resolves.toBeTruthy();
    expect(blobPut.mock.calls[0][0]).toBe("episodes/123_g_us.json");
  });

  it("keeps the first recap of a day rather than overwriting", async () => {
    // Two subscribers on different styles both finish a recap of the same day.
    // Storing both would leave two overlapping summaries and the model would
    // cite whichever ranked higher, so the first one written is the record.
    const existing = [{ ...episode, style: "tldr", text: "Earlier, terser." }];
    blobGet.mockImplementation(alwaysOk(existing, "e1"));
    blobPut.mockResolvedValue({});

    await expect(recordEpisode("123@g.us", episode)).resolves.toBeFalsy();
    expect(blobPut).not.toHaveBeenCalled();
  });

  it("degrades to false with no store configured", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "";
    process.env.BLOB_STORE_ID = "";
    await expect(recordEpisode("123@g.us", episode)).resolves.toBeFalsy();
  });
});

describe(readEpisodes, () => {
  beforeEach(resetMocks);

  it("returns [] with no store configured", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "";
    process.env.BLOB_STORE_ID = "";
    await expect(readEpisodes("123@g.us")).resolves.toStrictEqual([]);
  });

  it("reads the whole recap history in a single request", async () => {
    // One blob, not one per day: search-chat calls this on every search, so a
    // per-day layout meant ~60 GETs per query against a corpus that is usually
    // empty.
    blobGet.mockResolvedValue(null);
    await expect(readEpisodes("123@g.us")).resolves.toStrictEqual([]);
    expect(blobGet).toHaveBeenCalledOnce();
  });
});

const write = (id: string) => ({
  by: "overnight-pass",
  category: "members",
  content: `entry ${id}`,
  id,
  previous: null,
  reason: "role_changed: X",
  source: "auto" as const,
  t: 1_780_000_000,
});

describe(appendMemoryWrites, () => {
  beforeEach(resetMocks);

  it("appends a whole batch in ONE read-modify-write", async () => {
    // The regression this exists for: the overnight pass records several writes
    // at once and they all target the same blob. Appending them individually
    // fires N concurrent RMWs, which exhaust mutateJson's retry budget and get
    // swallowed — losing the audit trail for exactly the autonomous writes that
    // most need one.
    blobGet.mockImplementation(alwaysOk([write("old")], "e1"));
    blobPut.mockResolvedValue({});

    await appendMemoryWrites("123@g.us", [write("a"), write("b"), write("c")]);

    expect(blobPut).toHaveBeenCalledOnce();
    const body = JSON.parse(blobPut.mock.calls[0][1] as string);
    expect(body.map((w: { id: string }) => w.id)).toStrictEqual(["old", "a", "b", "c"]);
  });

  it("does nothing for an empty batch", async () => {
    await appendMemoryWrites("123@g.us", []);
    expect(blobPut).not.toHaveBeenCalled();
    expect(blobGet).not.toHaveBeenCalled();
  });

  it("never throws — a lost audit line must not fail the save it records", async () => {
    blobGet.mockImplementation(alwaysOk([], "e1"));
    blobPut.mockRejectedValue(new Error("blob down"));

    await expect(appendMemoryWrites("123@g.us", [write("a")])).resolves.toBeUndefined();
  });
});
