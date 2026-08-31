import { SeatMethods } from "@computer/proto";
import { ComputerError, DISPLAY, type Button } from "@computer/shared";
import type { Desk } from "../desk/types.ts";
import type { SeatService } from "../service/seat.ts";
import type { AuthRegistry } from "./auth.ts";
import { withSeatToken } from "./auth.ts";
import type { ConnectRouter, RpcContext } from "./router.ts";
import { requireObject } from "./router.ts";

export type SeatDeps = {
  auth: AuthRegistry;
  seat: SeatService;
  desk: Desk;
  vncUrl: string;
};

export function registerSeat(router: ConnectRouter, deps: SeatDeps): void {
  const status = (token: string) => ({
    state: deps.seat.getState(),
    vnc_url: withSeatToken(deps.vncUrl, token),
    display: DISPLAY,
  });

  router.rpc(SeatMethods.Pair, "pair", async ({ body }) => {
    const o = requireObject(body);
    const token = deps.auth.pair(String(o.code ?? ""));
    return { token, vnc_url: withSeatToken(deps.vncUrl, token), status: status(token) };
  });

  router.rpc(SeatMethods.Status, "seat", async (ctx) => {
    requireSeatToken(ctx);
    return status(ctx.bearer!);
  });

  router.rpc(SeatMethods.SetPresence, "seat", async (ctx) => {
    requireSeatToken(ctx);
    const o = requireObject(ctx.body);
    if (typeof o.present !== "boolean") throw new ComputerError("VALIDATION", "present must be boolean");
    deps.seat.setPresence(o.present);
    return status(ctx.bearer!);
  });

  router.rpc(SeatMethods.Pointer, "seat", async (ctx) => {
    requireSeatToken(ctx);
    deps.seat.requireHumanContact();
    await deps.desk.ping();
    const o = requireObject(ctx.body);
    const type = o.type ?? (o.move ? "move" : o.click ? "click" : o.scroll ? "scroll" : undefined);
    if (type === "scroll") {
      const dx = Number(o.dx ?? 0);
      const dy = Number(o.dy ?? 0);
      const c = deps.desk.getCursor();
      await deps.desk.scroll(c.x, c.y, Math.trunc(dx), Math.trunc(dy));
      return { cursor: deps.desk.getCursor(), seat: deps.seat.getState() };
    }
    if (type === "move" || (o.dx !== undefined && type !== "click")) {
      const dx = Number(o.dx ?? (o.move as { dx?: number } | undefined)?.dx ?? 0);
      const dy = Number(o.dy ?? (o.move as { dy?: number } | undefined)?.dy ?? 0);
      const grab = Boolean(o.grab);
      const cursor = await deps.desk.pointerDelta(dx, dy, grab);
      return { cursor, seat: deps.seat.getState() };
    }
    if (type === "click" || o.button !== undefined || Object.keys(o).length === 0) {
      const button = parseButton(o.button);
      const cursor = await deps.desk.pointerClick(button);
      return { cursor, seat: deps.seat.getState() };
    }
    throw new ComputerError("VALIDATION", "pointer must be move or click");
  });

  router.rpc(SeatMethods.Type, "seat", async (ctx) => {
    requireSeatToken(ctx);
    deps.seat.requireHumanContact();
    await deps.desk.ping();
    const o = requireObject(ctx.body);
    if (typeof o.text !== "string" || o.text.length < 1) {
      throw new ComputerError("VALIDATION", "text is required");
    }
    await deps.desk.type(o.text);
    return { cursor: deps.desk.getCursor(), seat: deps.seat.getState() };
  });

  router.rpc(SeatMethods.ClipboardGet, "seat", async (ctx) => {
    requireSeatToken(ctx);
    deps.seat.requireHumanContact();
    await deps.desk.ping();
    return { text: await deps.desk.clipboardGet() };
  });

  router.rpc(SeatMethods.ClipboardSet, "seat", async (ctx) => {
    requireSeatToken(ctx);
    deps.seat.requireHumanContact();
    await deps.desk.ping();
    const o = requireObject(ctx.body);
    if (typeof o.text !== "string") throw new ComputerError("VALIDATION", "text is required");
    await deps.desk.clipboardSet(o.text);
    return { text: o.text };
  });
}

function requireSeatToken(ctx: RpcContext): void {
  if (ctx.kind !== "seat") {
    throw new ComputerError("UNAUTHENTICATED", "seat token required");
  }
}

function parseButton(v: unknown): Button {
  if (v === undefined || v === "left" || v === "right" || v === "middle" || v === "back" || v === "forward") {
    return (v as Button) ?? "left";
  }
  throw new ComputerError("VALIDATION", "button must be left|right|middle|back|forward");
}
