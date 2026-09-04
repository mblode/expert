/**
 * The marketing page's words, in one file so the claims can be read together.
 *
 * Two rules they are written to. Say what the product does rather than what it
 * is made of: a visitor does not buy Eve, a hub or a Fly Machine, they buy a
 * computer that keeps working and a screen they can take. And claim nothing
 * that is not live, because the nearest competitors are free desktop apps that
 * wrap agents on your own machine, and the one thing they cannot do is hand a
 * stranger a real browser for half an hour.
 */

/**
 * The four beats of the scrolled "How it works" section, in order. A tuple
 * rather than a plain array: the section reads them by index, and `as const`
 * is what keeps that indexing typed under noUncheckedIndexedAccess.
 */
export const howItWorks = [
  {
    body: "An email code, no password and nothing to install. The computer is already awake on the other side.",
    step: "01",
    title: "Sign in",
  },
  {
    body: "Say what you want in plain words. It drives a real Chrome and a real terminal while you watch the screen.",
    step: "02",
    title: "Give it work",
  },
  {
    body: "At a password or a captcha it stops and hands you the mouse. Tap I’m done and it carries on from there.",
    step: "03",
    title: "Take the seat",
  },
  {
    body: "Close the laptop and the work continues. It messages you when it needs you, and /workspace survives the restart.",
    step: "04",
    title: "It keeps going",
  },
] as const;

export const whatYouGet = [
  {
    description:
      "One Linux machine per account, with Chrome, a terminal, and files that survive a restart. Close the laptop and it keeps going.",
    title: "A computer that stays",
  },
  {
    description:
      "The screen is live and view-only until you take it. Then the mouse, keyboard and clipboard are yours, and the agent waits.",
    title: "A seat you can take",
  },
  {
    description:
      "Send someone a link and it opens the screen on their phone for half an hour, then dies. They never sign in.",
    title: "A link you can hand over",
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
      "hello.expert on a laptop or a phone: the conversation, the live screen, and the seat when you want it.",
    title: "The web",
  },
  {
    description:
      "Message it like you would a person. When it needs hands it sends back a link that opens the screen on your phone.",
    title: "WhatsApp",
  },
  {
    description:
      "Add the skill and Claude Code, Codex, OpenCode or Cursor drive the same computer you do, through the same seat.",
    title: "Your CLI",
  },
  {
    description:
      "Connect an MCP server and the computer uses those tools beside its own browser and terminal.",
    title: "MCP",
  },
];

export const faqs = [
  {
    answer:
      "One Linux computer that stays on, and an agent that drives it. You watch the screen and take over whenever you want.",
    question: "What is this?",
  },
  {
    answer: "Open hello.expert and sign in with an email code. The computer is already waiting.",
    question: "How do I start?",
  },
  {
    answer:
      "Yes. Take the seat and the mouse, keyboard and clipboard are yours; the agent's next move waits until you hand it back.",
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
    answer: "Same sign-in, same computer, same conversation.",
    question: "What about the iPhone app?",
  },
];
