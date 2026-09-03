// oxlint-disable no-import-node-test, prefer-importing-vitest-globals -- run via node's built-in test runner (tsx --test), not vitest
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  ACCT_ID_RE,
  accountsPath,
  authDir,
  createAccountsRegistry,
  defaultAccountConfig,
  loadAccountsFile,
  parseAccountConfig,
  parseAccountRecord,
  parseAccountsFile,
  parsePhone,
  saveAccountsFile,
} from "./accounts.ts";

// The page renders this form; every field must come back populated, never {}.
test("parseAccountConfig fills every default from an empty object", () => {
  assert.deepEqual(parseAccountConfig({}), defaultAccountConfig());
  assert.deepEqual(parseAccountConfig(undefined), defaultAccountConfig());
  assert.deepEqual(parseAccountConfig({ maintainer_jid: null, members_overlay_file: null }), {
    ...defaultAccountConfig(),
    maintainer_jid: "",
    members_overlay_file: "",
  });
  assert.deepEqual(Object.keys(defaultAccountConfig()).toSorted(), [
    "allowed_groups",
    "bot_name",
    "digest_recipient_jids",
    "dm_allowlist",
    "dm_policy",
    "group_policy",
    "image_sends_per_day",
    "maintainer_jid",
    "members_overlay_file",
    "owner_jids",
    "sends_per_day",
    "trigger_mode",
    "trigger_prefix",
    "vision_enabled",
  ]);
});

test("parseAccountConfig keeps known fields, trims lists, drops unknown keys", () => {
  const config = parseAccountConfig({
    allowed_groups: [" 123@g.us ", "", "456@g.us"],
    bot_name: " Ada ",
    dm_policy: "allowlist",
    dm_allowlist: ["+61400000000"],
    group_policy: "listed",
    image_sends_per_day: 3,
    maintainer_jid: "61400000000@s.whatsapp.net",
    not_a_field: true,
    trigger_mode: "prefix",
    trigger_prefix: "!ada",
    vision_enabled: false,
  });
  assert.deepEqual(config, {
    ...defaultAccountConfig(),
    allowed_groups: ["123@g.us", "456@g.us"],
    bot_name: "Ada",
    dm_allowlist: ["+61400000000"],
    dm_policy: "allowlist",
    group_policy: "listed",
    image_sends_per_day: 3,
    maintainer_jid: "61400000000@s.whatsapp.net",
    trigger_mode: "prefix",
    trigger_prefix: "!ada",
    vision_enabled: false,
  });
  assert.equal("not_a_field" in config, false);
});

// A wrong type must be a 400 with the field named, never a silent default:
// the page is editing this live and needs to know which field it got wrong.
test("parseAccountConfig refuses a wrong type and names the field", () => {
  assert.throws(() => parseAccountConfig({ trigger_mode: "shout" }), /trigger_mode/u);
  assert.throws(() => parseAccountConfig({ group_policy: "some" }), /group_policy/u);
  assert.throws(() => parseAccountConfig({ maintainer_jid: 5 }), /maintainer_jid/u);
  assert.throws(() => parseAccountConfig({ dm_policy: "nobody" }), /dm_policy/u);
  assert.throws(() => parseAccountConfig({ allowed_groups: "123@g.us" }), /allowed_groups/u);
  assert.throws(() => parseAccountConfig({ image_sends_per_day: -1 }), /image_sends_per_day/u);
  assert.throws(() => parseAccountConfig({ image_sends_per_day: "20" }), /image_sends_per_day/u);
  assert.throws(() => parseAccountConfig({ vision_enabled: "yes" }), /vision_enabled/u);
  assert.throws(() => parseAccountConfig({ bot_name: "  " }), /bot_name/u);
  assert.throws(() => parseAccountConfig([]), /object/u);
});

test("parsePhone accepts digits with form punctuation and refuses letters", () => {
  assert.equal(parsePhone("+61 400 000 000"), "61400000000");
  assert.equal(parsePhone("61400000000"), "61400000000");
  assert.equal(parsePhone(null), null);
  assert.equal(parsePhone(""), null);
  assert.throws(() => parsePhone("not a phone"), /digits/u);
  assert.throws(() => parsePhone(61_400_000_000), /digits/u);
});

test("ACCT_ID_RE is lowercase, dash-friendly, and at most 32 chars", () => {
  assert.equal(ACCT_ID_RE.test("main"), true);
  assert.equal(ACCT_ID_RE.test("vibey-2"), true);
  assert.equal(ACCT_ID_RE.test("-lead"), false);
  assert.equal(ACCT_ID_RE.test("Main"), false);
  assert.equal(ACCT_ID_RE.test("a".repeat(33)), false);
  assert.equal(ACCT_ID_RE.test(""), false);
});

