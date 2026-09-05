/**
 * The first run: what it says, what it asks, and what an answer is allowed to
 * be.
 *
 * Three claims and one question. The claims are the marketing page's three
 * (`content.ts`) said again to someone who now has the computer rather than to
 * someone deciding whether to want one, which is why they are shorter here and
 * why none of them repeats the pitch. The question is the only part the flow
 * keeps, and it is kept because it changes what the first conversation offers
 * to do: an empty Chrome is the one thing a new computer is actually missing.
 *
 * No `use client` and no database import: the route validates with the same
 * `keepTools` the picker filters with, so the client cannot widen the answer
 * and the server does not need a second list to check it against.
 */

/** The art each step draws, chosen by the step rather than by its index. */
type OnboardingArt = "computer" | "handoff" | "meet" | "tools";

export const onboardingSteps = [
  {
    art: "meet",
    body: "Each one has its own screen on your computer. Ask in plain words and it gets on with it.",
    title: "Meet your Bots",
  },
  {
    art: "computer",
    body: "A real Chrome and a real terminal. At a password it stops and gives you the mouse.",
    title: "Working in its own computer, just like you",
  },
  {
    art: "handoff",
    body: "Ask now, or leave a routine running. It comes back when it is done or needs you.",
    title: "Hand off tasks, on demand or automated",
  },
  {
    art: "tools",
    body: "Its browser is signed into nothing yet. Pick a few and it offers to sign you in first.",
    title: "Which tools do you use every day?",
  },
] as const satisfies readonly { art: OnboardingArt; body: string; title: string }[];

/**
 * The tools worth asking about: ones a person signs into in a browser, because
 * signing in is the thing this step leads to.
 *
 * Names, not logos. A logo grid is the reference design's own answer and it is
 * a dozen trademarks shipped into `public/` to redraw whenever one is
 * restyled; a name in a tile costs nothing, reads at any size, and is honest
 * about the fact that nothing is connected yet.
 */
export const onboardingTools = [
  { id: "google", label: "Google" },
  { id: "microsoft", label: "Microsoft 365" },
  { id: "slack", label: "Slack" },
  { id: "notion", label: "Notion" },
  { id: "github", label: "GitHub" },
  { id: "linear", label: "Linear" },
  { id: "jira", label: "Jira" },
  { id: "figma", label: "Figma" },
  { id: "salesforce", label: "Salesforce" },
  { id: "hubspot", label: "HubSpot" },
  { id: "xero", label: "Xero" },
  { id: "canva", label: "Canva" },
] as const satisfies readonly { id: string; label: string }[];

const labels = new Map<string, string>(onboardingTools.map((tool) => [tool.id, tool.label]));

/**
 * The ids this build draws, in catalog order, without repeats.
 *
 * Unknown ids are dropped rather than refused: a row written by an older build
 * naming a tool this one no longer lists is not a bad request, it is an answer
 * with a stale entry, and the rest of it is still the person's answer. Order
 * comes from the catalog so the chips read the same on every device whatever
 * order they were tapped in.
 */
export function keepTools(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const asked = new Set(value.filter((entry): entry is string => typeof entry === "string"));
  return onboardingTools.filter((tool) => asked.has(tool.id)).map((tool) => tool.id);
}

/** What a kept id is called. Only ever called with one `keepTools` returned. */
export function toolLabel(id: string): string {
  return labels.get(id) ?? id;
}

/**
 * The first task a picked tool turns into.
 *
 * It names the seat on purpose. The one thing a person must know before a Bot
 * opens a login page is that the password is typed by them and not by it, and
 * the first message is where that is cheapest to learn.
 */
export function signInPrompt(id: string): string {
  return `Open ${toolLabel(id)} in your browser and tell me what you can see. If it wants a password or a code, ask me for the seat and I will type it.`;
}
