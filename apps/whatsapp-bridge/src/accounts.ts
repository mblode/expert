import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * accounts.json: the one file that maps each linked WhatsApp number to a Bot.
 *
 * ```
 * { "version": 1, "accounts": [ { "acct": "main", "bot": "main", "phone": "614…" | null,
 *   "channel_id": "whatsapp", "channel_secret": "…", "config": { … } } ] }
 * ```
 *
 * It lives in the state dir next to the Baileys auth directories and carries
 * the channel secrets, so it is hub-owned: 0700 on the directory, 0600 on the
 * file, and the model must never read it (the hub's `read_file` refuses the
 * state dir). Every field the Railway deployment used to take as env is the
 * `config` object here, with a validated default for each, so a tenant can
 * change the allowlist or the trigger from the hello.expert page and the
 * bridge applies it live.
 */

/** Per-account settings. Every field has a default; `parseAccountConfig` fills them. */
export interface AccountConfig {
  /** `all` serves every group the number is in; `listed` serves only `allowed_groups`. */
  group_policy: "all" | "listed";
  /** Group JIDs the Bot serves under `listed`; ignored under `all`. */
  allowed_groups: string[];
  /** When a group message triggers a reply. */
  trigger_mode: "mention" | "prefix" | "all";
  trigger_prefix: string;
  /**
   * Who gets a DM reply: `members` = live participants of an allowed group
   * (fails open until the live set is seeded), `allowlist` = `dm_allowlist`
   * only, `anyone` = every DM.
   */
  dm_policy: "members" | "allowlist" | "anyone";
  /** Phones (any format) or full JIDs, used by the `allowlist` policy. */
  dm_allowlist: string[];
  /** Per-chat daily cap on media items (POST /send-media and envelope media). */
  image_sends_per_day: number;
  /**
   * Per-chat daily cap on outbound envelopes of any verb, media included, so a
   * reaction loop or a runaway tool cannot write into a chat all day.
   */
  sends_per_day: number;
  /** Download shared images and forward them so the Bot can see them. */
  vision_enabled: boolean;
  /** Where /report and /invite DMs land. Empty = accepted but not delivered. */
  maintainer_jid: string;
  /** Identities allowed to RECEIVE a proactive POST /send. */
  owner_jids: string[];
  /** Extra POST /send recipients (the daily digest), kept apart from owners. */
  digest_recipient_jids: string[];
  /** Labels the Bot's own transcript rows and is the textual @name in DMs. */
  bot_name: string;
  /** Optional JSON file of `Member` rows merged onto the live roster. Empty = none. */
  members_overlay_file: string;
}

/** One linked number. `phone` is digits only, no `+`, or null before linking. */
export interface AccountRecord {
  acct: string;
  bot: string;
  phone: string | null;
  /** Hub channel id; inbound goes to `/channels/<channel_id>/message`. */
  channel_id: string;
  channel_secret: string;
  config: AccountConfig;
}

export interface AccountsFile {
  version: 1;
  accounts: AccountRecord[];
}

/**
 * The link contract's states, the ones the hub's `WhatsAppStatus` and the
 * Channels page know. Never a raw Baileys connection state (`close`,
 * `connecting`): the page has no branch for those and rendered nothing while
 * a linked number was reconnecting.
 */
export type LinkStatus = "unlinked" | "linking" | "open" | "closed";

/** What GET /accounts returns: everything but the secret. */
export interface AccountSummary {
  acct: string;
  bot: string;
  phone: string | null;
  channel_id: string;
  status: LinkStatus;
  display_name?: string;
}

export const ACCT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/u;
export const DEFAULT_CHANNEL_ID = "whatsapp";

const TRIGGER_MODES = new Set(["mention", "prefix", "all"]);
const GROUP_POLICIES = new Set(["all", "listed"]);
const DM_POLICIES = new Set(["members", "allowlist", "anyone"]);

export const defaultAccountConfig = (): AccountConfig => ({
  allowed_groups: [],
  bot_name: "Vibey",
  digest_recipient_jids: [],
  dm_allowlist: [],
  dm_policy: "members",
  group_policy: "all",
  image_sends_per_day: 20,
  maintainer_jid: "",
  members_overlay_file: "",
  owner_jids: [],
  sends_per_day: 200,
  trigger_mode: "mention",
  trigger_prefix: "!bot",
  vision_enabled: true,
});

/** Trimmed non-empty strings from an array; anything else is a validation error. */
const stringList = (value: unknown, field: string): string[] => {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new TypeError(`${field} must be an array of strings`);
  }
  return value.map((v) => v.trim()).filter(Boolean);
};

/** A trimmed string; null and undefined read as empty (unset). */
const optionalString = (value: unknown, field: string): string => {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value !== "string") {
    throw new TypeError(`${field} must be a string`);
  }
  return value.trim();
};

