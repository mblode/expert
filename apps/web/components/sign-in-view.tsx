import { useState } from "react";

import { attachSeat, isEmail, isOtpCode, type EmailAuth } from "../lib/auth";
import type { StoredSeat } from "../lib/storage";

/**
 * Product sign-in: email → 6-digit OTP → Seat.Session. Pairing stays one
 * click away for a box that is not wired to Supabase.
 */
export function SignInView({
  auth,
  hubUrl,
  onHubUrl,
  onSignedIn,
  onPairInstead,
}: {
  auth: EmailAuth;
  hubUrl: string;
  onHubUrl?: (url: string) => void;
  onSignedIn: (seat: StoredSeat) => void;
  onPairInstead?: () => void;
}): React.ReactElement {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || !isEmail(email)) return;
    setBusy(true);
    setError(null);
    try {
      await auth.sendOtp(email);
      setStep("code");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "could not send a code");
    } finally {
      setBusy(false);
    }
  };

  const verify = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || !isOtpCode(code)) return;
    setBusy(true);
    setError(null);
    try {
      const session = await auth.verifyOtp(email, code);
      const result = await attachSeat(hubUrl.trim().replace(/\/+$/u, ""), session.accessToken);
      onSignedIn({
        hubUrl: hubUrl.trim().replace(/\/+$/u, ""),
        seatToken: result.token,
        email: session.email,
        source: "otp",
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "sign-in failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center p-6">
      <form className="w-full max-w-sm space-y-5" onSubmit={step === "email" ? send : verify}>
        <div>
          <h1 className="text-xl font-semibold">Computer</h1>
          <p className="mt-1 text-sm text-mute">
            {step === "email"
              ? "Sign in with your email. Every client of this account shares one desktop."
              : `Enter the 6-digit code sent to ${email.trim()}.`}
          </p>
        </div>

        {onHubUrl && (
          <label className="block space-y-1.5">
            <span className="text-xs font-medium uppercase tracking-wide text-mute">Hub URL</span>
            <input
              autoComplete="url"
              className="w-full rounded-lg border border-edge bg-panel px-3 py-2 text-sm outline-none focus:border-accent"
              name="hub"
              onChange={(event) => onHubUrl(event.target.value)}
              spellCheck={false}
              value={hubUrl}
            />
          </label>
        )}

        {step === "email" ? (
          <label className="block space-y-1.5">
            <span className="text-xs font-medium uppercase tracking-wide text-mute">Email</span>
            <input
              autoComplete="email"
              autoFocus
              className="w-full rounded-lg border border-edge bg-panel px-3 py-2 text-sm outline-none focus:border-accent"
              inputMode="email"
              name="email"
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              type="email"
              value={email}
            />
          </label>
        ) : (
          <label className="block space-y-1.5">
            <span className="text-xs font-medium uppercase tracking-wide text-mute">Code</span>
            <input
              autoComplete="one-time-code"
              autoFocus
              className="w-full rounded-lg border border-edge bg-panel px-3 py-2 font-mono text-lg tracking-[0.3em] outline-none focus:border-accent"
              inputMode="numeric"
              maxLength={6}
              name="code"
              onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
              pattern="\d{6}"
              placeholder="000000"
              value={code}
            />
          </label>
        )}

        {error && (
          <p className="rounded-lg border border-red-900/60 bg-red-950/50 px-3 py-2 text-sm text-red-200" role="alert">
            {error}
          </p>
        )}

        <button
          className="w-full rounded-lg bg-accent px-3 py-2 text-sm font-medium text-ink disabled:opacity-50"
          disabled={busy || (step === "email" ? !isEmail(email) : !isOtpCode(code))}
          type="submit"
        >
          {busy ? "…" : step === "email" ? "Send code" : "Sign in"}
        </button>

        {step === "code" && (
          <button
            className="w-full text-xs text-mute hover:text-white"
            onClick={() => {
              setStep("email");
              setCode("");
              setError(null);
            }}
            type="button"
          >
            Use a different email
          </button>
        )}

        {onPairInstead && (
          <button className="w-full text-xs text-mute hover:text-white" onClick={onPairInstead} type="button">
            Use a setup code instead
          </button>
        )}
      </form>
    </div>
  );
}
