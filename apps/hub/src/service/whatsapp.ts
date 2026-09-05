import { ComputerError } from "@computer/shared";

/**
 * The hub's view of the WhatsApp bridge it supervises on this Machine
 * (`apps/whatsapp-bridge`, loopback, `x-bridge-secret`). hello.expert never
 * talks to the bridge; it talks to the hub, which owns the account's connector
 * record and secret, and forwards the linking, groups and config calls here.
 *
 * A bridge that is not running is `DAEMON_DOWN`, the same word the rest of
 * the hub uses for a box it cannot reach, so the web page shows one plain
 * state instead of a stack of fetch errors.
 */
type WhatsAppStatus = "unlinked" | "linking" | "open" | "closed";

interface WhatsAppAccount {
  acct: string;
  bot: string;
  connector_id: string;
  phone: string | null;
  status: WhatsAppStatus;
}

interface WhatsAppLinkState {
  acct: string;
  status: WhatsAppStatus;
  qr: string | null;
  pairing_code: string | null;
  age_ms: number | null;
  phone: string | null;
}

interface WhatsAppGroup {
  jid: string;
  subject: string;
  size: number;
  enabled: boolean;
}

export interface WhatsAppAccountConfig {
  allowed_groups?: string[];
  trigger_mode?: "mention" | "prefix" | "all";
  trigger_prefix?: string;
  dm_policy?: "members" | "allowlist" | "anyone";
  dm_allowlist?: string[];
  image_sends_per_day?: number;
  vision_enabled?: boolean;
  maintainer_jid?: string;
  owner_jids?: string[];
  digest_recipient_jids?: string[];
  bot_name?: string;
}

interface BridgeClientOptions {
  url: string;
  secret: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export const DEFAULT_BRIDGE_URL = "http://127.0.0.1:2100";
const BRIDGE_SECRET_HEADER = "x-bridge-secret";

export class BridgeClient {
  private readonly base: string;
  private readonly secret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: BridgeClientOptions) {
    this.base = opts.url.replace(/\/$/, "");
    this.secret = opts.secret;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  accounts(): Promise<{ accounts: WhatsAppAccount[] }> {
    return this.call("GET", "/accounts");
  }

  createAccount(body: {
    acct: string;
    bot: string;
    connector_id: string;
    connector_secret: string;
    phone?: string;
  }): Promise<{ acct: string }> {
    return this.call("POST", "/accounts", body);
  }

  removeAccount(acct: string): Promise<unknown> {
    return this.call("DELETE", `/accounts/${encodeURIComponent(acct)}`);
  }

  link(acct: string, phone?: string): Promise<WhatsAppLinkState> {
    return this.call("POST", `/accounts/${encodeURIComponent(acct)}/link`, phone ? { phone } : {});
  }

  linkState(acct: string): Promise<WhatsAppLinkState> {
    return this.call("GET", `/accounts/${encodeURIComponent(acct)}/link`);
  }

  groups(acct: string): Promise<{ groups: WhatsAppGroup[] }> {
    return this.call("GET", `/accounts/${encodeURIComponent(acct)}/groups`);
  }

  joinGroup(acct: string, invite: string): Promise<{ jid: string }> {
    return this.call("POST", `/accounts/${encodeURIComponent(acct)}/groups/join`, { invite });
  }

  getConfig(acct: string): Promise<{ config: WhatsAppAccountConfig }> {
    return this.call("GET", `/accounts/${encodeURIComponent(acct)}/config`);
  }

  putConfig(
    acct: string,
    config: WhatsAppAccountConfig,
  ): Promise<{ config: WhatsAppAccountConfig }> {
    return this.call("PUT", `/accounts/${encodeURIComponent(acct)}/config`, { config });
  }

  send(
    acct: string,
    jid: string,
    text: string,
    idempotencyKey: string,
  ): Promise<{ sent: boolean }> {
    return this.call("POST", `/send?acct=${encodeURIComponent(acct)}`, {
      jid,
      text,
      idempotencyKey,
    });
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: {
          [BRIDGE_SECRET_HEADER]: this.secret,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        method,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new ComputerError("DAEMON_DOWN", "WhatsApp is not running on this computer yet");
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON: the status line is the whole diagnosis.
    }
    if (!res.ok) {
      const message =
        (json as { error?: string | { message?: string } } | null)?.error ?? text.slice(0, 200);
      const detail = typeof message === "string" ? message : (message?.message ?? "bridge error");
      if (res.status === 404) {
        throw new ComputerError("VALIDATION", detail || "no such WhatsApp account");
      }
      if (res.status === 409) {
        throw new ComputerError("CONFLICT", detail);
      }
      if (res.status === 401 || res.status === 503) {
        // Our own secret is wrong or the bridge has none: a box problem, not the caller's.
        throw new ComputerError("DAEMON_DOWN", `the WhatsApp bridge refused the hub: ${detail}`);
      }
      throw new ComputerError("VALIDATION", detail);
    }
    return json as T;
  }
}
