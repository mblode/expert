import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { ARCHIVE_FILE } from "./chat-archive-source.ts";
import { resetArchiveCache } from "./chat-archive.ts";
import type { ChatMessage } from "./chat-archive.ts";
import { GROUP_HISTORY_FILE, resetGroupHistoryCache } from "./group-history.ts";
import type { GroupHistory } from "./group-history.ts";
import { MEMBERS_FILE, resetPeopleCache } from "./data/people.ts";
import type { Member } from "./data/people.ts";

/**
 * A tenant's content, written to a throwaway data directory for one test.
 *
 * The real archive, roster and lore are files on the VCMC computer's volume
 * and nowhere in this repository (it is public; they name real people), so a
 * test that needs a community makes a small one. Every loader caches per
 * process, which is why this resets them on the way in and on the way out.
 */
interface TenantFixture {
  messages?: ChatMessage[];
  members?: Partial<Member>[];
  history?: GroupHistory;
}

/** The names the fixtures below share, so assertions read as one story. */
const FIXTURE_MEMBERS: Partial<Member>[] = [
  {
    aliases: ["Marcus"],
    name: "Marcus Schappi",
    org: "Ninja.ai",
    phone: "+61400000001",
    role: "Founder",
    tags: ["mcp"],
  },
  { aliases: ["Benji"], name: "Ben Simai", phone: "+61400000002", tags: [] },
  { name: "Scott Falkner", org: "OpenAI", phone: "+61400000003", tags: ["openai"] },
  { name: "John Croucher", phone: "+61400000004", tags: [] },
];

/** Two years of chat in eight lines: enough for ranks, filters and a search. */
const FIXTURE_MESSAGES: ChatMessage[] = [
  { r: [{ e: "🔥", n: 3 }], s: "Marcus Schappi", t: "1/3/2025", x: "claude code is elite" },
  { s: "Marcus Schappi", t: "2/3/2025", x: "claude just shipped opus" },
  { s: "Marcus Schappi", t: "3/3/2025", x: "mcp servers everywhere" },
  { s: "Marcus Schappi", t: "4/3/2025", x: "another claude take" },
  { r: [{ e: "😂", n: 1 }], s: "John Croucher", t: "5/3/2025", x: "claude beat codex today" },
  { s: "John Croucher", t: "6/3/2025", x: "meetup was great" },
  { s: "Geoff", t: "7/3/2025", x: "claude is fine I guess" },
  { s: "Scott Falkner", t: "8/3/2025", x: "codex ambassadors assemble" },
];

const FIXTURE_HISTORY: GroupHistory = {
  context: {
    openai: "OpenAI sponsors the meetups.",
    origin: "Started by a founder on 2025-03-19.",
  },
  timeline: [
    { date: "2025-03-19", people: ["Luca Bonelli"], summary: "The group starts." },
    { date: "2025-04-01", people: ["Ben Flint"], summary: "Ben Flint joins." },
    { date: "2025-05-01", summary: "First meetup at a Collingwood office." },
    { date: "2025-06-01", people: ["Ben Flint", "Marcus Schappi"], summary: "The MCP debate." },
  ],
};

/** Write the fixture and point every loader at it; call the result to undo. */
export function installTenantData(fixture: TenantFixture = {}): () => void {
  const dir = mkdtempSync(join(tmpdir(), "vibey-tenant-"));
  const messages = fixture.messages ?? FIXTURE_MESSAGES;
  const members = fixture.members ?? FIXTURE_MEMBERS;
  const history = fixture.history ?? FIXTURE_HISTORY;
  writeFileSync(
    join(dir, ARCHIVE_FILE),
    gzipSync(Buffer.from(JSON.stringify(messages))).toString("base64"),
  );
  writeFileSync(join(dir, MEMBERS_FILE), JSON.stringify(members));
  writeFileSync(join(dir, GROUP_HISTORY_FILE), JSON.stringify(history));
  const previous = process.env.COMPUTER_BOT_DATA;
  process.env.COMPUTER_BOT_DATA = dir;
  resetAll();
  return () => {
    if (previous === undefined) {
      delete process.env.COMPUTER_BOT_DATA;
    } else {
      process.env.COMPUTER_BOT_DATA = previous;
    }
    resetAll();
    rmSync(dir, { force: true, recursive: true });
  };
}

function resetAll(): void {
  resetArchiveCache();
  resetPeopleCache();
  resetGroupHistoryCache();
}
