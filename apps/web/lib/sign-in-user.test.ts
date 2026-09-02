import { describe, expect, it } from "vitest";

import { userFromSignIn } from "./sign-in-user";

describe("userFromSignIn", () => {
  it("reads user from a Better Auth email-otp payload", () => {
    expect(
      userFromSignIn({
        token: "t",
        user: { email: "a@b.co", id: "user_1" },
      }),
    ).toEqual({ email: "a@b.co", id: "user_1" });
  });

  it("accepts a bare user object", () => {
    expect(userFromSignIn({ email: "a@b.co", id: "user_1" })).toEqual({
      email: "a@b.co",
      id: "user_1",
    });
  });

  it("returns undefined when there is no id", () => {
    expect(userFromSignIn({ user: { email: "a@b.co" } })).toBeUndefined();
    expect(userFromSignIn(null)).toBeUndefined();
    expect(userFromSignIn(undefined)).toBeUndefined();
  });
});
