import { SeatMethods } from "@computer/proto";
import { ComputerError, DISPLAY, PRIMARY_DISPLAY, parseDisplay, type BoxStatus, type Button } from "@computer/shared";
import type { Bot, BotRegistry } from "../service/bots.ts";
import type { ProvisionService } from "../service/provision.ts";
import type { AuthRegistry } from "./auth.ts";
import { withPixelToken } from "../service/pixels.ts";
import type { ConnectRouter } from "./router.ts";
import { requireObject } from "./router.ts";

/** Same cap as the model's `type` action. */
const MAX_TYPE_CHARS = 4000;

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
    // Short-lived pixel token in the URL — not the durable seat token.
    // Seat token still opens /vnc (pairing / local-dev fallback).
    // Reuse a still-valid grant so Status polls do not rotate the iframe URL.
    const grant = deps.auth.pixels.grantFor(display);
    return withPixelToken(deps.vncUrl, grant);
  };

  const status = (display: number = PRIMARY_DISPLAY): BoxStatus => {
    const bot = deps.bots.byDisplay(display);
    return {
      state: bot.seat.getState(),
      vnc_url: vncUrlFor(display),
      display: DISPLAY,
      screens: deps.bots.all().map((b) => ({
        bot_id: b.id,
        display: b.display,
        state: b.seat.getState(),
        vnc_url: vncUrlFor(b.display),
      })),
    };
  };

  const botFor = (o: Record<string, unknown>): Bot => deps.bots.byDisplay(parseDisplay(o.display));

  router.rpc(SeatMethods.Pair, "pair", async ({ body }) => {
    const o = requireObject(body);
    const token = deps.auth.pair(String(o.code ?? ""));
    return { token, vnc_url: vncUrlFor(PRIMARY_DISPLAY), status: status() };
  });

  router.rpc(SeatMethods.Status, "seat", async (ctx) => {
    const o = requireObject(ctx.body);
    return status(parseDisplay(o.display));
  });

  router.rpc(SeatMethods.SetPresence, "seat", async (ctx) => {
    const o = requireObject(ctx.body);
    if (typeof o.present !== "boolean") throw new ComputerError("VALIDATION", "present must be boolean");
    const display = parseDisplay(o.display);
    deps.bots.byDisplay(display).seat.setPresence(o.present);
    return status(display);
  });

  // The trackpad. `move` is a delta (the human is looking at the stream, not
  // at screenshot coordinates), `click` is at the current pointer, `scroll` is
  // wheel notches at the current pointer. Shape is api/spec.json `$defs.pointer`.
  router.rpc(SeatMethods.Pointer, "seat", async (ctx) => {
    const o = requireObject(ctx.body);
    const bot = botFor(o);
    bot.seat.requireHumanContact();
    await bot.desk.ping();
    switch (o.type) {
      case "move": {
        const cursor = await bot.desk.pointerDelta(delta(o.dx, "dx"), delta(o.dy, "dy"), Boolean(o.grab));
        return { cursor, seat: bot.seat.getState() };
      }
      case "click": {
        const cursor = await bot.desk.pointerClick(parseButton(o.button));
        return { cursor, seat: bot.seat.getState() };
      }
      case "scroll": {
        const c = bot.desk.getCursor();
        await bot.desk.scroll(c.x, c.y, notches(o.dx, "dx"), notches(o.dy, "dy"));
        return { cursor: bot.desk.getCursor(), seat: bot.seat.getState() };
      }
      default:
        throw new ComputerError("VALIDATION", "pointer type must be move, click or scroll");
    }
  });

  router.rpc(SeatMethods.Type, "seat", async (ctx) => {
    const o = requireObject(ctx.body);
    const bot = botFor(o);
    bot.seat.requireHumanContact();
    await bot.desk.ping();
    if (typeof o.text !== "string" || o.text.length < 1 || o.text.length > MAX_TYPE_CHARS) {
      throw new ComputerError("VALIDATION", `text must be 1–${MAX_TYPE_CHARS} chars`);
    }
    await bot.desk.type(o.text);
    return { cursor: bot.desk.getCursor(), seat: bot.seat.getState() };
  });

  router.rpc(SeatMethods.ClipboardGet, "seat", async (ctx) => {
    const o = requireObject(ctx.body);
    const bot = botFor(o);
    bot.seat.requireHumanContact();
    await bot.desk.ping();
    return { text: await bot.desk.clipboardGet() };
  });

  router.rpc(SeatMethods.ClipboardSet, "seat", async (ctx) => {
    const o = requireObject(ctx.body);
    const bot = botFor(o);
    bot.seat.requireHumanContact();
    await bot.desk.ping();
    if (typeof o.text !== "string") throw new ComputerError("VALIDATION", "text is required");
    await bot.desk.clipboardSet(o.text);
    return { text: o.text };
  });

  // The thread. Read-only, and deliberately NOT gated on requireHumanContact:
  // reading what was said is not taking the seat.
  router.rpc(SeatMethods.Occurrences, "seat", async (ctx) => {
    const o = requireObject(ctx.body);
    const bot = botFor(o);
    const cursor = typeof o.cursor === "string" && o.cursor ? o.cursor : undefined;
    const limit = typeof o.limit === "number" ? o.limit : undefined;
    return bot.voice.page(cursor, limit);
  });

  // A masked value for an open secret_request. It goes to the clipboard and
  // nowhere else — not the log, not the response, not the model's context.
  // Nothing here may echo `value` back, including in an error message.
  router.rpc(SeatMethods.ProvideSecret, "seat", async (ctx) => {
    const o = requireObject(ctx.body);
    const bot = botFor(o);
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
    const o = requireObject(ctx.body);
    if (typeof o.id !== "string" || o.id.length === 0) {
      throw new ComputerError("VALIDATION", "id is required, e.g. {\"id\":\"night\"}");
    }
    const bot = await deps.provision.create(o.id);
    // The token appears exactly once, here.
    return { id: bot.id, display: bot.display, token: bot.token };
  });

  router.rpc(SeatMethods.DeleteBot, "seat", async (ctx) => {
    const o = requireObject(ctx.body);
    if (typeof o.id !== "string" || o.id.length === 0) {
      throw new ComputerError("VALIDATION", "id is required");
    }
    await deps.provision.remove(o.id);
    return status();
  });
}

/** A pointer delta in box pixels. */
function delta(v: unknown, name: string): number {
  if (v === undefined) return 0;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ComputerError("VALIDATION", `${name} must be a number`);
  }
  return Math.trunc(v);
}

const MAX_NOTCHES = 20;

/** Wheel notches, capped like the model's `scroll` so one call cannot spin the wheel forever. */
function notches(v: unknown, name: string): number {
  const n = delta(v, name);
  if (Math.abs(n) > MAX_NOTCHES) {
    throw new ComputerError("VALIDATION", `${name} must be in -${MAX_NOTCHES}..${MAX_NOTCHES}`);
  }
  return n;
}

function parseButton(v: unknown): Button {
  if (v === undefined || v === "left" || v === "right" || v === "middle" || v === "back" || v === "forward") {
    return (v as Button) ?? "left";
  }
  throw new ComputerError("VALIDATION", "button must be left|right|middle|back|forward");
}
