import { describe, expect, it } from "vitest";

import { siteConfig } from "./config";
import { formatAuthEmailFrom } from "./email";

describe("formatAuthEmailFrom", () => {
  it("uses Expert and the default mailbox when AUTH_EMAIL_FROM is unset", () => {
    expect(formatAuthEmailFrom(undefined)).toBe("Expert <hello@send.blode.co>");
    expect(formatAuthEmailFrom("")).toBe("Expert <hello@send.blode.co>");
    expect(formatAuthEmailFrom("   ")).toBe("Expert <hello@send.blode.co>");
  });

  it("keeps the address from AUTH_EMAIL_FROM and forces the Expert label", () => {
    expect(formatAuthEmailFrom("Computer <hello@send.blode.co>")).toBe(
      "Expert <hello@send.blode.co>",
    );
    expect(formatAuthEmailFrom("Other <ops@send.blode.co>")).toBe("Expert <ops@send.blode.co>");
    expect(formatAuthEmailFrom("hello@send.blode.co")).toBe("Expert <hello@send.blode.co>");
    expect(formatAuthEmailFrom('"Old Name" <ops@send.blode.co>')).toBe(
      "Expert <ops@send.blode.co>",
    );
  });

  it("falls back to the default mailbox when the env value has no address", () => {
    expect(formatAuthEmailFrom("Expert")).toBe("Expert <hello@send.blode.co>");
    expect(formatAuthEmailFrom("<not-an-email>")).toBe("Expert <hello@send.blode.co>");
  });

  it("uses the site product name as the display name", () => {
    expect(siteConfig.name).toBe("Expert");
    expect(formatAuthEmailFrom(undefined).startsWith(`${siteConfig.name} `)).toBe(true);
  });
});
