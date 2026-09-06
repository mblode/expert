import { expect, it } from "vitest";
import { readWhatsAppLoginLink, whatsappLoginLink } from "./whatsapp-login-link";

it("keeps credentials in the fragment and preserves leading-zero codes", () => {
  const url = new URL(whatsappLoginLink("61412345678", "001234"));
  expect(url.origin + url.pathname).toBe("https://hello.expert/login");
  expect(url.search).toBe("");
  expect(readWhatsAppLoginLink(url.hash)).toEqual({ phone: "+61412345678", code: "001234" });
});

it("ignores incomplete or malformed link credentials", () => {
  for (const hash of [
    "",
    "#code=123456",
    "#phone=0412345678&code=123456",
    "#phone=61412345678&code=12345x",
  ]) {
    expect(readWhatsAppLoginLink(hash)).toBeUndefined();
  }
});
