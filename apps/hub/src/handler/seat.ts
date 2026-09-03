import { SeatMethods } from "@computer/proto";
import { ComputerError, DISPLAY, PRIMARY_DISPLAY, parseDisplay } from "@computer/shared";
import type { BoxStatus, Button } from "@computer/shared";
import type { Bot, BotRegistry } from "../service/bots.ts";
import type { ConversationRegistry } from "../service/conversations.ts";
import type { ProvisionService } from "../service/provision.ts";
import { asRole } from "../service/principals.ts";
import type { PrincipalRecord } from "../service/principals.ts";
import type { AuthRegistry } from "./auth.ts";
import { withPixelToken } from "../service/pixels.ts";
import type { ConnectRouter, RpcContext } from "./router.ts";
import { requireObject } from "./router.ts";

/** Same cap as the model's `type` action. */
const MAX_TYPE_CHARS = 4000;

export interface SeatDeps {
  auth: AuthRegistry;
  bots: BotRegistry;
  conversations: ConversationRegistry;
  provision: ProvisionService;
  vncUrl: string;
}

/**
 * Seat RPCs take an additive `display` (window index). Absent = primary.
 * Any paired seat token may view/take any screen: one human, many Bots;
 * the seat FSM, not the token, is per screen.
 */
export function registerSeat(router: ConnectRouter, deps: SeatDeps): void {
  const vncUrlFor = (display: number): string => {
    // Short-lived pixel token in the URL, not the durable seat token.
    // Seat token still opens /vnc (pairing / local-dev fallback).
    // Reuse a still-valid grant so Status polls do not rotate the iframe URL.
    const grant = deps.auth.pixels.grantFor(display);
    return withPixelToken(deps.vncUrl, grant);
  };

  // A seat bound to one screen sees only that screen: the screen list carries
  // pixel grants, and a grant for another display would be a way around the
  // bind. Binding is the record's own `display`, not its role, so an operator
  // issued for one screen is contained the same way a guest is.
  const status = (display: number = PRIMARY_DISPLAY, seat?: PrincipalRecord): BoxStatus => {
    const bot = deps.bots.byDisplay(display);
    const visible =
      seat?.display === undefined
        ? deps.bots.all()
        : deps.bots.all().filter((b) => b.display === display);
    return {
      display: DISPLAY,
      screens: visible.map((b) => ({
        bot_id: b.id,
        display: b.display,
        state: b.seat.getState(),
        vnc_url: vncUrlFor(b.display),
      })),
      state: bot.seat.getState(),
      vnc_url: vncUrlFor(display),
    };
  };

  /**
   * The display a call is about. A seat minted for one screen resolves an
   * absent `display` to that screen, not the primary, so a phone that omits
   * the field still lands where its invite pointed; naming any other screen
   * is refused before the desk is touched.
   */
  const displayFor = (o: Record<string, unknown>, seat: PrincipalRecord | undefined): number => {
    if (seat?.display !== undefined) {
      if (o.display === undefined) {
        return seat.display;
      }
      const asked = parseDisplay(o.display);
      if (asked !== seat.display) {
        throw new ComputerError("UNAUTHENTICATED", `this seat is for screen ${seat.display}`);
      }
      return asked;
    }
    return parseDisplay(o.display);
  };

  const botFor = (o: Record<string, unknown>, ctx: RpcContext): Bot =>
    deps.bots.byDisplay(displayFor(o, ctx.principal));

  router.rpc(SeatMethods.Pair, "pair", async ({ body }) => {
    const o = requireObject(body);
    const token = deps.auth.pair(String(o.code ?? ""));
    return { status: status(), token, vnc_url: vncUrlFor(PRIMARY_DISPLAY) };
  });

  router.rpc(SeatMethods.Status, "seat", async (ctx) => {
    const o = requireObject(ctx.body);
    return status(displayFor(o, ctx.principal), ctx.principal);
  });

  router.rpc(SeatMethods.SetPresence, "seat", async (ctx) => {
    const o = requireObject(ctx.body);
    if (typeof o.present !== "boolean") {
      throw new ComputerError("VALIDATION", "present must be boolean");
    }
    const display = displayFor(o, ctx.principal);
    deps.bots.byDisplay(display).seat.setPresence(o.present);
    return status(display, ctx.principal);
  });

  // Sign-out, or an owner pulling a guest's invite early. Revoking the
  // caller's own token needs no argument; naming another token is an
  // owner's call, since a guest must not be able to unpair the phone.
  router.rpc(SeatMethods.Revoke, "seat", async (ctx) => {
    const o = requireObject(ctx.body);
    const own = ctx.bearer ?? "";
    const target = typeof o.token === "string" && o.token ? o.token : own;
    if (target !== own && ctx.principal?.role !== "owner") {
      throw new ComputerError("UNAUTHENTICATED", "only an owner seat may revoke another seat");
    }
    return { revoked: deps.auth.revoke(target) };
  });

  /**
   * Hand a named person a seat. This is how a control plane stops being the
   * box's owner: it pairs once, keeps an `issuer`, and calls this with the
   * user it just authenticated. The role containment lives in the registry,
   * which is the only place that can see who is asking.
   */
  router.rpc(SeatMethods.Issue, "seat", async (ctx) => {
    const o = requireObject(ctx.body);
    const by = ctx.principal;
    if (!by) {
      throw new ComputerError("UNAUTHENTICATED", "seat token required");
    }
    const ttlSec = o.ttl_sec === undefined ? undefined : Number(o.ttl_sec);
    if (ttlSec !== undefined && (!Number.isFinite(ttlSec) || ttlSec < 0)) {
      throw new ComputerError("VALIDATION", "ttl_sec must be a non-negative number");
    }
    const issued = deps.auth.issue(
      {
        display: o.display === undefined || o.display === 0 ? undefined : parseDisplay(o.display),
        label: typeof o.label === "string" ? o.label : undefined,
        methods: Array.isArray(o.methods)
          ? o.methods.filter((m): m is string => typeof m === "string")
          : undefined,
        role: asRole(o.role),
        subject: typeof o.subject === "string" && o.subject ? o.subject : undefined,
        // 0 means "no expiry"; only an owner may ask for it, which `issue`
        // enforces by refusing a privileged role to an issuer anyway.
        ttlMs: ttlSec === undefined || ttlSec === 0 ? undefined : ttlSec * 1000,
      },
      by,
    );
    return {
      expires_at: issued.expires_at ?? "",
      role: issued.role,
      subject: issued.subject ?? "",
      token: issued.token,
    };
  });

  // The trackpad. `move` is a delta (the human is looking at the stream, not
  // at screenshot coordinates), `click` is at the current pointer, `scroll` is
  // wheel notches at the current pointer. Shape is api/spec.json `$defs.pointer`.
  router.rpc(SeatMethods.Pointer, "seat", async (ctx) => {
    const o = requireObject(ctx.body);
    const bot = botFor(o, ctx);
    bot.seat.requireHumanContact();
    await bot.desk.ping();
    switch (o.type) {
      case "move": {
        const cursor = await bot.desk.pointerDelta(
          delta(o.dx, "dx"),
          delta(o.dy, "dy"),
          Boolean(o.grab),
        );
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
      default: {
        throw new ComputerError("VALIDATION", "pointer type must be move, click or scroll");
      }
    }
  });

  router.rpc(SeatMethods.Type, "seat", async (ctx) => {
    const o = requireObject(ctx.body);
    const bot = botFor(o, ctx);
    bot.seat.requireHumanContact();
    await bot.desk.ping();
    if (typeof o.text !== "string" || o.text.length < 1 || o.text.length > MAX_TYPE_CHARS) {
      throw new ComputerError("VALIDATION", `text must be 1-${MAX_TYPE_CHARS} chars`);
    }
    await bot.desk.type(o.text);
    return { cursor: bot.desk.getCursor(), seat: bot.seat.getState() };
  });

  router.rpc(SeatMethods.ClipboardGet, "seat", async (ctx) => {
    const o = requireObject(ctx.body);
    const bot = botFor(o, ctx);
    bot.seat.requireHumanContact();
    await bot.desk.ping();
    return { text: await bot.desk.clipboardGet() };
  });

  router.rpc(SeatMethods.ClipboardSet, "seat", async (ctx) => {
    const o = requireObject(ctx.body);
    const bot = botFor(o, ctx);
    bot.seat.requireHumanContact();
    await bot.desk.ping();
    if (typeof o.text !== "string") {
      throw new ComputerError("VALIDATION", "text is required");
    }
    await bot.desk.clipboardSet(o.text);
    return { text: o.text };
  });

  // The thread. Read-only, and deliberately NOT gated on requireHumanContact:
  // reading what was said is not taking the seat.
  //
  // `conversation_id` is additive: absent is the display's Bot thread, which
  // is what every caller does today. Naming one is the same read through the
  // conversation store, and it is still contained by the screen the seat was
  // minted for: a conversation belongs to a Bot, a Bot is on a screen, and a
  // seat bound to one screen must not read another one's thread by id.
  router.rpc(SeatMethods.Occurrences, "seat", async (ctx) => {
    const o = requireObject(ctx.body);
    const cursor = typeof o.cursor === "string" && o.cursor ? o.cursor : undefined;
    const limit = typeof o.limit === "number" ? o.limit : undefined;
    if (typeof o.conversation_id === "string" && o.conversation_id) {
      const conversation = deps.conversations.byId(o.conversation_id);
      const owner = deps.bots.byId(conversation.bot);
      if (ctx.principal?.display !== undefined && ctx.principal.display !== owner.display) {
        throw new ComputerError(
          "UNAUTHENTICATED",
          `this seat is for screen ${ctx.principal.display}`,
        );
      }
      return deps.conversations.page(conversation.id, cursor, limit);
    }
    return botFor(o, ctx).voice.page(cursor, limit);
  });

  // A masked value for an open secret_request. It goes to the clipboard and
  // nowhere else, not the log, not the response, not the model's context.
  // Nothing here may echo `value` back, including in an error message.
  router.rpc(SeatMethods.ProvideSecret, "seat", async (ctx) => {
    const o = requireObject(ctx.body);
    const bot = botFor(o, ctx);
    await bot.desk.ping();
    if (typeof o.occurrence_id !== "string" || !o.occurrence_id) {
      throw new ComputerError("VALIDATION", "occurrence_id is required");
    }
    if (typeof o.value !== "string") {
      throw new ComputerError("VALIDATION", "value is required");
    }
    await bot.voice.provideSecret(o.occurrence_id, o.value);
    return { provided: true };
  });

  // Provisioning: a paired seat is the box owner.
  router.rpc(SeatMethods.CreateBot, "seat", async (ctx) => {
    const o = requireObject(ctx.body);
    if (typeof o.id !== "string" || o.id.length === 0) {
      throw new ComputerError("VALIDATION", 'id is required, e.g. {"id":"night"}');
    }
    const bot = await deps.provision.create(o.id);
    // The token appears exactly once, here.
    return { display: bot.display, id: bot.id, token: bot.token };
  });

  router.rpc(SeatMethods.DeleteBot, "seat", async (ctx) => {
    const o = requireObject(ctx.body);
    if (typeof o.id !== "string" || o.id.length === 0) {
      throw new ComputerError("VALIDATION", "id is required");
    }
    await deps.provision.remove(o.id);
    return status(PRIMARY_DISPLAY, ctx.principal);
  });
}

/** A pointer delta in box pixels. */
function delta(v: unknown, name: string): number {
  if (v === undefined) {
    return 0;
  }
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
  if (
    v === undefined ||
    v === "left" ||
    v === "right" ||
    v === "middle" ||
    v === "back" ||
    v === "forward"
  ) {
    return (v as Button) ?? "left";
  }
  throw new ComputerError("VALIDATION", "button must be left|right|middle|back|forward");
}
