import { SeatMethods } from "@computer/proto";
import { ComputerError, DISPLAY, PRIMARY_DISPLAY, parseDisplay, type BoxStatus, type Button } from "@computer/shared";
import type { Bot, BotRegistry } from "../service/bots.ts";
import type { ProvisionService } from "../service/provision.ts";
import type { AuthRegistry } from "./auth.ts";
import { withSeatToken } from "./auth.ts";
import type { ConnectRouter, RpcContext } from "./router.ts";
import { requireObject } from "./router.ts";

export type SeatDeps = {
  auth: AuthRegistry;
  bots: BotRegistry;
  provision: ProvisionService;
  vncUrl: string;
};

/**
 * Seat RPCs take an additive `display` (window index). Absent = primary.
 * Any paired seat token may view/take any screen — one human, many Bots;
 * the seat FSM, not the token, is per screen.
 */
export function registerSeat(router: ConnectRouter, deps: SeatDeps): void {
  const vncUrlFor = (display: number): string => {
    if (display === PRIMARY_DISPLAY) return deps.vncUrl;
    const sep = deps.vncUrl.includes("?") ? "&" : "?";
    return `${deps.vncUrl}${sep}display=${display}`;
  };

  const status = (token: string, display: number = PRIMARY_DISPLAY): BoxStatus => {
    const bot = deps.bots.byDisplay(display);
    return {
      state: bot.seat.getState(),
      vnc_url: withSeatToken(vncUrlFor(display), token),
      display: DISPLAY,
      screens: deps.bots.all().map((b) => ({
        bot_id: b.id,
        display: b.display,
        state: b.seat.getState(),
        vnc_url: withSeatToken(vncUrlFor(b.display), token),
      })),
    };
  };

  const botFor = (ctx: RpcContext, o: Record<string, unknown>): Bot =>
    deps.bots.byDisplay(parseDisplay(o.display));

  router.rpc(SeatMethods.Pair, "pair", async ({ body }) => {
    const o = requireObject(body);
    const token = deps.auth.pair(String(o.code ?? ""));
    return { token, vnc_url: withSeatToken(vncUrlFor(PRIMARY_DISPLAY), token), status: status(token) };
  });

  router.rpc(SeatMethods.Session, "session", async (ctx) => {
    const token = await deps.auth.session(ctx.bearer ?? "");
    return { token, vnc_url: withSeatToken(vncUrlFor(PRIMARY_DISPLAY), token), status: status(token) };
  });

  router.rpc(SeatMethods.Status, "seat", async (ctx) => {
    requireSeatToken(ctx);
    const o = requireObject(ctx.body);
    return status(ctx.bearer!, parseDisplay(o.display));
  });

  router.rpc(SeatMethods.SetPresence, "seat", async (ctx) => {
    requireSeatToken(ctx);
    const o = requireObject(ctx.body);
    if (typeof o.present !== "boolean") throw new ComputerError("VALIDATION", "present must be boolean");
    const display = parseDisplay(o.display);
    deps.bots.byDisplay(display).seat.setPresence(o.present);
    return status(ctx.bearer!, display);
  });

  router.rpc(SeatMethods.Pointer, "seat", async (ctx) => {
    requireSeatToken(ctx);
    const o = requireObject(ctx.body);
    const bot = botFor(ctx, o);
    bot.seat.requireHumanContact();
    await bot.desk.ping();
    const type = o.type ?? (o.move ? "move" : o.click ? "click" : o.scroll ? "scroll" : undefined);
    if (type === "scroll") {
      const dx = Number(o.dx ?? 0);
      const dy = Number(o.dy ?? 0);
      const c = bot.desk.getCursor();
      await bot.desk.scroll(c.x, c.y, Math.trunc(dx), Math.trunc(dy));
      return { cursor: bot.desk.getCursor(), seat: bot.seat.getState() };
    }
    if (type === "move" || (o.dx !== undefined && type !== "click")) {
      const dx = Number(o.dx ?? (o.move as { dx?: number } | undefined)?.dx ?? 0);
      const dy = Number(o.dy ?? (o.move as { dy?: number } | undefined)?.dy ?? 0);
      const grab = Boolean(o.grab);
      const cursor = await bot.desk.pointerDelta(dx, dy, grab);
      return { cursor, seat: bot.seat.getState() };
    }
    if (type === "click" || o.button !== undefined || pointerBodyEmpty(o)) {
      const button = parseButton(o.button);
      const cursor = await bot.desk.pointerClick(button);
      return { cursor, seat: bot.seat.getState() };
    }
    throw new ComputerError("VALIDATION", "pointer must be move or click");
  });

  router.rpc(SeatMethods.Type, "seat", async (ctx) => {
    requireSeatToken(ctx);
    const o = requireObject(ctx.body);
    const bot = botFor(ctx, o);
    bot.seat.requireHumanContact();
    await bot.desk.ping();
    if (typeof o.text !== "string" || o.text.length < 1) {
      throw new ComputerError("VALIDATION", "text is required");
    }
    await bot.desk.type(o.text);
    return { cursor: bot.desk.getCursor(), seat: bot.seat.getState() };
  });

  router.rpc(SeatMethods.ClipboardGet, "seat", async (ctx) => {
    requireSeatToken(ctx);
    const o = requireObject(ctx.body);
    const bot = botFor(ctx, o);
    bot.seat.requireHumanContact();
    await bot.desk.ping();
    return { text: await bot.desk.clipboardGet() };
  });

  router.rpc(SeatMethods.ClipboardSet, "seat", async (ctx) => {
    requireSeatToken(ctx);
    const o = requireObject(ctx.body);
    const bot = botFor(ctx, o);
    bot.seat.requireHumanContact();
    await bot.desk.ping();
    if (typeof o.text !== "string") throw new ComputerError("VALIDATION", "text is required");
    await bot.desk.clipboardSet(o.text);
    return { text: o.text };
  });

  // The thread. Read-only, and deliberately NOT gated on requireHumanContact:
  // reading what was said is not taking the seat.
  router.rpc(SeatMethods.Occurrences, "seat", async (ctx) => {
    requireSeatToken(ctx);
    const o = requireObject(ctx.body);
    const bot = botFor(ctx, o);
    const cursor = typeof o.cursor === "string" && o.cursor ? o.cursor : undefined;
    const limit = typeof o.limit === "number" ? o.limit : undefined;
    return bot.voice.page(cursor, limit);
  });

  // A masked value for an open secret_request. It goes to the clipboard and
  // nowhere else — not the log, not the response, not the model's context.
  // Nothing here may echo `value` back, including in an error message.
  router.rpc(SeatMethods.ProvideSecret, "seat", async (ctx) => {
    requireSeatToken(ctx);
    const o = requireObject(ctx.body);
    const bot = botFor(ctx, o);
    await bot.desk.ping();
    if (typeof o.occurrence_id !== "string" || !o.occurrence_id) {
      throw new ComputerError("VALIDATION", "occurrence_id is required");
    }
    if (typeof o.value !== "string") throw new ComputerError("VALIDATION", "value is required");
    await bot.voice.provideSecret(o.occurrence_id, o.value);
    return { provided: true };
  });

  // Provisioning: a paired seat is the box owner.
  router.rpc(SeatMethods.CreateBot, "seat", async (ctx) => {
    requireSeatToken(ctx);
    const o = requireObject(ctx.body);
    if (typeof o.id !== "string" || o.id.length === 0) {
      throw new ComputerError("VALIDATION", "id is required, e.g. {\"id\":\"night\"}");
    }
    const bot = await deps.provision.create(o.id);
    // The token appears exactly once, here.
    return { id: bot.id, display: bot.display, token: bot.token };
  });

  router.rpc(SeatMethods.DeleteBot, "seat", async (ctx) => {
    requireSeatToken(ctx);
    const o = requireObject(ctx.body);
    if (typeof o.id !== "string" || o.id.length === 0) {
      throw new ComputerError("VALIDATION", "id is required");
    }
    await deps.provision.remove(o.id);
    return status(ctx.bearer!);
  });
}

/** `{}` and `{display: N}` alone both mean a plain left click. */
function pointerBodyEmpty(o: Record<string, unknown>): boolean {
  return Object.keys(o).every((k) => k === "display");
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