test("parseAccountRecord defaults connector_id and config, and requires the secret", () => {
  const record = parseAccountRecord({ acct: "main", bot: "main", connector_secret: "s" });
  assert.equal(record.connector_id, "whatsapp");
  assert.equal(record.phone, null);
  assert.deepEqual(record.config, defaultAccountConfig());
  assert.throws(() => parseAccountRecord({ acct: "main", bot: "main" }), /connector_secret/u);
  assert.throws(
    () => parseAccountRecord({ acct: "Bad Id", bot: "main", connector_secret: "s" }),
    /acct/u,
  );
  assert.throws(() => parseAccountRecord({ acct: "main", connector_secret: "s" }), /bot/u);
  assert.throws(
    () =>
      parseAccountRecord({ acct: "main", bot: "main", connector_id: "a/b", connector_secret: "s" }),
    /connector_id/u,
  );
});

test("parseAccountRecord keeps a hub-issued connector_id", () => {
  const record = parseAccountRecord({
    acct: "main",
    bot: "main",
    connector_id: "whatsapp-main",
    connector_secret: "s",
    phone: "+61 400 000 000",
  });
  assert.equal(record.connector_id, "whatsapp-main");
  assert.equal(record.phone, "61400000000");
});

// The migration, from the file's side: both deployed volumes hold an
// accounts.json written under the pre-rename names, and a throw here is a
// bridge that will not start, which is every linked number down.
test("parseAccountRecord reads the pre-rename channel_id and channel_secret", () => {
  const record = parseAccountRecord({
    acct: "main",
    bot: "main",
    channel_id: "whatsapp-main",
    channel_secret: "old",
  });
  assert.equal(record.connector_id, "whatsapp-main");
  assert.equal(record.connector_secret, "old");
  // A rewrite emits only the new names, so the file migrates on first write.
  assert.equal(Object.hasOwn(record, "channel_id"), false);
  assert.equal(Object.hasOwn(record, "channel_secret"), false);
  // The new spelling wins when a file somehow carries both.
  const both = parseAccountRecord({
    acct: "main",
    bot: "main",
    channel_secret: "old",
    connector_secret: "new",
  });
  assert.equal(both.connector_secret, "new");
});

test("parseAccountsFile refuses duplicates and the wrong version", () => {
  const one = { acct: "main", bot: "main", connector_secret: "s" };
  assert.throws(() => parseAccountsFile({ accounts: [one, one], version: 1 }), /duplicate/u);
  assert.throws(() => parseAccountsFile({ accounts: [one], version: 2 }), /version/u);
  assert.equal(parseAccountsFile({ version: 1 }).accounts.length, 0);
});

test("authDir and accountsPath live under the state dir", () => {
  assert.equal(authDir("/state", "main"), path.join("/state", "main", "auth"));
  assert.equal(accountsPath("/state"), path.join("/state", "accounts.json"));
});

/** Permission bits of a path (the low nine bits of st_mode). */
const modeOf = async (target: string): Promise<number> => {
  const info = await stat(target);
  return info.mode % 0o1000;
};

/** The accounts currently on disk under `dir`. */
const savedAccounts = async (dir: string) => {
  const file = await loadAccountsFile(dir);
  return file.accounts;
};

test("a missing accounts.json is an empty registry", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "wa-accounts-"));
  assert.deepEqual(await loadAccountsFile(path.join(dir, "nope")), { accounts: [], version: 1 });
});

// The state dir holds connector secrets and Baileys creds. Whatever the umask,
// the file must come out unreadable to the box user the model runs as.
test("saveAccountsFile writes 0600 inside a 0700 dir and round-trips", async () => {
  const dir = path.join(await mkdtemp(path.join(tmpdir(), "wa-accounts-")), "state");
  const record = parseAccountRecord({
    acct: "main",
    bot: "main",
    connector_secret: "top-secret",
    config: { allowed_groups: ["1@g.us"] },
  });
  await saveAccountsFile(dir, { accounts: [record], version: 1 });
  assert.equal(await modeOf(dir), 0o700);
  assert.equal(await modeOf(accountsPath(dir)), 0o600);
  assert.deepEqual(await savedAccounts(dir), [record]);
  // The file is the JSON the page and the hub will read by hand; keep it pretty.
  assert.match(await readFile(accountsPath(dir), "utf-8"), /\n {2}"accounts"/u);
});

test("the registry persists every mutation and refuses a duplicate id", async () => {
  const dir = path.join(await mkdtemp(path.join(tmpdir(), "wa-accounts-")), "state");
  const registry = createAccountsRegistry(dir, { accounts: [], version: 1 });
  const record = parseAccountRecord({ acct: "main", bot: "main", connector_secret: "s" });
  await registry.add(record);
  await assert.rejects(() => registry.add(record), /already exists/u);
  const afterAdd = await savedAccounts(dir);
  assert.equal(afterAdd.length, 1);

  const updated = await registry.setConfig("main", { ...record.config, trigger_mode: "all" });
  assert.equal(updated.config.trigger_mode, "all");
  const afterConfig = await savedAccounts(dir);
  assert.equal(afterConfig[0]?.config.trigger_mode, "all");

  await registry.setPhone("main", "61400000000");
  const afterPhone = await savedAccounts(dir);
  assert.equal(afterPhone[0]?.phone, "61400000000");

  assert.equal(await registry.remove("main"), true);
  assert.equal(await registry.remove("main"), false);
  assert.deepEqual(await savedAccounts(dir), []);
});
