import { SeatMethods } from "@computer/proto";
import { ComputerError } from "@computer/shared";
import type { BotRegistry } from "../service/bots.ts";
import type { ChannelRegistry } from "../service/channels.ts";
import type { BridgeClient, WhatsAppAccountConfig } from "../service/whatsapp.ts";
import type { ConnectRouter, RpcContext } from "./router.ts";
import { requireObject } from "./router.ts";

export interface WhatsAppDeps {
  bots: BotRegistry;
  channels: ChannelRegistry;
  /** Absent = no bridge on this computer; every call is DAEMON_DOWN. */
  bridge?: BridgeClient;
}

const ACCT_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const PHONE_RE = /^[0-9]{6,15}$/;
/** The one Eve route a WhatsApp door may reach. */
const WHATSAPP_EVE_PATHS = ["/eve/v1/whatsapp/message"];

/**
 * Linking a number is an owner's job: it hands a phone number's identity to
 * this computer and decides which groups a Bot listens in. A guest seat took
 * the mouse for a few minutes and gets none of this.
 */
function requireOwner(ctx: RpcContext): void {
  if (ctx.seat?.kind !== "owner") {
    throw new ComputerError("UNAUTHENTICATED", "an owner seat is required");
  }
}

function requireBridge(deps: WhatsAppDeps): BridgeClient {
  if (!deps.bridge) {
    throw new ComputerError("DAEMON_DOWN", "WhatsApp is not running on this computer yet");
  }
  return deps.bridge;
}

function parseAcct(o: Record<string, unknown>): string {
  const acct = typeof o.acct === "string" ? o.acct.trim() : "";
  if (!ACCT_RE.test(acct)) {
    throw new ComputerError("VALIDATION", "acct must be 1-32 chars of a-z 0-9 -");
  }
  return acct;
}

/** Digits only, no plus: what `requestPairingCode` takes. */
export function normalisePhone(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === "") {
    return undefined;
  }
  if (typeof raw !== "string") {
    throw new ComputerError("VALIDATION", "phone must be a string");
  }
  const digits = raw.replaceAll(/[^0-9]/g, "");
  if (!PHONE_RE.test(digits)) {
    throw new ComputerError("VALIDATION", "phone must be 6-15 digits in international format");
  }
  return digits;
}

/** The channel record a WhatsApp account posts through. One per account. */
export function channelIdFor(acct: string): string {
  return `whatsapp-${acct}`;
}

export function registerWhatsApp(router: ConnectRouter, deps: WhatsAppDeps): void {
  router.rpc(SeatMethods.WhatsAppAccounts, "seat", async (ctx) => {
    requireOwner(ctx);
    return requireBridge(deps).accounts();
  });

  router.rpc(SeatMethods.WhatsAppLink, "seat", async (ctx) => {
    requireOwner(ctx);
    const o = requireObject(ctx.body);
    // Validate before reaching for the bridge: a bad request is the caller's
    // problem even on a computer with no WhatsApp yet.
    const acct = parseAcct(o);
    const bridge = requireBridge(deps);
    switch (o.action) {
      case "status": {
        return bridge.linkState(acct);
      }
      case "unlink": {
        await bridge.removeAccount(acct);
        // The door closes with the number: a secret with no account behind
        // it would otherwise keep authenticating a bridge that lost its state.
        deps.channels.remove(channelIdFor(acct));
        return {
          acct,
          age_ms: null,
          pairing_code: null,
          phone: null,
          qr: null,
          status: "unlinked",
        };
      }
      case "start": {
        const phone = normalisePhone(o.phone);
        const { accounts } = await bridge.accounts();
        if (!accounts.some((a) => a.acct === acct)) {
          const botId = typeof o.bot === "string" && o.bot ? o.bot : deps.bots.primary().id;
          // Validates the Bot exists before anything is minted.
          const bot = deps.bots.byId(botId);
          const id = channelIdFor(acct);
          // A record left from a bridge that lost its accounts file is
          // rotated rather than reused: the bridge needs a secret it can
          // hold, and the old one is nowhere it can read.
          const record = deps.channels.byId(id)
            ? deps.channels.rotate(id)
            : deps.channels.add({ bot: bot.id, id, kind: "whatsapp", paths: WHATSAPP_EVE_PATHS });
          await bridge.createAccount({
            acct,
            bot: bot.id,
            channel_id: record.id,
            channel_secret: record.secret,
            phone,
          });
        }
        return bridge.link(acct, phone);
      }
      default: {
        throw new ComputerError("VALIDATION", "action must be start, status or unlink");
      }
    }
  });

  router.rpc(SeatMethods.WhatsAppGroups, "seat", async (ctx) => {
    requireOwner(ctx);
    const o = requireObject(ctx.body);
    return requireBridge(deps).groups(parseAcct(o));
  });

  router.rpc(SeatMethods.WhatsAppJoinGroup, "seat", async (ctx) => {
    requireOwner(ctx);
    const o = requireObject(ctx.body);
    const acct = parseAcct(o);
    const invite = typeof o.invite === "string" ? o.invite.trim() : "";
    if (!invite) {
      throw new ComputerError("VALIDATION", "invite is required");
    }
    return requireBridge(deps).joinGroup(acct, invite);
  });

  router.rpc(SeatMethods.WhatsAppConfig, "seat", async (ctx) => {
    requireOwner(ctx);
    const o = requireObject(ctx.body);
    const acct = parseAcct(o);
    const bridge = requireBridge(deps);
    if (o.config === undefined) {
      return bridge.getConfig(acct);
    }
    if (!o.config || typeof o.config !== "object" || Array.isArray(o.config)) {
      throw new ComputerError("VALIDATION", "config must be an object");
    }
    return bridge.putConfig(acct, o.config as WhatsAppAccountConfig);
  });
}
