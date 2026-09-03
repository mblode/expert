/**
 * Pure helpers behind the Channels → WhatsApp page: what the page sends the
 * hub, and what it shows for what the hub sends back. Nothing here touches
 * the DOM, so all of it is unit-tested.
 */

import type { WhatsAppAccount, WhatsAppConfig, WhatsAppGroup, WhatsAppLinkState } from "./seat";

/** One number today. The model stays a list so a second one is a UI change, not a rewrite. */
export const DEFAULT_ACCOUNT = "main";

export type LinkMethod = "code" | "qr";

/**
 * A phone cannot scan a QR shown on its own screen, so touch defaults to the
 * pairing code. A laptop has the phone to hand and its camera free.
 */
export function defaultLinkMethod(coarsePointer: boolean): LinkMethod {
  return coarsePointer ? "code" : "qr";
}

const PHONE_MIN_DIGITS = 7;
/** E.164 caps a number at fifteen digits. */
const PHONE_MAX_DIGITS = 15;

/**
 * The bridge wants digits only, no plus: `+61 412 345 678` becomes
 * `61412345678`. A leading `00` is the dial-out prefix, not the number. A
 * leading `0` after that is a local number with no country code, which
 * WhatsApp cannot resolve, so it is refused rather than guessed.
 */
export function normalisePhone(raw: string): string | null {
  let digits = raw.replaceAll(/\D/gu, "");
  if (digits.startsWith("00")) {
    digits = digits.slice(2);
  }
  if (
    digits.startsWith("0") ||
    digits.length < PHONE_MIN_DIGITS ||
    digits.length > PHONE_MAX_DIGITS
  ) {
    return null;
  }
  return digits;
}

/** WhatsApp shows its eight-character code as two groups of four; match it so the eye can compare. */
export function formatPairingCode(code: string): string {
  const clean = code.replaceAll(/[^0-9A-Za-z]/gu, "").toUpperCase();
  if (clean.length !== 8) {
    return code;
  }
  return `${clean.slice(0, 4)}-${clean.slice(4)}`;
}

/** Invite codes are ~22 characters; anything shorter is a typo, not a code. */
const INVITE_MIN_LENGTH = 8;

/**
 * `https://chat.whatsapp.com/<code>` or the bare code. The bridge accepts
 * the invite by its code, so the link is unwrapped here and a trailing slash
 * or surrounding whitespace from a paste is forgiven.
 */
export function inviteCode(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/u, "");
  const fromLink = /chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9_-]+)/u.exec(trimmed)?.[1];
  const code = fromLink ?? (/^[A-Za-z0-9_-]+$/u.test(trimmed) ? trimmed : null);
  return code && code.length >= INVITE_MIN_LENGTH ? code : null;
}

const USER_JID_SUFFIX = "@s.whatsapp.net";

/** A person's JID is their number plus a suffix. The page shows the number and keeps the suffix to itself. */
export function jidToPhone(jid: string | undefined): string {
  if (!jid) {
    return "";
  }
  return jid.endsWith(USER_JID_SUFFIX) ? `+${jid.slice(0, -USER_JID_SUFFIX.length)}` : jid;
}

/**
 * The reverse. Blank is "" (the field is being cleared), a typed JID passes
 * through untouched so a group or lid address can still be entered, and a
 * number that does not normalise is `null` so the form can say so.
 */
export function phoneToJid(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.includes("@")) {
    return trimmed;
  }
  const digits = normalisePhone(trimmed);
  return digits ? `${digits}${USER_JID_SUFFIX}` : null;
}

/** One entry per line or comma. Every entry becomes a JID; the ones that cannot are reported, not dropped. */
export function parseAllowlist(text: string): { jids: string[]; invalid: string[] } {
  const jids: string[] = [];
  const invalid: string[] = [];
  for (const entry of text.split(/[\n,]/u)) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    const jid = phoneToJid(trimmed);
    if (jid) {
      jids.push(jid);
    } else {
      invalid.push(trimmed);
    }
  }
  return { invalid, jids: [...new Set(jids)] };
}

function formatAllowlist(jids: readonly string[] | undefined): string {
  return (jids ?? []).map(jidToPhone).join("\n");
}

/**
 * The allowlist the config should hold after one switch flips. Under
 * `group_policy: "all"` the bridge serves every group and `allowed_groups`
 * is ignored, so the first flip off a wide-open account spells out every
 * other group rather than writing a list of one; the caller then writes
 * `group_policy: "listed"` beside it, and from there the list is explicit
 * (an empty list means none, not all).
 */
export function nextAllowedGroups(
  allowed: readonly string[],
  groups: readonly WhatsAppGroup[],
  jid: string,
  enabled: boolean,
  policy: "all" | "listed" = allowed.length > 0 ? "listed" : "all",
): string[] {
  const base =
    policy === "listed"
      ? [...allowed]
      : groups.filter((group) => group.enabled).map((group) => group.jid);
  const without = base.filter((entry) => entry !== jid);
  return enabled ? [...without, jid] : without;
}

