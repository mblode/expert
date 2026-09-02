import { afterEach, describe, expect, it } from "vitest";
import { asBox, boxLogin } from "../src/desk/docker.ts";

describe("desk children under the uid split", () => {
  const saved = {
    HOME: process.env.HOME,
    RUN_AS: process.env.COMPUTER_RUN_AS,
    USER: process.env.USER,
  };
  afterEach(() => {
    process.env.HOME = saved.HOME;
    process.env.USER = saved.USER;
    if (saved.RUN_AS === undefined) {
      delete process.env.COMPUTER_RUN_AS;
    } else {
      process.env.COMPUTER_RUN_AS = saved.RUN_AS;
    }
  });

  it("get box's login, not the hub's, when the hub runs as another user", () => {
    process.env.COMPUTER_RUN_AS = "box";
    process.env.HOME = "/workspace/.computer/home";
    process.env.USER = "hub";
    expect(boxLogin()).toMatchObject({ HOME: "/home/box", USER: "box" });
    const argv = asBox(["xdotool", "key", "a"], boxLogin());
    expect(argv.slice(0, 6)).toEqual(["sudo", "-n", "-u", "box", "--", "env"]);
    expect(argv).toContain("HOME=/home/box");
    expect(argv).not.toContain("HOME=/workspace/.computer/home");
  });

  it("keep the hub's own login without the split", () => {
    delete process.env.COMPUTER_RUN_AS;
    process.env.HOME = "/home/me";
    process.env.USER = "me";
    expect(boxLogin()).toMatchObject({ HOME: "/home/me", USER: "me" });
    expect(asBox(["xdotool"], boxLogin())).toEqual(["xdotool"]);
  });
});
