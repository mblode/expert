import { siteConfig } from "./config";
import { AUTHOR, CONTACT_EMAIL } from "./site";

/**
 * The public pages beyond the front door, as data.
 *
 * One module renders three ways: the React page, the Markdown twin the proxy
 * serves to `Accept: text/markdown`, and the JSON-LD on each page, so the
 * three cannot disagree. Every sentence here is checkable against the code
 * or the docs in this repository; the guides follow the skeleton in
 * docs/gtm/guides-format.md of the sibling donebear repo: answer first,
 * takeaways that stand alone, steps with the number in the eyebrow, the
 * honest limit, then the questions people actually ask.
 */

interface Faq {
  question: string;
  answer: string;
}

interface GuideStep {
  title: string;
  body: string[];
}

interface Guide {
  slug: string;
  eyebrow: string;
  title: string;
  metaTitle: string;
  description: string;
  shortAnswer: string;
  takeaways: string[];
  steps: GuideStep[];
  limits: string;
  faqs: Faq[];
  published: string;
  updated: string;
}

export const GUIDES: Guide[] = [
  {
    description:
      "How to take the seat from an AI agent that is using a computer, what the agent sees while you have it, and how to hand it back.",
    eyebrow: "The seat",
    faqs: [
      {
        answer:
          "Yes. Taking the seat is the stop button. The agent's next action is refused and it waits until you hand the seat back.",
        question: "Can I stop the agent in the middle of something?",
      },
      {
        answer:
          "It moves to a waiting state and its next call to the computer is refused with a seat-held error. Nothing you type is delivered to the model; it learns only that a person had the seat.",
        question: "What does the agent do while I have the seat?",
      },
      {
        answer:
          "The screen is served view-only. Your pointer and keystrokes go through the hub, which refuses them unless you hold the seat. That is what stops two hands on one mouse.",
        question: "Can the agent and I both type at once?",
      },
      {
        answer:
          "Yes. A desk link opens one screen for a set time and then expires. The person you send it to gets a guest seat on that screen, not an account.",
        question: "Can someone else take the seat on my behalf?",
      },
    ],
    limits:
      "The seat is per screen, and the hub is the only door: a takeover does not cancel work the agent already sent to the computer before your click, only the next action.",
    metaTitle: "How to take the seat from an AI agent and hand it back",
    published: "2026-09-06",
    shortAnswer:
      "To take the seat from an AI agent on Expert, open the computer, click Take the seat, do what needs a person, and click I'm done. The agent's next action is refused while you hold the seat and it resumes when you hand it back. The screen stays view-only; only your input through the hub reaches the machine.",
    slug: "take-the-seat",
    steps: [
      {
        body: [
          "Sign in at hello.expert. The workspace shows the computer's screen beside the conversation with the Bot. The screen is a live view; nothing you do on it counts until you hold the seat.",
        ],
        title: "Open the computer",
      },
      {
        body: [
          "The Bot drives the computer through five tools: send a message, use the computer, run a shell command, read a file, write a file. What you see is what it is doing. There is no hidden session.",
        ],
        title: "Watch what the agent is doing",
      },
      {
        body: [
          "Click Take the seat. The seat moves from the agent to you, and the agent's next call to the computer is refused with a seat-held error. A batch of actions already running stops at its next action rather than finishing.",
          "On a phone the same control sits in the bar under the screen, with a trackpad mode for the pointer.",
        ],
        title: "Take the seat",
      },
      {
        body: [
          "Type, click, paste. Your pointer and keystrokes travel through the hub to the computer; the screen itself is view-only, so a stray click on the video never lands. A password you type here is typed by you, not read by the model.",
        ],
        title: "Do the part that needs a person",
      },
      {
        body: [
          "Click I'm done. The seat returns to the agent, which sees that a person had it and carries on. If it asked you for the seat, its next message will say what it did with what you left.",
        ],
        title: "Hand it back",
      },
    ],
    takeaways: [
      "Taking the seat refuses the agent's next action; it does not undo the last one.",
      "The screen is view-only, and every keystroke goes through the hub.",
      "Nothing you type while holding the seat reaches the model.",
      "I'm done hands the seat back and the agent resumes from there.",
      "A desk link gives someone else a guest seat on one screen for a set time.",
    ],
    title: "How to take the seat from an AI agent and hand it back",
    updated: "2026-09-06",
  },
  {
    description:
      "Passwords and two-factor codes stay with the human. How an agent on Expert asks, where the value goes, and why the model never sees it.",
    eyebrow: "Secrets",
    faqs: [
      {
        answer:
          "No. The masked field posts the value to the hub, which puts it on the computer's clipboard. It is not written to the conversation, not returned to the Bot, and not in anything the model reads.",
        question: "Does the model ever see the code I type?",
      },
      {
        answer:
          "About two minutes. If the clipboard still holds the value after that, the hub clears it. If something else was copied over it in the meantime, that is left alone.",
        question: "How long does the secret stay on the clipboard?",
      },
      {
        answer:
          "Take the seat and type it yourself. That path never involves the model at all, and it is what the Bot asks for when a site wants more than one field.",
        question: "What if I would rather type it myself?",
      },
      {
        answer:
          "The Bot's instructions forbid asking for credentials in chat, and on WhatsApp there is no masked field, so the answer there is to sign in at hello.expert and use the seat.",
        question: "Can I send a password over WhatsApp instead?",
      },
    ],
    limits:
      "The computer is one trust domain: while the value is on the clipboard, anything running on that screen could read it. The two-minute clear bounds that; it does not remove it.",
    metaTitle: "Who types the passwords and 2FA codes when an AI agent uses a browser",
    published: "2026-09-06",
    shortAnswer:
      "On Expert the human does. When a site asks for a password, a two-factor code or a payment, the agent stops and either asks you to take the seat or sends a secret request. You answer in a masked field on hello.expert; the value goes to the computer's clipboard and nowhere else, the agent pastes it, and the clipboard is cleared about two minutes later.",
    slug: "passwords-and-2fa-codes",
    steps: [
      {
        body: [
          "The agent reaches a login, a verification code or a checkout. Its instructions say credentials are the human's job, so it does not guess and does not ask you to type a password into the chat.",
        ],
        title: "The agent hits a password field",
      },
      {
        body: [
          "For a single value it sends a secret request: a prompt and a label such as GitHub 2FA code. Sending one ends its turn. It cannot say anything else until you answer or speak.",
          "For anything longer, a full sign-in or a payment form, it asks you to take the seat instead.",
        ],
        title: "It asks, and stops",
      },
      {
        body: [
          "On hello.expert the request appears as a card with a masked field. Type the value and press Put on the clipboard. The value is posted to the hub over the same authenticated connection the rest of the workspace uses.",
        ],
        title: "You answer in the masked field",
      },
      {
        body: [
          "The hub places the value on the computer's clipboard and tells the agent that the label is there to paste. The value is not in the conversation record, not in the agent's reply, and not in the model's context.",
        ],
        title: "The value goes to the clipboard, not to the model",
      },
      {
        body: [
          "The agent pastes it into the field and carries on. About two minutes after delivery the hub checks the clipboard and, if it still holds that value, clears it.",
        ],
        title: "The agent pastes it and the clipboard is cleared",
      },
    ],
    takeaways: [
      "A secret request ends the agent's turn; it waits for you.",
      "The masked field sends the value to the hub, never to the model.",
      "The value lands on the computer's clipboard and is cleared after about two minutes.",
      "Anything longer than one value is done by you, in the seat.",
      "Asking for credentials in chat is against the Bot's instructions.",
    ],
    title: "Who types the passwords and 2FA codes when an AI agent uses a browser?",
    updated: "2026-09-06",
  },
  {
    description:
      "What an AI assistant with its own computer is, what arrives with one on Expert, how to get one, and what stays on it between sessions.",
    eyebrow: "Getting started",
    faqs: [
      {
        answer:
          "One Bot arrives with the computer and carries every skill. You can make more from the page when you want separate threads; each gets its own screen, up to sixteen.",
        question: "How many Bots do I get?",
      },
      {
        answer:
          "No. It opens the site in its own Chrome, like you would. The parts that need an API are the parts that need nothing: a browser and a terminal.",
        question: "Does it need an API for the tools I use?",
      },
      {
        answer:
          "Files under /workspace and the browser profiles survive restarts and rebuilds. Packages you install do not; keep a list and the Bot reinstalls them.",
        question: "What survives between sessions?",
      },
      {
        answer:
          "Yes. WhatsApp for the conversation and hello.expert in the phone's browser for the screen, with touch controls and a trackpad mode. There is no app to install.",
        question: "Can I use it from my phone?",
      },
    ],
    limits:
      "It is one computer for one account: Bots on it share files and browser sessions and are not security boundaries from each other. Sign-up is by waitlist while computers are handed out one at a time.",
    metaTitle: "How to give an AI assistant a computer of its own",
    published: "2026-09-06",
    shortAnswer:
      "An AI assistant with its own computer is a persistent Linux desktop, with a browser, files and a terminal, that the assistant drives and you can watch and take over. On Expert you get one per account: message Vibey on WhatsApp or join the waitlist at hello.expert, and the Bot that arrives carries the skills of a small team. Files and browser sessions stay on it between sessions.",
    slug: "give-an-ai-assistant-a-computer",
    steps: [
      {
        body: [
          "Not a chat window with integrations. A real Linux machine that stays on: a desktop at 1280 by 800, Chromium, a home directory at /workspace, and a terminal. The Bot uses it the way you would, and you can see the screen at any time.",
        ],
        title: "Know what you are getting",
      },
      {
        body: [
          "Message Vibey on WhatsApp to set one up, or leave your email at hello.expert. Sign-up is gated by a waitlist while computers are handed out one at a time; you are told by email when yours is ready.",
        ],
        title: "Ask for a computer",
      },
      {
        body: [
          "One Bot arrives, on its own screen and in its own thread. It carries the skills of a small team as procedures: calendar, mail drafts, browser QA, shipping a code change, incident triage, research, campaigns and more. You can make further Bots from the page when you want separate threads.",
        ],
        title: "Meet the Bot",
      },
      {
        body: [
          "Ask it to open a site, sign into a tool with you at the keyboard, or run a routine every morning. When it needs a password or a payment it stops and asks; when it is stuck you take the seat. Routines run while you are away because an outside clock wakes the computer for them.",
        ],
        title: "Hand off work and watch",
      },
      {
        body: [
          "Files under /workspace and the Chromium profiles survive restarts and image rebuilds, so a login you completed once stays completed. Installed packages do not survive; keep the list in a file and the Bot reinstalls them.",
        ],
        title: "Keep what matters on the machine",
      },
    ],
    takeaways: [
      "One account, one always-on Linux computer with a browser, files and a terminal.",
      "One Bot arrives with every skill; more can be made, each with its own screen.",
      "Get one by messaging Vibey on WhatsApp or joining the waitlist at hello.expert.",
      "Files and browser sessions persist; installed packages do not.",
      "Routines run while you are away, woken by an outside clock.",
    ],
    title: "How to give an AI assistant a computer of its own",
    updated: "2026-09-06",
  },
];

