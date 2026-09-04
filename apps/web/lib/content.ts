/**
 * The marketing page's words, in one file so the claims can be read together.
 *
 * Three rules they are written to. Say what the product does rather than what
 * it is made of: a visitor does not buy Eve, a hub or a Fly Machine, they buy
 * a computer that keeps working and a screen they can take. Claim nothing that
 * is not live, because the nearest competitors are free desktop apps that wrap
 * agents on your own machine, and the one thing they cannot do is hand a
 * stranger a real browser for half an hour. And lead with the team rather than
 * the agent, which is the change since the roster shipped: eight Bots on one
 * computer is what a person actually gets, and the singular "an agent" was
 * copy written before there were eight of them.
 *
 * The framing follows the category leader's (x.ai/bot: a team of always-on
 * agents with a computer of their own that work inside your tools). What it
 * does not follow is the half of that page this build cannot honour. There is
 * no teach-a-task here, Bots cannot message each other yet, and nobody is
 * quoted who did not say it, so none of those appear below.
 */

import type { AvatarColor, AvatarShape } from "./seat";

/**
 * The four beats of the scrolled "How it works" section, in order. A tuple
 * rather than a plain array: the section reads them by index, and `as const`
 * is what keeps that indexing typed under noUncheckedIndexedAccess.
 */
export const howItWorks = [
  {
    body: "An email code, no password and nothing to install. The computer is already awake, with your Bots on it.",
    step: "01",
    title: "Sign in",
  },
  {
    body: "Say what you want in plain words. A Bot drives a real Chrome and a real terminal while you watch its screen.",
    step: "02",
    title: "Hand off the work",
  },
  {
    body: "At a password or a captcha it stops and hands you the mouse. Tap I’m done and it carries on from there.",
    step: "03",
    title: "Take the seat",
  },
  {
    body: "Close the laptop and the work continues. Routines fire on their own, and /workspace survives the restart.",
    step: "04",
    title: "It keeps going",
  },
] as const;

export const whatYouGet = [
  {
    description:
      "One Linux machine per account, with Chrome, a terminal, and files that survive a restart. The Bots share it the way a team shares an office.",
    title: "A computer of their own",
  },
  {
    description:
      "Eight Bots arrive with it, each with a lane it owns and a short list of things it will not do. Make more when you need them.",
    title: "A team, not a chatbot",
  },
  {
    description:
      "No API and no connector to wire up first. A Bot opens the site in its own browser and the work lands where you would have put it yourself.",
    title: "It works inside your tools",
  },
  {
    description:
      "A morning brief, a twice-daily smoke test, a weekly scan. They fire on their schedule whether or not anything of yours is open.",
    title: "Routines while you sleep",
  },
  {
    description:
      "The screen is live and view-only until you take it. Then the mouse, keyboard and clipboard are yours, and the Bot waits.",
    title: "A seat you can take",
  },
  {
    description:
      "Send someone a link and it opens the screen on their phone for half an hour, then dies. They never sign in.",
    title: "A link you can hand over",
  },
];

/**
 * Who arrives with the computer, in the order a person meets them: the desk
 * first, then front of house, then the specialists.
 *
 * Every line here is that Bot's own `agent/profile.json` and the "Owns" column
 * of `docs/BOTS.md`, shortened. The marks are the real ones too, so a Bot on
 * this page is the same mark in the sidebar a minute later, and a Bot that is
 * renamed or recoloured has to be renamed here as well. The two palettes are
 * the type of this list rather than a comment asking nicely: a colour that is
 * not one `BotMark` draws fails the build instead of silently falling back to
 * the hashed default on the one page a stranger sees first.
 */
