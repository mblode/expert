import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { session as exchangeSession } from "./seat";
import type { PairResult } from "./seat";

export type AuthSession = {
  accessToken: string;
  email?: string;
};

/**
 * Email OTP against Supabase Auth. The hub never sees the mailbox —
 * after verify we exchange the access token for a seat via `Seat.Session`.
 */
export type EmailAuth = {
  sendOtp(email: string): Promise<void>;
  verifyOtp(email: string, code: string): Promise<AuthSession>;
  currentSession(): Promise<AuthSession | undefined>;
  signOut(): Promise<void>;
};

export function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export function isOtpCode(value: string): boolean {
  return /^\d{6}$/.test(value.trim());
}

export function supabaseConfigured(
  url = process.env.NEXT_PUBLIC_SUPABASE_URL,
  anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
): boolean {
  return Boolean(url?.trim() && anonKey?.trim());
}

export function createEmailAuth(opts?: {
  url?: string;
  anonKey?: string;
  client?: SupabaseClient;
}): EmailAuth | undefined {
  if (opts?.client) return wrapClient(opts.client);
  const url = (opts?.url ?? process.env.NEXT_PUBLIC_SUPABASE_URL)?.trim();
  const anonKey = (opts?.anonKey ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)?.trim();
  if (!url || !anonKey) return undefined;
  return wrapClient(
    createClient(url, anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    }),
  );
}

function wrapClient(supabase: SupabaseClient): EmailAuth {
  return {
    async sendOtp(email: string) {
      const trimmed = email.trim();
      if (!isEmail(trimmed)) throw new Error("enter a valid email address");
      const { error } = await supabase.auth.signInWithOtp({
        email: trimmed,
        options: { shouldCreateUser: true },
      });
      if (error) throw new Error(error.message);
    },
    async verifyOtp(email: string, code: string) {
      const trimmed = email.trim();
      const token = code.trim();
      if (!isEmail(trimmed)) throw new Error("enter a valid email address");
      if (!isOtpCode(token)) throw new Error("enter the 6-digit code");
      const { data, error } = await supabase.auth.verifyOtp({
        email: trimmed,
        token,
        type: "email",
      });
      if (error) throw new Error(error.message);
      const session = data.session;
      const accessToken = session?.access_token;
      if (!session || !accessToken) throw new Error("sign-in did not return a session");
      return { accessToken, email: session.user.email ?? trimmed };
    },
    async currentSession() {
      const { data } = await supabase.auth.getSession();
      const accessToken = data.session?.access_token;
      if (!accessToken) return undefined;
      return { accessToken, email: data.session?.user.email ?? undefined };
    },
    async signOut() {
      await supabase.auth.signOut();
    },
  };
}

/** After OTP, mint the hub seat the rest of the app already knows how to use. */
export async function attachSeat(hubUrl: string, accessToken: string): Promise<PairResult> {
  return await exchangeSession(hubUrl, accessToken);
}

export function defaultHubUrl(): string {
  const configured = process.env.NEXT_PUBLIC_HUB_URL?.trim().replace(/\/+$/u, "");
  if (configured) return configured;
  if (typeof window !== "undefined" && window.location.protocol.startsWith("http")) {
    return window.location.origin;
  }
  return "http://127.0.0.1:8787";
}
