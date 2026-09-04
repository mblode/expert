/**
 * The id the computer uses forever, from the name a person typed once.
 *
 * Lower case, ascii, dashes. It is a directory name under `/workspace/.bots`,
 * a row in the roster, and the `x-computer-bot` header on every request to
 * that Bot, so it is the one part of a Bot that cannot be renamed: the sheet
 * shows it while you type for that reason.
 *
 * A name that leaves nothing behind (emoji, punctuation, a language this
 * cannot transliterate) yields an empty id, and the caller refuses to create
 * rather than inventing one: a Bot called `bot-4` that the person did not
 * choose is worse than being asked for a different name.
 */
export function botIdFrom(name: string): string {
  return name
    .normalize("NFKD")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 32);
}
