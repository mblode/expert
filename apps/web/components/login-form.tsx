"use client";

import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

import { authClient } from "@/lib/auth-client";

import { InputOTP, InputOTPGroup, InputOTPSlot } from "./ui/input-otp";

const OTP_LENGTH = 6;
const RESEND_COOLDOWN_SECONDS = 30;
const NETWORK_ERROR = "Couldn't reach the server. Check your connection and try again.";

type Step = "email" | "otp";

export function LoginForm({
  appleEnabled = false,
  googleEnabled = false,
}: {
  appleEnabled?: boolean;
  googleEnabled?: boolean;
}): React.ReactElement {
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const verifyingRef = useRef(false);

  useEffect(() => {
    if (cooldown <= 0) {
      return;
    }
    const id = setTimeout(() => setCooldown((value) => value - 1), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);

  const sendCode = async () => {
    const { error: sendError } = await authClient.emailOtp.sendVerificationOtp({
      email: email.trim().toLowerCase(),
      type: "sign-in",
    });
    if (sendError) {
      setError(sendError.message ?? "Could not send a code. Try again.");
      return false;
    }
    return true;
  };

  const requestOtp = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) {
      return;
    }
    setPending(true);
    setError(null);
    try {
      if (await sendCode()) {
        setStep("otp");
        setCooldown(RESEND_COOLDOWN_SECONDS);
      }
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setPending(false);
    }
  };

  const resendOtp = async () => {
    if (pending || cooldown > 0) {
      return;
    }
    setPending(true);
    setError(null);
    try {
      if (await sendCode()) {
        setCooldown(RESEND_COOLDOWN_SECONDS);
      }
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setPending(false);
    }
  };

  const submitOtp = async (code: string) => {
    if (verifyingRef.current) {
      return;
    }
    verifyingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const { error: verifyError } = await authClient.signIn.emailOtp({
        email: email.trim().toLowerCase(),
        otp: code,
      });
      if (verifyError) {
        setError(verifyError.message ?? "That code did not work. Try again.");
        verifyingRef.current = false;
        setPending(false);
        return;
      }
      // Full load so the server-rendered `/` sees the session cookie and
      // mounts the desk. Leave pending true so a second submit cannot re-check
      // the consumed code while navigation starts.
      window.location.assign("/");
    } catch {
      setError(NETWORK_ERROR);
      verifyingRef.current = false;
      setPending(false);
    }
  };

  const social = async (provider: "google" | "apple") => {
    if (pending) {
      return;
    }
    setPending(true);
    setError(null);
    try {
      await authClient.signIn.social({ callbackURL: "/", provider });
    } catch {
      setError(NETWORK_ERROR);
      setPending(false);
    }
  };

  const fieldClass =
    "w-full rounded-lg border border-edge bg-panel px-3 py-2 text-sm outline-none focus:border-accent";
  const primaryClass =
    "w-full rounded-lg bg-accent px-3 py-2 text-sm font-medium text-ink disabled:opacity-50";
  const ghostClass =
    "w-full rounded-lg border border-edge px-3 py-2 text-sm hover:border-accent disabled:opacity-50";

  const socialButtons =
    googleEnabled || appleEnabled ? (
      <div className="space-y-2">
        {googleEnabled && (
          <button
            className={ghostClass}
            disabled={pending}
            onClick={() => void social("google")}
            type="button"
          >
            Continue with Google
          </button>
        )}
        {appleEnabled && (
          <button
            className={ghostClass}
            disabled={pending}
            onClick={() => void social("apple")}
            type="button"
          >
            Continue with Apple
          </button>
        )}
        <p className="text-center text-xs text-mute">or</p>
      </div>
    ) : null;

  if (step === "otp") {
    return (
      <form
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          void submitOtp(otp);
        }}
      >
        <div className="space-y-1.5">
          <label
            className="block text-center text-xs font-medium uppercase tracking-wide text-mute"
            htmlFor="login-otp"
          >
            One-time code
          </label>
          <InputOTP
            autoComplete="one-time-code"
            autoFocus
            containerClassName="justify-center"
            disabled={pending}
            id="login-otp"
            maxLength={OTP_LENGTH}
            onChange={setOtp}
            onComplete={(code) => void submitOtp(code)}
            value={otp}
          >
            <InputOTPGroup>
              {Array.from({ length: OTP_LENGTH }, (_, index) => (
                <InputOTPSlot index={index} key={index} />
              ))}
            </InputOTPGroup>
          </InputOTP>
          <p className="text-center text-xs text-mute">
            We sent a code to {email}.{" "}
            <button
              className="font-medium text-white underline-offset-2 hover:underline disabled:no-underline disabled:opacity-60"
              disabled={pending || cooldown > 0}
              onClick={() => void resendOtp()}
              type="button"
            >
              {cooldown > 0 ? `Resend in ${cooldown}s` : "Resend code"}
            </button>
          </p>
        </div>
        {error && (
          <p
            className="rounded-lg border border-red-900/60 bg-red-950/50 px-3 py-2 text-sm text-red-200"
            role="alert"
          >
            {error}
          </p>
        )}
        <button
          className={primaryClass}
          disabled={pending || otp.length !== OTP_LENGTH}
          type="submit"
        >
          {pending ? "Verifying…" : "Verify and sign in"}
        </button>
        <button
          className={ghostClass}
          onClick={() => {
            setStep("email");
            setOtp("");
            setError(null);
            setCooldown(0);
          }}
          type="button"
        >
          Use a different email
        </button>
      </form>
    );
  }

  return (
    <form className="space-y-5" onSubmit={(event) => void requestOtp(event)}>
      {socialButtons}
      <label className="block space-y-1.5">
        <span className="text-xs font-medium uppercase tracking-wide text-mute">Email</span>
        <input
          autoComplete="email"
          className={fieldClass}
          id="login-email"
          onChange={(event) => setEmail(event.target.value)}
          placeholder="name@domain.com"
          required
          type="email"
          value={email}
        />
      </label>
      {error && (
        <p
          className="rounded-lg border border-red-900/60 bg-red-950/50 px-3 py-2 text-sm text-red-200"
          role="alert"
        >
          {error}
        </p>
      )}
      <button className={primaryClass} disabled={pending || !email.trim()} type="submit">
        {pending ? "Sending…" : "Send me a one-time password"}
      </button>
    </form>
  );
}
