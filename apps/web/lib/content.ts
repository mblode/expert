export const faqs = [
  {
    answer:
      "Open hello.expert and sign in with email (a one-time code). That is install for humans. The web server pairs with the computer for you: you never type a setup code.",
    question: "How do I get on the desk?",
  },
  {
    answer:
      "Paste `npx skills add https://hello.expert` in Claude, Codex, OpenCode, or Cursor. The skill tells the agent you have a cloud computer at hello.expert. After you are signed in, the agent uses the hub Seat RPCs. It must not invent a setup code and must not guess a pairing token.",
    question: "How does the agent skill work?",
  },
  {
    answer:
      "/workspace and ~/.config survive compose restarts, Machine sleep, and image rebuilds. The hub roster (bots and seat tokens) lives on the host volume. apt packages and ~/.local/state do not survive a rebuild. Status and roster do not wake a sleeping guest.",
    question: "What gets persisted?",
  },
  {
    answer:
      "No. The skill cannot drive the box without a signed-in session. Seat RPCs need the seat token the web server mints after you sign in. An agent with only the skill and no live session cannot move the pointer or type.",
    question: "Can the skill drive the box without a signed-in session?",
  },
  {
    answer:
      "Sign in at hello.expert and take the seat yourself. The skill is how an agent finds the computer; the desk is already yours once you have a session.",
    question: "What if I don't use an AI agent?",
  },
  {
    answer:
      "No. Humans never pair with a setup code on the product web. The server holds COMPUTER_SETUP_CODE. iOS still uses pairing; agents must not invent a code.",
    question: "Do I need a setup code?",
  },
];