/**
 * Validate a config object from the file or from PUT /accounts/:acct/config.
 * Unknown keys are dropped rather than refused so a newer page can talk to an
 * older bridge; a wrong type on a known key throws with the field name, which
 * the route turns into a 400. Every omitted field takes its default.
 */
export const parseAccountConfig = (raw: unknown): AccountConfig => {
  if (raw === undefined || raw === null) {
    return defaultAccountConfig();
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("config must be an object");
  }
  const o = raw as Record<string, unknown>;
  const def = defaultAccountConfig();
  const trigger_mode = o.trigger_mode ?? def.trigger_mode;
  if (typeof trigger_mode !== "string" || !TRIGGER_MODES.has(trigger_mode)) {
    throw new Error("trigger_mode must be one of mention, prefix, all");
  }
  const group_policy = o.group_policy ?? def.group_policy;
  if (typeof group_policy !== "string" || !GROUP_POLICIES.has(group_policy)) {
    throw new Error("group_policy must be one of all, listed");
  }
  const dm_policy = o.dm_policy ?? def.dm_policy;
  if (typeof dm_policy !== "string" || !DM_POLICIES.has(dm_policy)) {
    throw new Error("dm_policy must be one of members, allowlist, anyone");
  }
  const image_sends_per_day = o.image_sends_per_day ?? def.image_sends_per_day;
  if (
    typeof image_sends_per_day !== "number" ||
    !Number.isInteger(image_sends_per_day) ||
    image_sends_per_day < 0
  ) {
    throw new Error("image_sends_per_day must be a non-negative integer");
  }
  const sends_per_day = o.sends_per_day ?? def.sends_per_day;
  if (typeof sends_per_day !== "number" || !Number.isInteger(sends_per_day) || sends_per_day < 0) {
    throw new Error("sends_per_day must be a non-negative integer");
  }
  const vision_enabled = o.vision_enabled ?? def.vision_enabled;
  if (typeof vision_enabled !== "boolean") {
    throw new TypeError("vision_enabled must be a boolean");
  }
  const trigger_prefix = o.trigger_prefix ?? def.trigger_prefix;
  if (typeof trigger_prefix !== "string" || !trigger_prefix.trim()) {
    throw new Error("trigger_prefix must be a non-empty string");
  }
  const bot_name = o.bot_name ?? def.bot_name;
  if (typeof bot_name !== "string" || !bot_name.trim()) {
    throw new Error("bot_name must be a non-empty string");
  }
  return {
    allowed_groups: stringList(o.allowed_groups, "allowed_groups"),
    bot_name: bot_name.trim(),
    digest_recipient_jids: stringList(o.digest_recipient_jids, "digest_recipient_jids"),
    dm_allowlist: stringList(o.dm_allowlist, "dm_allowlist"),
    dm_policy: dm_policy as AccountConfig["dm_policy"],
    group_policy: group_policy as AccountConfig["group_policy"],
    image_sends_per_day,
    maintainer_jid: optionalString(o.maintainer_jid, "maintainer_jid"),
    members_overlay_file: optionalString(o.members_overlay_file, "members_overlay_file"),
    owner_jids: stringList(o.owner_jids, "owner_jids"),
    sends_per_day,
    trigger_mode: trigger_mode as AccountConfig["trigger_mode"],
    trigger_prefix: trigger_prefix.trim(),
    vision_enabled,
  };
};

/** Digits only, or null. A `+` or spaces from a form are tolerated; letters are not. */
export const parsePhone = (value: unknown): string | null => {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    throw new TypeError("phone must be a string of digits");
  }
  const digits = value.replaceAll(/[\s+()-]/gu, "");
  if (!/^\d{6,20}$/u.test(digits)) {
    throw new Error("phone must be digits in international format, no +");
  }
  return digits;
};

/** Validate one account entry (from the file or POST /accounts). */
export const parseAccountRecord = (raw: unknown): AccountRecord => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("account must be an object");
  }
  const o = raw as Record<string, unknown>;
  const acct = typeof o.acct === "string" ? o.acct.trim() : "";
  if (!ACCT_ID_RE.test(acct)) {
    throw new Error("acct must match ^[a-z0-9][a-z0-9-]{0,31}$");
  }
  const bot = typeof o.bot === "string" ? o.bot.trim() : "";
  if (!bot) {
    throw new Error("bot is required");
  }
  const channel_secret = typeof o.channel_secret === "string" ? o.channel_secret.trim() : "";
  if (!channel_secret) {
    throw new Error("channel_secret is required");
  }
  const channel_id =
    o.channel_id === undefined || o.channel_id === null
      ? DEFAULT_CHANNEL_ID
      : typeof o.channel_id === "string"
        ? o.channel_id.trim()
        : "";
  // A path segment on the hub: keep it to what a URL can carry unencoded.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(channel_id)) {
    throw new Error("channel_id must be a short URL-safe id");
  }
  return {
    acct,
    bot,
    channel_id,
    channel_secret,
    config: parseAccountConfig(o.config),
    phone: parsePhone(o.phone),
  };
};

