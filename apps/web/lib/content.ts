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
    body: "A code from your WhatsApp chat opens the same private workspace. Nothing to install.",
    step: "01",
    title: "Sign in",
  },
  {
    body: "Say what you want. A Bot drives a real Chrome while you watch its screen.",
    step: "02",
    title: "Hand off the work",
  },
  {
    body: "At a password it stops and gives you the mouse. Tap I’m done and it carries on.",
    step: "03",
    title: "Take the seat",
  },
  {
    body: "Close the laptop and it keeps going. Routines fire on their own.",
    step: "04",
    title: "It keeps going",
  },
] as const;

export const whatYouGet = [
  {
    description:
      "One Linux machine per account. Chrome, a terminal, and files that survive a restart.",
    title: "A computer of their own",
  },
  {
    description: "Eight of them, each with a lane it owns. Make more when you need them.",
    title: "A team, not a chatbot",
  },
  {
    description: "No API to wire up. A Bot opens the site and does the work there, like you would.",
    title: "Real apps, not integrations",
  },
  {
    description: "A morning brief, a smoke test, a weekly scan. They run on time without you.",
    title: "Work that runs itself",
  },
  {
    description: "The screen is live and view-only until you take it. Then the Bot waits.",
    title: "A seat you can take",
  },
  {
    description: "Send a link and someone watches the screen on their phone for half an hour.",
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
    owns: "The screen, the files and the terminal. The one you reach first.",
    shape: "circle",
    title: "Desk agent",
  },
  {
    color: "#9159fe",
    name: "Chief of Staff",
    owns: "Calendar, mail drafts, the morning brief. Never sends.",
    shape: "blob",
    title: "Front of house",
  },
  {
    color: "#00c972",
    name: "Software Engineer",
    owns: "Writes and lands code. One PR per run.",
    shape: "tablet",
    title: "Engineer",
  },
  {
    color: "#ff6700",
    name: "QA",
    owns: "Incidents, CI failures, browser testing. Draft fixes only.",
    shape: "wedge",
    title: "QA and bug fixer",
  },
  {
    color: "#000000",
    name: "Designer",
    owns: "Product, UI and brand. Designs, not code.",
    shape: "blob",
    title: "Product, UI and brand",
  },
  {
    color: "#1084fe",
    name: "PM",
    owns: "Drop-offs, opportunities, A/B tests. One experiment at a time.",
    shape: "blob",
    title: "Self-driving CRO",
  },
  {
    color: "#777777",
    name: "GTM",
    owns: "Campaigns, listings, founder emails. Nothing sends without you.",
    shape: "tablet",
    title: "Outbound operator",
  },
  {
    color: "#777777",
    name: "SEO",
    owns: "Demand research, Search Console, writer briefs. Not the article.",
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
      "hello.expert on a laptop or a phone: the Bots, the conversation, the live screen.",
    title: "The web",
  },
  {
    description: "Message a Bot like a person. When it needs hands it sends a link to the screen.",
    title: "WhatsApp",
  },
  {
    description: "Add the skill and Claude Code, Codex or Cursor drive the same computer you do.",
    title: "Your CLI",
  },
  {
    description: "Connect an MCP server and the Bots use those tools too.",
    title: "MCP",
  },
];

export const faqs = [
  {
    answer: "One Linux computer that stays on, and a team of Bots that drive it.",
    question: "What is this?",
  },
  {
    answer:
      "Message Vibey on WhatsApp to set up your assistant. When you want web access, message sign in and enter your code at hello.expert.",
    question: "How do I start?",
  },
  {
    answer: "Eight, each with its own screen and thread. You can make more.",
    question: "How many Bots do I get?",
  },
  {
    answer:
      "Front of house passes a job to the specialist and tells you where it went. They cannot message each other yet.",
    question: "Do the Bots work together?",
  },
  {
    answer: "No. It opens the site in its own Chrome. Sign-ins are the part it hands back to you.",
    question: "Does it need an API for my tools?",
  },
  {
    answer: "Yes. Take the seat and the Bot waits until you hand it back.",
    question: "Can I drive it myself?",
  },
  {
    answer: "You do. It asks for the seat, or for a masked code that never reaches the model.",
    question: "Who types the passwords and 2FA codes?",
  },
  {
    answer: "Yes. A link opens one screen for a set time, then expires.",
    question: "Can I hand the screen to someone else?",
  },
  {
    answer: "/workspace and the browser profiles survive restarts. Installed packages do not.",
    question: "Does it keep my files?",
  },
  {
    answer:
      "Use WhatsApp for conversation and hello.expert in your browser for the computer, files and coding sessions. No app download needed.",
    question: "Can I use it on my iPhone?",
  },
];
