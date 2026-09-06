import type { BotProfile, Screen, WorkConversation } from "./seat";

/**
 * The workspace's left column is a list of threads, not a list of screens.
 *
 * A Bot has one thread per route it speaks on: its own, the WhatsApp DM it
 * answers, the group it is tagged in. The roster used to be the list, with the
 * seat state as each row's subtitle, because the hub reported screens and seat
 * states and a message preview would have had to be invented. The hub reports
 * the tail of every conversation now, so the list can be what a person
 * actually has: their conversations, most recent first.
 *
 * Everything here is pure. What a row says is worth a test, and the component
 * that draws it is not the place to find out that a group of a hundred and
 * twenty two people renders as a bare JID.
 */

export interface ThreadRow {
  /** The conversation, or `bot:<id>` for a Bot the hub has no thread for yet. */
  key: string;
  conversationId?: string;
  botId: string;
  /** The screen to select when this row is opened, when its Bot has one. */
  display?: number;
  title: string;
  /** One line under the title: who spoke and what they said. */
  preview?: string;
  at?: number;
  /** The Bot's own thread, which is the only one this seat can speak into. */
  live: boolean;
}

const GROUP = /@g\.us$/u;

/** A WhatsApp group, where more than one person can be the one who spoke. */
export function isGroupThread(conversation: WorkConversation): boolean {
  const { route } = conversation;
  return route.kind === "whatsapp" && GROUP.test(route.jid ?? "");
}

/** The digits of a WhatsApp JID, as a phone number rather than a routing token. */
function phoneOf(jid: string): string {
  const digits = jid.split("@")[0]?.replaceAll(/\D/gu, "") ?? "";
  return digits ? `+${digits}` : jid;
}

/** What to call someone: the name WhatsApp gave us, else their number. */
function nameOf(p: { display_name?: string; ref?: string }): string {
  return p.display_name?.trim() || phoneOf(p.ref ?? "");
}

/**
 * What the row is called.
 *
 * A group has no name here. WhatsApp knows its subject and the bridge does not
 * send it, so naming the group after the people in it is the honest fallback
 * and is what WhatsApp itself does for a group nobody named. The list is who
 * has spoken rather than the full membership, so it never claims a count.
 */
export function threadTitle(
  conversation: WorkConversation,
  profiles: Record<string, BotProfile>,
): string {
  const { route } = conversation;
  const humans = conversation.participants?.filter((p) => p.kind === "human") ?? [];
  if (route.kind === "seat") {
    return profiles[conversation.bot]?.name || conversation.bot;
  }
  if (route.kind === "whatsapp") {
    const jid = route.jid ?? "";
    if (!GROUP.test(jid)) {
      return humans[0] ? nameOf(humans[0]) : phoneOf(jid);
    }
    const named = humans.map(nameOf).filter(Boolean);
    return named.length ? named.slice(0, 3).join(", ") : "WhatsApp group";
  }
  if (route.kind === "peer") {
    return profiles[route.bot ?? ""]?.name || route.bot || "Another bot";
  }
  return route.repo?.replace(/^https:\/\/github\.com\//u, "") || "Coding session";
}

/**
 * The row's second line, in the shape a chat list uses: the speaker's name,
 * then what they said.
 *
 * Named in a group and not in a DM, for the reason WhatsApp does the same: in
 * a DM there is only one person it could be, and the name would be noise on
 * every row. The Bot's own voice is never prefixed, because the Bot is what
 * the thread is with.
 */
export function threadPreview(conversation: WorkConversation): string | undefined {
  const { preview } = conversation;
  if (!preview) {
    return undefined;
  }
  const who = isGroupThread(conversation) ? speakerName(conversation, preview.author) : "";
  return who ? `${who}: ${preview.text}` : preview.text;
}

/**
 * Who said it, by the name the thread would use for them.
 *
 * Empty for the Bot's own voice, which is the caller's cue not to label it:
 * the Bot is what the thread is with, and a row that named it on every line
 * would be naming the obvious.
 */
export function speakerName(
  conversation: WorkConversation,
  author: { kind: string; ref?: string },
): string {
  if (author.kind !== "human" || !author.ref) {
    return "";
  }
  const participant = conversation.participants?.find(
    (p) => p.kind === "human" && p.ref === author.ref,
  );
  return participant ? nameOf(participant) : phoneOf(author.ref);
}

/**
 * Every thread on this computer, most recent first.
 *
 * A Bot with no thread yet still gets a row. Its conversation is created on
 * the first message, and a roster that showed a Bot until it was spoken to and
 * then again afterwards, with nothing in between, would be a list that loses
 * the Bot you just made. Those rows sort under the ones with a message,
 * because "nothing has happened here" is not recent.
 */
export function threadRows(
  conversations: WorkConversation[],
  screens: Screen[],
  profiles: Record<string, BotProfile>,
): ThreadRow[] {
  const displayOf = new Map(screens.map((s) => [s.bot_id, s.display]));
  const spokenFor = new Set<string>();
  const rows: ThreadRow[] = conversations.map((c) => {
    const live = c.route.kind === "seat";
    if (live) {
      spokenFor.add(c.bot);
    }
    return {
      at: c.preview?.at,
      botId: c.bot,
      conversationId: c.id,
      ...(displayOf.has(c.bot) ? { display: displayOf.get(c.bot) } : {}),
      key: c.id,
      live,
      preview: threadPreview(c),
      title: threadTitle(c, profiles),
    };
  });
  for (const screen of screens) {
    if (!spokenFor.has(screen.bot_id)) {
      rows.push({
        botId: screen.bot_id,
        display: screen.display,
        key: `bot:${screen.bot_id}`,
        live: true,
        title: profiles[screen.bot_id]?.name || screen.bot_id,
      });
    }
  }
  return rows.toSorted((a, b) => (b.at ?? 0) - (a.at ?? 0) || a.title.localeCompare(b.title));
}

/**
 * When, the way a chat list says it: the time today, the weekday this week,
 * the date before that. Absolute rather than "3 minutes ago" so a row does not
 * change while it is being read, and short enough not to push the title out.
 */
export function threadTime(at: number | undefined, now = Date.now()): string {
  if (!at) {
    return "";
  }
  const then = new Date(at);
  const days = Math.floor((startOfDay(now) - startOfDay(at)) / 86_400_000);
  if (days <= 0) {
    return then.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  if (days === 1) {
    return "Yesterday";
  }
  if (days < 7) {
    return then.toLocaleDateString(undefined, { weekday: "long" });
  }
  return then.toLocaleDateString();
}

function startOfDay(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