export function guideBySlug(slug: string): Guide | undefined {
  return GUIDES.find((g) => g.slug === slug);
}

export const ABOUT = {
  description:
    "Expert is a small, open-source product by Matthew Blode: one persistent Linux computer per account, driven by AI Bots and shared with the person who can take the seat.",
  paragraphs: [
    "Expert gives a person one computer that stays on, and a team of Bots that drive it. The computer is a real Linux desktop with a browser, files and a terminal. The Bots use it the way you would, and you can watch the screen and take the mouse at any time.",
    "It is built by Matthew Blode and began in August 2026. The code is public under the MIT licence at github.com/mblode/expert: the hub that owns the screen and the seat, the Bot runtime, the WhatsApp bridge and this site.",
    "The design rests on a few refusals. Plain model text is a scratchpad and only what the Bot chooses to send reaches you. Passwords, two-factor codes and payments are the human's job. The screen is view-only, and every keystroke goes through the hub, so the seat can refuse it. A computer belongs to one account, and that is the boundary.",
    "Each computer is a Fly Machine in Sydney that suspends when idle and wakes for a message or a routine. The site runs on Vercel. Conversation happens on WhatsApp or in the browser at hello.expert; the native iOS app was retired in September 2026.",
    "Today there is one computer, Vibey's, serving a community of founders and engineers, with new sign-ups on a waitlist while computers are handed out one at a time.",
  ],
  title: "About Expert",
  updated: "2026-09-06",
};