export const roster: {
  color: AvatarColor;
  name: string;
  owns: string;
  shape: AvatarShape;
  title: string;
}[] = [
  {
    color: "#0091ff",
    name: "Main",
    owns: "The desk itself: the screen, the files and the terminal. The Bot you reach first.",
    shape: "circle",
    title: "Desk agent",
  },
  {
    color: "#9159fe",
    name: "Chief of Staff",
    owns: "Calendar, mail drafts, the weekday morning brief, and routing work to the right specialist. Never sends.",
    shape: "blob",
    title: "Front of house",
  },
  {
    color: "#00c972",
    name: "Software Engineer",
    owns: "Builds and lands code, and reviews the architecture for the smallest system that is correct. One PR per run.",
    shape: "tablet",
    title: "Engineer",
  },
  {
    color: "#ff6700",
    name: "QA",
    owns: "Incidents, CI failures, browser QA, and reproduce-and-fix. Draft bugfix PRs only, and it never skips a test.",
    shape: "wedge",
    title: "QA and bug fixer",
  },
  {
    color: "#000000",
    name: "Designer",
    owns: "Product, UI and brand design, and obsessive reduction. Designs only: the engineer implements them.",
    shape: "blob",
    title: "Product, UI and brand",
  },
  {
    color: "#1084fe",
    name: "PM",
    owns: "Conversion drop-offs, ranked opportunities, and A/B tests. One experiment in flight at a time.",
    shape: "blob",
    title: "Self-driving CRO",
  },
  {
    color: "#777777",
    name: "GTM",
    owns: "Campaigns, listings, founder emails and sequence copy. Nothing goes out live until you say go.",
    shape: "tablet",
    title: "Outbound operator",
  },
  {
    color: "#777777",
    name: "SEO",
    owns: "Demand research, writer briefs and Search Console. It briefs the article rather than writing it.",
    shape: "squircle",
    title: "Search and answer engines",
  },
];

/**
 * The four doors, each described in the direction it actually points.
 *
 * Worth being exact about, because two of them are easy to state backwards.
 * The CLI does not get its own credential: a person signs in here and their
 * coding agent drives that seat (`skills/expert/SKILL.md`). MCP points
 * outward, at servers the computer calls; nothing here serves the computer as
 * MCP tools to somebody else's agent, so this says "it can use" rather than
 * "you can drive it with".
 */
export const surfaces = [
  {
    description:
      "hello.expert on a laptop or a phone: the roster, the conversation, the live screen, and the seat when you want it.",
    title: "The web",
  },
  {
    description:
      "Message a Bot like you would a person. When it needs hands it sends back a link that opens the screen on your phone.",
    title: "WhatsApp",
  },
  {
    description:
      "Add the skill and Claude Code, Codex, OpenCode or Cursor drive the same computer you do, through the same seat.",
    title: "Your CLI",
  },
  {
    description:
      "Connect an MCP server and the Bots use those tools beside their own browser and terminal.",
    title: "MCP",
  },
];

export const faqs = [
  {
    answer:
      "One Linux computer that stays on, and a team of Bots that drive it. You watch any of their screens and take the mouse whenever you want.",
    question: "What is this?",
  },
  {
    answer: "Open hello.expert and sign in with an email code. The computer is already waiting.",
    question: "How do I start?",
  },
  {
    answer:
      "Eight, each with its own screen, its own thread and its own lane. You can make more, and tell a new one what it is for in the first message.",
    question: "How many Bots do I get?",
  },
  {
    answer:
      "Front of house routes a job to the specialist that owns it and tells you where it went. They cannot message each other directly yet.",
    question: "Do the Bots work together?",
  },
  {
    answer:
      "It opens the site in its own Chrome and works it the way you would. Sign-ins are the one part it hands back to you.",
    question: "Does it need an API for my tools?",
  },
  {
    answer:
      "Yes. Take the seat and the mouse, keyboard and clipboard are yours; the Bot's next move waits until you hand it back.",
    question: "Can I drive it myself?",
  },
  {
    answer:
      "You do. It asks for the seat, or for a masked code that goes straight to the computer's clipboard and never reaches the model.",
    question: "Who types the passwords and 2FA codes?",
  },
  {
    answer:
      "Yes. A link opens one screen for a set time and then expires, and it can paste but never read what the computer copied.",
    question: "Can I hand the screen to someone else?",
  },
  {
    answer: "/workspace and the browser profiles survive restarts. Installed packages do not.",
    question: "Does it keep my files?",
  },
  {
    answer: "Same sign-in, same computer, same conversations.",
    question: "What about the iPhone app?",
  },
];
