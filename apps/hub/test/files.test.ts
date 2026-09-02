import { describe, expect, it } from "vitest";
import { resolveWorkspacePath } from "@computer/shared";
import { FakeDesk } from "../src/desk/fake.ts";
import { FileService } from "../src/service/files.ts";
import { SeatService } from "../src/service/seat.ts";

describe("workspace paths", () => {
  it("resolves relative paths under /workspace and rejects escape", () => {
    expect(resolveWorkspacePath("a/b")).toBe("/workspace/a/b");
    expect(resolveWorkspacePath("/workspace/c")).toBe("/workspace/c");
    expect(() => resolveWorkspacePath("../etc/passwd")).toThrow(/PATH_REJECTED|escapes/);
    expect(() => resolveWorkspacePath("/etc/passwd")).toThrow(/escapes/);
    expect(() => resolveWorkspacePath("/workspace/../etc")).toThrow(/escapes/);
  });
});

describe("FileService", () => {
  it("writes and reads under /workspace", async () => {
    const files = new FileService(new FakeDesk(), new SeatService());
    const w = await files.writeFile("notes.txt", "hello");
    expect(w.bytes).toBe(5);
    const r = await files.readFile("notes.txt");
    expect(r.content).toBe("hello");
  });

  it("shell echoes and is idempotent", async () => {
    const files = new FileService(new FakeDesk(), new SeatService());
    const a = await files.shell({ argv: ["echo", "ok"], request_id: "sh1" });
    expect(a.stdout).toBe("ok\n");
    const b = await files.shell({ argv: ["echo", "ok"], request_id: "sh1" });
    expect(b).toEqual(a);
    await expect(files.shell({ argv: ["echo", "other"], request_id: "sh1" })).rejects.toMatchObject(
      { code: "CONFLICT" },
    );
  });

  it("rejects shell while the human has the seat", async () => {
    const seat = new SeatService();
    const files = new FileService(new FakeDesk(), seat);
    seat.requestTakeover();
    await expect(files.shell({ argv: ["echo", "no"], request_id: "x" })).rejects.toMatchObject({
      code: "SEAT_HELD",
    });
  });
});