export const CONTACT = {
  description: `Reach Expert by email at ${CONTACT_EMAIL}, or open an issue on GitHub. Existing users can message their Bot on WhatsApp.`,
  paragraphs: [
    `Email ${CONTACT_EMAIL} for anything: access, a question about the product, a security report, or a request to delete your data. There is one person reading it.`,
    "For a bug or a request that other people would benefit from seeing, open an issue at github.com/mblode/expert.",
    "If you already have a computer, the fastest route is the WhatsApp chat you set it up in: message Vibey and say what is wrong.",
  ],
  title: "Contact",
  updated: "2026-09-06",
};

export const PRIVACY = {
  description:
    "A plain statement of what Expert stores, where, and how to have it removed. Written from the code, not from a template.",
  sections: [
    {
      body: [
        "Your email address, used to sign you in with a one-time code and to bind you to your computer. Stored in a Turso database. Sign-in codes are sent through Resend and are not kept.",
        "If you joined the waitlist: your email address, when you joined and from where, and whether we emailed you. The same address may be added to a Resend audience so we can tell you when a computer is ready.",
      ],
      title: "The account",
    },
    {
      body: [
        "Everything on the computer is yours and stays on its volume: files under /workspace, the browser profiles, the record of every conversation the Bot had, and the Bot's memory. The volume is a Fly Machine in Sydney. Images the Bot generates or you upload are stored in Vercel Blob.",
        "Messages sent to a Bot on WhatsApp pass through a bridge that holds the WhatsApp session, then to your computer. The bridge keeps delivery receipts; the computer keeps the conversation.",
      ],
      title: "The computer",
    },
    {
      body: [
        "Bots call a language model through Vercel's AI Gateway. What they send is the conversation, the instructions and what they read on the screen. A secret you provide through the masked field is not sent: it goes to the computer's clipboard and is cleared about two minutes later.",
      ],
      title: "The model",
    },
    {
      body: [
        "hello.expert uses PostHog for product analytics when configured: page views, sign-ins and which features are used, tied to your account once you sign in. No advertising trackers, no Google Analytics.",
      ],
      title: "Analytics",
    },
    {
      body: [
        `Email ${CONTACT_EMAIL}. Deleting a computer removes its volume and everything on it; deleting an account removes the database rows above. Backups of a destroyed volume are snapshots kept for a few days by the hosting provider, then gone.`,
      ],
      title: "Removing your data",
    },
  ],
  title: "Privacy",
  updated: "2026-09-06",
};

