import { afterEach, describe, expect, it, vi } from "vitest";

import { attachSeat, createEmailAuth, isEmail, isOtpCode } from "./auth";
import { session } from "./seat";

describe("email OTP helpers", () => {
  it("accepts a 6-digit code and a plain email", () => {
    expect(isOtpCode("123456")).toBe(true);
    expect(isOtpCode("12345")).toBe(false);
    expect(isOtpCode("1234567")).toBe(false);
    expect(isOtpCode("12 3456")).toBe(false);
    expect(isEmail("you@example.com")).toBe(true);
    expect(isEmail("not-an-email")).toBe(false);
  });
});

describe("createEmailAuth", () => {
  it("is undefined without supabase env", () => {
    expect(createEmailAuth({ url: "", anonKey: "" })).toBeUndefined();
  });

  it("sends OTP and verifies a 6-digit code against a mocked client", async () => {
    const signInWithOtp = vi.fn().mockResolvedValue({ error: null });
    const verifyOtp = vi.fn().mockResolvedValue({
      data: {
        session: { access_token: "jwt-access", user: { email: "you@example.com" } },
      },
      error: null,
    });
    const auth = createEmailAuth({
      client: {
        auth: { signInWithOtp, verifyOtp, getSession: vi.fn(), signOut: vi.fn() },
      } as never,
    });
    expect(auth).toBeDefined();
    await auth!.sendOtp("you@example.com");
    expect(signInWithOtp).toHaveBeenCalledWith({
      email: "you@example.com",
      options: { shouldCreateUser: true },
    });
    const session = await auth!.verifyOtp("you@example.com", "424242");
    expect(session).toEqual({ accessToken: "jwt-access", email: "you@example.com" });
    expect(verifyOtp).toHaveBeenCalledWith({
      email: "you@example.com",
      token: "424242",
      type: "email",
    });
  });

  it("rejects a non-6-digit code before calling supabase", async () => {
    const verifyOtp = vi.fn();
    const auth = createEmailAuth({
      client: { auth: { signInWithOtp: vi.fn(), verifyOtp, getSession: vi.fn(), signOut: vi.fn() } } as never,
    });
    await expect(auth!.verifyOtp("you@example.com", "12")).rejects.toThrow(/6-digit/);
    expect(verifyOtp).not.toHaveBeenCalled();
  });
});

describe("Seat.Session from the browser", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the access token and returns the seat", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: "seat-1", vnc_url: "http://h/vnc", status: { state: "AGENT" } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await session("http://127.0.0.1:8787", "jwt-access");
    expect(result.token).toBe("seat-1");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8787/computer.v1.Seat/Session",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer jwt-access" }),
      }),
    );
  });

  it("attachSeat is the OTP → seat handoff", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ token: "seat-2", vnc_url: "http://h/vnc", status: {} }),
      }),
    );
    await expect(attachSeat("http://127.0.0.1:8787", "jwt")).resolves.toMatchObject({ token: "seat-2" });
  });
});