/** After a config write the list is explicit, so membership is what "enabled" means. */
export function applyAllowedGroups(
  groups: readonly WhatsAppGroup[],
  allowed: readonly string[],
  policy: "all" | "listed" = "listed",
): WhatsAppGroup[] {
  return groups.map((group) => ({
    ...group,
    enabled: policy === "all" ? true : allowed.includes(group.jid),
  }));
}

/** The settings form's fields, in the shape a person types them. */
export interface SettingsDraft {
  botName: string;
  dmAllowlist: string;
  dmPolicy: WhatsAppConfig["dm_policy"];
  maintainer: string;
  triggerMode: WhatsAppConfig["trigger_mode"];
  triggerPrefix: string;
}

export function settingsDraft(config: WhatsAppConfig): SettingsDraft {
  return {
    botName: config.bot_name ?? "",
    dmAllowlist: formatAllowlist(config.dm_allowlist),
    dmPolicy: config.dm_policy,
    maintainer: jidToPhone(config.maintainer_jid),
    triggerMode: config.trigger_mode,
    triggerPrefix: config.trigger_prefix ?? "",
  };
}

/**
 * The draft folded back into the config, with everything the form does not
 * show carried through unchanged so a save never wipes a field it did not
 * own. A field that cannot be read back is an error, not a silent drop.
 */
export function applySettingsDraft(
  config: WhatsAppConfig,
  draft: SettingsDraft,
): { config: WhatsAppConfig } | { error: string } {
  const maintainer = phoneToJid(draft.maintainer);
  if (maintainer === null) {
    return { error: "Enter the full number for reports, with its country code." };
  }
  const prefix = draft.triggerPrefix.trim();
  if (draft.triggerMode === "prefix" && !prefix) {
    return { error: "Choose a prefix, or answer on mentions instead." };
  }
  const allowlist = parseAllowlist(draft.dmAllowlist);
  if (draft.dmPolicy === "allowlist" && allowlist.invalid.length > 0) {
    return { error: `These are not full numbers: ${allowlist.invalid.join(", ")}.` };
  }
  const name = draft.botName.trim();
  return {
    config: {
      ...config,
      bot_name: name || undefined,
      dm_allowlist: draft.dmPolicy === "allowlist" ? allowlist.jids : config.dm_allowlist,
      dm_policy: draft.dmPolicy,
      maintainer_jid: maintainer || undefined,
      trigger_mode: draft.triggerMode,
      trigger_prefix: draft.triggerMode === "prefix" ? prefix : config.trigger_prefix,
    },
  };
}

/**
 * What the page is showing, derived from the hub's status. `loading` is the
 * first paint, `down` is the bridge not running on the computer at all, and
 * the rest follow the account's status one to one, with `linking` carrying
 * whichever of the code or the QR the hub is holding right now.
 */
export type LinkView =
  | { kind: "loading" }
  | { kind: "down" }
  | { kind: "unlinked" }
  | {
      kind: "linking";
      method: LinkMethod;
      code: string | null;
      qr: string | null;
      phone: string | null;
    }
  | { kind: "linked"; phone: string | null }
  | { kind: "closed"; phone: string | null };

/** The events a caller dispatches into `reduceLink`. @public */
export type LinkEvent =
  | { type: "state"; state: WhatsAppLinkState; method?: LinkMethod }
  | { type: "accounts"; accounts: WhatsAppAccount[]; acct: string }
  | { type: "down" }
  | { type: "unlinked" };

export function reduceLink(view: LinkView, event: LinkEvent): LinkView {
  switch (event.type) {
    case "down": {
      return { kind: "down" };
    }
    case "unlinked": {
      return { kind: "unlinked" };
    }
    case "accounts": {
      const account = event.accounts.find((candidate) => candidate.acct === event.acct);
      if (!account) {
        return { kind: "unlinked" };
      }
      return fromState(view, {
        acct: account.acct,
        age_ms: null,
        pairing_code: null,
        phone: account.phone,
        qr: null,
        status: account.status,
      });
    }
    case "state": {
      return fromState(view, event.state, event.method);
    }
  }
}

function fromState(view: LinkView, state: WhatsAppLinkState, method?: LinkMethod): LinkView {
  switch (state.status) {
    case "unlinked": {
      return { kind: "unlinked" };
    }
    case "open": {
      return { kind: "linked", phone: state.phone };
    }
    case "closed": {
      return { kind: "closed", phone: state.phone };
    }
    case "linking": {
      return {
        code: state.pairing_code,
        kind: "linking",
        // The method is the page's choice, not the hub's: keep it across
        // polls, and after a reload infer it from what the hub is holding.
        method:
          method ??
          (view.kind === "linking"
            ? view.method
            : state.pairing_code || state.phone
              ? "code"
              : "qr"),
        phone: state.phone,
        qr: state.qr,
      };
    }
  }
}