/** The Markdown twin of a page, for `Accept: text/markdown` and agents. */
export function pageMarkdown(path: string): string | null {
  const url = (p: string) => `${siteConfig.url}${p}`;
  if (path === "/") {
    return [
      `# A team of Bots with a computer of their own`,
      "",
      siteConfig.description,
      "",
      `- [Guides](${url("/guides")})`,
      `- [About](${url("/about")})`,
      `- [Contact](${url("/contact")})`,
      `- [Privacy](${url("/privacy")})`,
      `- [Sign in](${url("/login")})`,
      "",
    ].join("\n");
  }
  if (path === "/about") {
    return [
      `# ${ABOUT.title}`,
      "",
      ...ABOUT.paragraphs.flatMap((p) => [p, ""]),
      `Updated ${ABOUT.updated}.`,
      "",
    ].join("\n");
  }
  if (path === "/contact") {
    return [`# ${CONTACT.title}`, "", ...CONTACT.paragraphs.flatMap((p) => [p, ""]), ""].join("\n");
  }
  if (path === "/privacy") {
    return [
      `# ${PRIVACY.title}`,
      "",
      PRIVACY.description,
      "",
      ...PRIVACY.sections.flatMap((s) => [`## ${s.title}`, "", ...s.body.flatMap((b) => [b, ""])]),
      `Updated ${PRIVACY.updated}.`,
      "",
    ].join("\n");
  }
  if (path === "/guides") {
    return [
      "# Guides",
      "",
      "Task-shaped answers about running an AI team on a computer of its own.",
      "",
      ...GUIDES.map((g) => `- [${g.title}](${url(`/guides/${g.slug}`)}): ${g.description}`),
      "",
    ].join("\n");
  }
  const m = /^\/guides\/([a-z0-9-]+)$/u.exec(path);
  const guide = m?.[1] ? guideBySlug(m[1]) : undefined;
  if (!guide) {
    return null;
  }
  return [
    `# ${guide.title}`,
    "",
    `Last updated ${guide.updated} · ${AUTHOR.name}`,
    "",
    "## The short answer",
    "",
    guide.shortAnswer,
    "",
    "## Key takeaways",
    "",
    ...guide.takeaways.map((t) => `- ${t}`),
    "",
    ...guide.steps.flatMap((s, i) => [
      `## Step ${i + 1}: ${s.title}`,
      "",
      ...s.body.flatMap((b) => [b, ""]),
    ]),
    "## The limit",
    "",
    guide.limits,
    "",
    "## Frequently asked questions",
    "",
    ...guide.faqs.flatMap((f) => [`### ${f.question}`, "", f.answer, ""]),
  ].join("\n");
}

export const MARKDOWN_PATHS = [
  "/",
  "/about",
  "/contact",
  "/privacy",
  "/guides",
  ...GUIDES.map((g) => `/guides/${g.slug}`),
];