/** Parse the whole file; an empty or missing file is a valid empty registry. */
export const parseAccountsFile = (raw: unknown): AccountsFile => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("accounts.json must be an object");
  }
  const o = raw as Record<string, unknown>;
  if (o.version !== 1) {
    throw new Error("accounts.json version must be 1");
  }
  const list = o.accounts ?? [];
  if (!Array.isArray(list)) {
    throw new TypeError("accounts must be an array");
  }
  const seen = new Set<string>();
  const accounts = list.map((entry) => {
    const record = parseAccountRecord(entry);
    if (seen.has(record.acct)) {
      throw new Error(`duplicate account id ${record.acct}`);
    }
    seen.add(record.acct);
    return record;
  });
  return { accounts, version: 1 };
};

/** Where the file lives under the state dir. */
export const accountsPath = (stateDir: string): string => path.join(stateDir, "accounts.json");

/** Where one account's Baileys creds and signal keys live. */
export const authDir = (stateDir: string, acct: string): string =>
  path.join(stateDir, acct, "auth");

/**
 * Read accounts.json. A missing file is an empty registry so first boot works
 * with nothing seeded; a malformed one throws, because silently starting with
 * no accounts would drop every linked number's messages without a trace.
 */
export const loadAccountsFile = async (stateDir: string): Promise<AccountsFile> => {
  let text: string;
  try {
    text = await readFile(accountsPath(stateDir), "utf-8");
  } catch (error) {
    if ((error as { code?: string })?.code === "ENOENT") {
      return { accounts: [], version: 1 };
    }
    throw error;
  }
  return parseAccountsFile(JSON.parse(text));
};

/**
 * Write accounts.json atomically (temp + rename) at 0600 inside a 0700 dir.
 * The modes are the whole point of the state dir: the model can run `shell`
 * as the box user, and a readable channel secret there would let it forge
 * inbound messages to its own Bot.
 */
export const saveAccountsFile = async (stateDir: string, file: AccountsFile): Promise<void> => {
  await mkdir(stateDir, { mode: 0o700, recursive: true });
  // mkdir's mode only applies when it creates the directory; enforce it on an
  // existing one too so a dir made by hand at 0755 does not stay that way.
  await chmod(stateDir, 0o700);
  const target = accountsPath(stateDir);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, target);
};

/** In-memory registry over accounts.json; every mutation persists before it returns. */
export interface AccountsRegistry {
  list: () => AccountRecord[];
  get: (acct: string) => AccountRecord | undefined;
  /** Throws when the id is taken; the route maps that to 409. */
  add: (record: AccountRecord) => Promise<AccountRecord>;
  remove: (acct: string) => Promise<boolean>;
  setConfig: (acct: string, config: AccountConfig) => Promise<AccountRecord>;
  setPhone: (acct: string, phone: string | null) => Promise<AccountRecord>;
}

export const createAccountsRegistry = (
  stateDir: string,
  initial: AccountsFile,
): AccountsRegistry => {
  const accounts = new Map<string, AccountRecord>(initial.accounts.map((a) => [a.acct, a]));
  // Serialise writes so two PUTs cannot interleave their temp files.
  let tail: Promise<unknown> = Promise.resolve();
  const persist = (): Promise<void> => {
    const next = tail.then(() =>
      saveAccountsFile(stateDir, { accounts: [...accounts.values()], version: 1 }),
    );
    tail = next.catch(() => undefined);
    return next;
  };
  const mustGet = (acct: string): AccountRecord => {
    const record = accounts.get(acct);
    if (!record) {
      throw new Error(`unknown account ${acct}`);
    }
    return record;
  };
  return {
    async add(record) {
      if (accounts.has(record.acct)) {
        throw new Error(`account ${record.acct} already exists`);
      }
      accounts.set(record.acct, record);
      await persist();
      return record;
    },
    get: (acct) => accounts.get(acct),
    list: () => [...accounts.values()],
    async remove(acct) {
      const existed = accounts.delete(acct);
      if (existed) {
        await persist();
      }
      return existed;
    },
    async setConfig(acct, config) {
      const next = { ...mustGet(acct), config };
      accounts.set(acct, next);
      await persist();
      return next;
    },
    async setPhone(acct, phone) {
      const next = { ...mustGet(acct), phone };
      accounts.set(acct, next);
      await persist();
      return next;
    },
  };
};
