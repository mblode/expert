import { describe, expect, it } from "vitest";
import { asPixelX, asPixelY, asPoint, ComputerError } from "@computer/shared";
import type { Action, ImageMeta } from "@computer/shared";
import { FakeDesk } from "../src/desk/fake.ts";
import { ComputerService } from "../src/service/computer.ts";
import { SeatService } from "../src/service/seat.ts";

describe("ComputerService", () => {
  it("runs actions in order and screenshots after the batch", async () => {
    const desk = new FakeDesk();
    const computer = new ComputerService(desk, new SeatService());
    const r = await computer.run("r1", [
      { type: "move", x: asPixelX(10), y: asPixelY(20) },
      { type: "click", x: asPixelX(10), y: asPixelY(20) },
    ]);
    expect(r.results).toHaveLength(2);
    expect(r.results.every((x) => x.kind === "ok")).toBe(true);
    expect(r.screenshot_b64).toBeTruthy();
    expect(r.display).toEqual({ height: 800, scale: 1, width: 1280 });
    expect(desk.log.filter((l) => l === "screenshot")).toHaveLength(1);
  });

  it("does not attach a trailing screenshot after screenshot or zoom", async () => {
    const desk = new FakeDesk();
    const computer = new ComputerService(desk, new SeatService());
    const shot = await computer.run("s1", [{ type: "screenshot" }]);
    expect(shot.results[0]).toMatchObject({ kind: "ok" });
    expect(shot.screenshot_b64).toBeUndefined();
    expect((shot.results[0] as { image_b64?: string }).image_b64).toBeTruthy();

    const zoom = await computer.run("z1", [
      { h: 80, type: "zoom", w: 100, x: asPixelX(0), y: asPixelY(0) },
    ]);
    expect(zoom.screenshot_b64).toBeUndefined();
    expect((zoom.results[0] as { image_b64?: string }).image_b64).toBeTruthy();
  });

  it("skips the rest on first failure (Claude rule)", async () => {
    const desk = new FakeDesk();
    desk.failKeys = "boom";
    const computer = new ComputerService(desk, new SeatService());
    const r = await computer.run("fail1", [
      { type: "click", x: asPixelX(10), y: asPixelY(10) },
      { keys: ["boom"], type: "keypress" },
      { text: "nope", type: "type" },
    ]);
    expect(r.results[0]?.kind).toBe("ok");
    expect(r.results[1]).toMatchObject({ code: "DAEMON_DOWN", kind: "error" });
    expect(r.results[2]).toEqual({ kind: "skipped", reason: "prior_failed" });
    expect(r.screenshot_b64).toBeTruthy();
  });

  it("validates the whole batch before running any of it", async () => {
    const desk = new FakeDesk();
    const computer = new ComputerService(desk, new SeatService());
    await expect(
      computer.run("v1", [
        { type: "click", x: asPixelX(10), y: asPixelY(10) },
        { type: "click", x: asPixelX(9000), y: asPixelY(10) },
      ]),
    ).rejects.toMatchObject({ code: "OUT_OF_BOUNDS" });
    await expect(computer.run("v2", [{ ms: 9000, type: "wait" }])).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(
      computer.run("v3", [{ path: [asPoint(1, 1)], type: "drag" }]),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      computer.run("v4", [{ type: "click", x: asPixelX(10.5), y: asPixelY(10) }]),
    ).rejects.toMatchObject({ code: "OUT_OF_BOUNDS" });
    // Nothing touched the box, so the ids are free to reuse with a fixed body.
    expect(desk.log).toEqual([]);
    const ok = await computer.run("v1", [{ type: "click", x: asPixelX(10), y: asPixelY(10) }]);
    expect(ok.results[0]?.kind).toBe("ok");
  });

  it("request_takeover is terminal and further computer calls are SEAT_HELD", async () => {
    const seat = new SeatService();
    const computer = new ComputerService(new FakeDesk(), seat);
    const r = await computer.run("tk1", [
      { type: "request_takeover" },
      { type: "click", x: asPixelX(1), y: asPixelY(1) },
    ]);
    expect(r.results[0]?.kind).toBe("ok");
    expect(r.results[1]).toEqual({ kind: "skipped", reason: "after_takeover" });
    expect(r.seat).toBe("WAITING");
    await expect(computer.run("tk2", [{ type: "screenshot" }])).rejects.toBeInstanceOf(
      ComputerError,
    );
  });

  it("a human taking the seat mid-batch stops the rest of it", async () => {
    const seat = new SeatService();
    const desk = new FakeDesk();
    const computer = new ComputerService(desk, seat);
    const run = computer.run("mid", [
      { ms: 30, type: "wait" },
      { type: "click", x: asPixelX(1), y: asPixelY(1) },
    ]);
    // The first action is already underway when the human grabs the wheel.
    await new Promise((r) => setTimeout(r, 5));
    seat.setPresence(true);
    const r = await run;
    expect(r.results[0]?.kind).toBe("ok");
    expect(r.results[1]).toEqual({ kind: "skipped", reason: "seat_taken" });
    expect(desk.log.some((l) => l.startsWith("click"))).toBe(false);
  });

  it("is idempotent on request_id and CONFLICT on a different body", async () => {
    const desk = new FakeDesk();
    const computer = new ComputerService(desk, new SeatService());
    const a = await computer.run("id1", [{ type: "click", x: asPixelX(3), y: asPixelY(4) }]);
    const clicks = desk.log.filter((l) => l.startsWith("click")).length;
    const b = await computer.run("id1", [{ type: "click", x: asPixelX(3), y: asPixelY(4) }]);
    expect(b).toEqual(a);
    expect(desk.log.filter((l) => l.startsWith("click")).length).toBe(clicks);
    await expect(
      computer.run("id1", [{ type: "click", x: asPixelX(5), y: asPixelY(6) }]),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("an overlapping retry with the same request_id waits for the first run", async () => {
    const desk = new FakeDesk();
    const computer = new ComputerService(desk, new SeatService());
    const body: Action[] = [
      { ms: 20, type: "wait" },
      { type: "click", x: asPixelX(3), y: asPixelY(4) },
    ];
    const [a, b] = await Promise.all([computer.run("dup", body), computer.run("dup", body)]);
    expect(b).toEqual(a);
    expect(desk.log.filter((l) => l.startsWith("click"))).toHaveLength(1);
  });

  it("a batch that never ran is not cached", async () => {
    const desk = new FakeDesk({ failPing: true });
    const computer = new ComputerService(desk, new SeatService());
    await expect(computer.run("np", [{ type: "screenshot" }])).rejects.toMatchObject({
      code: "DAEMON_DOWN",
    });
    desk.failPing = false;
    const r = await computer.run("np", [{ type: "screenshot" }]);
    expect(r.results[0]?.kind).toBe("ok");
  });

  it("zoom does not rematch the coordinate space", async () => {
    const desk = new FakeDesk();
    const computer = new ComputerService(desk, new SeatService());
    await computer.run("zm", [
      { h: 200, type: "zoom", w: 200, x: asPixelX(100), y: asPixelY(100) },
      { type: "click", x: asPixelX(110), y: asPixelY(110) },
    ]);
    expect(desk.log.some((l) => l === "click left 110,110")).toBe(true);
  });

  it("emits credential pending_check when a password field is focused", async () => {
    const desk = new FakeDesk();
    desk.hint = { confirm: false, password: true, title: "Password" };
    const computer = new ComputerService(desk, new SeatService());
    const r = await computer.run("pc", [{ type: "screenshot" }]);
    expect(r.pending_checks[0]?.code).toBe("credential");
  });

  it("DAEMON_DOWN when desk ping fails", async () => {
    const desk = new FakeDesk({ failPing: true });
    const computer = new ComputerService(desk, new SeatService());
    await expect(computer.run("d1", [{ type: "screenshot" }])).rejects.toMatchObject({
      code: "DAEMON_DOWN",
    });
  });

  it("names every image by its content, and states a zoom's source rectangle", async () => {
    const desk = new FakeDesk();
    const computer = new ComputerService(desk, new SeatService());

    const shot = await computer.run("im1", [{ type: "screenshot" }]);
    const shotImage = (shot.results[0] as { image?: ImageMeta }).image;
    expect(shotImage).toMatchObject({ height: 1, width: 1 });
    expect(shotImage?.id).toMatch(/^img_[0-9a-f]{16}$/);
    // A full capture crops nothing, so there is no rectangle to state.
    expect(shotImage?.source).toBeUndefined();

    const zoom = await computer.run("im2", [
      { h: 200, type: "zoom", w: 300, x: asPixelX(100), y: asPixelY(50) },
    ]);
    expect((zoom.results[0] as { image?: ImageMeta }).image?.source).toEqual({
      h: 200,
      w: 300,
      x: 100,
      y: 50,
    });
  });

  it("gives two identical screens the same image id", async () => {
    const desk = new FakeDesk();
    const computer = new ComputerService(desk, new SeatService());
    const first = await computer.run("id1", [{ type: "screenshot" }]);
    const second = await computer.run("id2", [{ type: "screenshot" }]);
    // The whole point of hashing the bytes: a model can tell a click that
    // changed nothing from one that did, without diffing pixels.
    expect((first.results[0] as { image?: ImageMeta }).image?.id).toBe(
      (second.results[0] as { image?: ImageMeta }).image?.id,
    );
  });

  it("carries metadata for the trailing screenshot too", async () => {
    const desk = new FakeDesk();
    const computer = new ComputerService(desk, new SeatService());
    const r = await computer.run("tr1", [{ type: "click", x: asPixelX(10), y: asPixelY(10) }]);
    expect(r.screenshot_b64).toBeTruthy();
    expect(r.screenshot).toMatchObject({ height: 1, width: 1 });
    expect(r.screenshot?.id).toMatch(/^img_/);
  });

  it("reports the focused window, bounded and stripped of control characters", async () => {
    const desk = new FakeDesk();
    desk.hint = { confirm: false, password: false, title: `Mail\n\u202Eevil${"x".repeat(400)}` };
    const computer = new ComputerService(desk, new SeatService());
    const r = await computer.run("f1", [{ type: "click", x: asPixelX(1), y: asPixelY(1) }]);
    // Stripped, not emptied: the label still has to be readable.
    expect(r.focus?.title).toMatch(/^Mail\s+evilx+$/);
    expect(r.focus?.title).not.toContain("\n");
    expect(r.focus?.title).not.toContain("\u202E");
    expect(r.focus?.title.length).toBeLessThanOrEqual(200);
  });

  it("reports focus on the takeover batch, which is where the window matters most", async () => {
    const desk = new FakeDesk();
    desk.hint = { confirm: false, password: false, title: "Chromium" };
    const computer = new ComputerService(desk, new SeatService());
    const r = await computer.run("f2", [{ type: "request_takeover" }]);
    expect(r.seat).toBe("WAITING");
    expect(r.pending_checks).toEqual([]);
    expect(r.focus).toEqual({ title: "Chromium" });
  });

  it("survives a focus read the desk cannot do", async () => {
    const desk = new FakeDesk();
    desk.failFocus = true;
    const computer = new ComputerService(desk, new SeatService());
    const r = await computer.run("f3", [{ type: "click", x: asPixelX(1), y: asPixelY(1) }]);
    // The actions already ran, so throwing here would invite a retry that runs
    // them again. The documented cost is the checks that hang off the title.
    expect(r.results[0]?.kind).toBe("ok");
    expect(r.pending_checks).toEqual([]);
    expect(r.focus).toBeUndefined();
    expect(r.screenshot_b64).toBeTruthy();
  });
});
