import { describe, expect, it } from "vitest";
import { cleanReply, outboundReply, sanitizeOutbound } from "./format-reply.ts";

describe("cleanReply: Markdown to WhatsApp", () => {
  it("collapses Markdown **bold** to WhatsApp *bold*", () => {
    expect(cleanReply("**Anthropic:** Claude Opus 4.8 dropped")).toBe(
      "*Anthropic:* Claude Opus 4.8 dropped",
    );
  });

  it("leaves already-correct WhatsApp *bold* untouched", () => {
    expect(cleanReply("*OpenAI:* GPT-5.5 is the frontier")).toBe(
      "*OpenAI:* GPT-5.5 is the frontier",
    );
  });

  it("handles several bold runs on one line", () => {
    expect(cleanReply("**Google:** stuff and **Microsoft:** more")).toBe(
      "*Google:* stuff and *Microsoft:* more",
    );
  });

  it("converts __bold__ to *bold*", () => {
    expect(cleanReply("__big news__ today")).toBe("*big news* today");
  });

  it("turns ATX headings into a bold line with no #", () => {
    expect(cleanReply("## Chinese models\nMiniMax 3 dropped")).toBe(
      "*Chinese models*\nMiniMax 3 dropped",
    );
  });

  it("collapses triple emphasis (***x***) to single", () => {
    expect(cleanReply("***huge***")).toBe("*huge*");
  });

  it("leaves triple-backtick blocks (ASCII art) alone", () => {
    const art = "```\n  .--(bot)--.\n```";
    expect(cleanReply(art)).toBe(art);
  });

  it("does not touch single-underscore italics or list dashes", () => {
    expect(cleanReply("- _keen_ on this")).toBe("- _keen_ on this");
  });
});

describe("cleanReply: dash guard", () => {
  it("turns a spaced em dash into a comma", () => {
    expect(cleanReply("nice work — really clean")).toBe("nice work, really clean");
  });

  it("turns a word-joined dash into a comma", () => {
    expect(cleanReply("opus—plans")).toBe("opus, plans");
  });

  it("keeps numeric ranges", () => {
    expect(cleanReply("takes 4–5 hours")).toBe("takes 4–5 hours");
  });

  it("trims surrounding whitespace", () => {
    expect(cleanReply("  hey  ")).toBe("hey");
  });
});

describe("never interpolate tokens into outbound WhatsApp text", () => {
  const secrets = {
    AI_GATEWAY_API_KEY: "gw-key-should-never-leak-xx",
    COMPUTER_BOT_TOKEN: "bot_seat_token_should_never_leak",
    COMPUTER_EVE_SECRET: "eve-loopback-secret-xxxx",
    COMPUTER_SETUP_CODE: "setup-code-value-xyz",
    WHATSAPP_BRIDGE_SECRET: "bridge-secret-should-never-leak",
  } as const;

  it("redacts configured secrets instead of leaving them in the reply", () => {
    const drafted = [
      `Open the desk with ${secrets.COMPUTER_SETUP_CODE}`,
      `seat=${secrets.COMPUTER_BOT_TOKEN}`,
      `pixel=${secrets.COMPUTER_EVE_SECRET}`,
      `bridge=${secrets.WHATSAPP_BRIDGE_SECRET}`,
      `gateway=${secrets.AI_GATEWAY_API_KEY}`,
    ].join(" ");
    const out = sanitizeOutbound(drafted, secrets);
    for (const value of Object.values(secrets)) {
      expect(out).not.toContain(value);
    }
    expect(out).toMatch(/\[redacted\]/u);
  });

  it("ignores a short or blank env value so ordinary words survive", () => {
    const out = sanitizeOutbound("the cat sat", {
      COMPUTER_BOT_TOKEN: "cat",
      COMPUTER_EVE_SECRET: "",
    });
    expect(out).toBe("the cat sat");
  });

  it("strips credential query params from URLs in the reply", () => {
    const out = sanitizeOutbound(
      "Open the desk: https://hello.expert/desk?token=seat_abc&pixel=pix_9&setup=fly-code-1",
    );
    expect(out).not.toContain("seat_abc");
    expect(out).not.toContain("pix_9");
    expect(out).not.toContain("fly-code-1");
    expect(out).not.toMatch(/[?&](?<param>token|pixel|setup)=/u);
    expect(out).toContain("https://hello.expert/desk");
  });

  it("keeps harmless query params and drops the fragment", () => {
    const out = sanitizeOutbound("see https://example.com/a?tab=2&token=x#frag");
    expect(out).toBe("see https://example.com/a?tab=2");
  });

  it("outboundReply runs markdown cleanup then redaction", () => {
    const prev = process.env.COMPUTER_BOT_TOKEN;
    process.env.COMPUTER_BOT_TOKEN = secrets.COMPUTER_BOT_TOKEN;
    try {
      const out = outboundReply(
        `**Open the desk** — https://hello.expert/x?token=${secrets.COMPUTER_BOT_TOKEN}`,
      );
      expect(out).toContain("*Open the desk*");
      expect(out).not.toContain(secrets.COMPUTER_BOT_TOKEN);
      expect(out).not.toContain("—");
    } finally {
      if (prev === undefined) {
        delete process.env.COMPUTER_BOT_TOKEN;
      } else {
        process.env.COMPUTER_BOT_TOKEN = prev;
      }
    }
  });

  it("does not invent a token when none was present", () => {
    expect(sanitizeOutbound("Open the desk: https://hello.expert/desk")).toBe(
      "Open the desk: https://hello.expert/desk",
    );
  });
});
