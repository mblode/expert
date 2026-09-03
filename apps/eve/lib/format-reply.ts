/**
 * Deterministic cleanup applied to every reply on the way out to WhatsApp.
 *
 * The model drifts toward two things a chat reads as wrong:
 *  1. Em and en dashes, which read as machine-written.
 *  2. Markdown emphasis (`**bold**`, `__bold__`, `## heading`). WhatsApp's bold
 *     is a *single* asterisk, so a Markdown `**Anthropic:**` renders as the
 *     literal text `*Anthropic:*` (WhatsApp eats the outer pair as bold and
 *     leaves the inner asterisks showing). Markdown emphasis is normalised to
 *     WhatsApp's single-asterisk bold so it renders cleanly.
 *
 * Triple-backtick blocks are held out of all of it: WhatsApp renders them as
 * monospace, which is what makes ASCII art and a pasted command land. The
 * exemption is real rather than incidental. Every rule below runs on prose
 * only, because a shell snippet is full of the characters they rewrite: a
 * `# comment` line came back out as `*comment*`, and a `**` inside a fence
 * collapsed to one asterisk, so the command a member copied out of the chat
 * was not the command that went in.
 *
 * Kept pure and standalone so it is unit-testable without booting the agent.
 */
const cleanProse = (text: string): string =>
  text
    // Markdown ATX headings (`## Title`) become a WhatsApp bold line, no leading #.
    .replaceAll(/^[ \t]{0,3}#{1,6}[ \t]+(?<heading>.+?)[ \t]*#*$/gmu, "*$<heading>*")
    // Markdown `__bold__` becomes WhatsApp bold. Single `_italic_` is valid in
    // both and is left untouched (the pattern needs two adjacent underscores).
    .replaceAll(/__(?<bold>\S(?:.*?\S)?)__/gu, "*$<bold>*")
    // Collapse any run of 2+ asterisks to one. Turns Markdown `**bold**` into
    // WhatsApp `*bold*`; already-correct single `*bold*` is untouched.
    .replaceAll(/\*{2,}/gu, "*")
    // Em or en dash used as punctuation becomes a comma. A spaced dash or a
    // dash hugging one side both count.
    .replaceAll(/ *[—–] +| +[—–] */gu, ", ")
    // A dash joining two words becomes a comma; a numeric range (4 to 5 with a
    // dash between the digits) is kept because that is real punctuation.
    .replaceAll(/(?<pre>[a-zA-Z])[—–](?<post>[a-zA-Z])/gu, "$<pre>, $<post>");

/**
 * A monospace fence and everything in it. Non-greedy so each pair closes at
 * its own terminator; an unclosed trailing fence falls through as prose,
 * which is also how WhatsApp renders it.
 */
const FENCED = /(?<fenced>```[\s\S]*?```)/u;

/**
 * Markdown to WhatsApp, prose only. `split` on a pattern with one capture
 * group puts the fences at the odd indices, so they are rejoined untouched.
 */
export const cleanReply = (text: string): string =>
  text
    .split(FENCED)
    .map((part, index) => (index % 2 === 1 ? part : cleanProse(part)))
    .join("")
    .trim();

/**
 * Env values that must never appear in a WhatsApp message. The model does not
 * hold these, but a tool result or a pasted URL can leak one. The length floor
 * stops a short or empty env from redacting ordinary words.
 */
const SECRET_ENV_KEYS = [
  "AI_GATEWAY_API_KEY",
  "BLOB_READ_WRITE_TOKEN",
  "COMPUTER_BOT_TOKEN",
  "COMPUTER_EVE_SECRET",
  "COMPUTER_SETUP_CODE",
  "FIRECRAWL_API_KEY",
  "WHATSAPP_BRIDGE_SECRET",
] as const;

const MIN_SECRET_CHARS = 8;

/** Query keys that are credentials, not a public link. */
const TOKEN_QUERY = new Set([
  "access_token",
  "api_key",
  "code",
  "credential",
  "key",
  "password",
  "pixel",
  "seat",
  "secret",
  "setup",
  "token",
]);

const stripTokenQuery = (raw: string): string => {
  try {
    const url = new URL(raw);
    const keep: [string, string][] = [];
    for (const [key, value] of url.searchParams) {
      if (!TOKEN_QUERY.has(key.toLowerCase())) {
        keep.push([key, value]);
      }
    }
    url.search = "";
    for (const [key, value] of keep) {
      url.searchParams.append(key, value);
    }
    url.hash = "";
    return url.toString();
  } catch {
    return raw;
  }
};

/**
 * Last line of defence on the WhatsApp outbound path: redact configured
 * secrets and credential query params. Never interpolates those values into
 * the result; it only removes them if they are already present.
 */
export const sanitizeOutbound = (text: string, env: NodeJS.ProcessEnv = process.env): string => {
  let out = text;
  for (const key of SECRET_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value && value.length >= MIN_SECRET_CHARS) {
      out = out.split(value).join("[redacted]");
    }
  }
  out = out.replaceAll(/https?:\/\/[^\s]+/gu, stripTokenQuery);
  return out;
};

/** Markdown cleanup then secret redaction. What the WhatsApp channel sends. */
export const outboundReply = (text: string): string => sanitizeOutbound(cleanReply(text));
