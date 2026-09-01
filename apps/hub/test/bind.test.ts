import { describe, expect, it } from "vitest";
import { allowedBind, isCloudGuest, refuseBindMessage } from "../src/host/bind.ts";

describe("allowedBind", () => {
  it("allows loopback everywhere", () => {
    expect(allowedBind("127.0.0.1", {})).toBe(true);
    expect(allowedBind("localhost", {})).toBe(true);
  });

  it("refuses a public bind off the cloud guest", () => {
    expect(allowedBind("0.0.0.0", {})).toBe(false);
    expect(allowedBind("::", { COMPUTER_CLOUD: "no" })).toBe(false);
    expect(refuseBindMessage("0.0.0.0")).toMatch(/loopback/);
  });

  it("allows 0.0.0.0 on a Fly Machine", () => {
    expect(isCloudGuest({ FLY_APP_NAME: "computer" })).toBe(true);
    expect(allowedBind("0.0.0.0", { FLY_APP_NAME: "computer" })).toBe(true);
    expect(allowedBind("0.0.0.0", { COMPUTER_CLOUD: "fly" })).toBe(true);
    expect(allowedBind("::", { COMPUTER_CLOUD: "1" })).toBe(true);
  });
});
