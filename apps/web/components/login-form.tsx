"use client";

import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { authClient } from "@/lib/auth-client";
import { captureEvent, identifyUser } from "@/lib/posthog-client";
import { userFromSignIn } from "@/lib/sign-in-user";

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
    let data: unknown;
    try {
      const { data: signInData, error: verifyError } = await authClient.signIn.emailOtp({
        email: email.trim().toLowerCase(),
        otp: code,
      });
      if (verifyError) {
        setError(verifyError.message ?? "That code did not work. Try again.");
        verifyingRef.current = false;
        setPending(false);
        return;
      }
      data = signInData;
    } catch {
      setError(NETWORK_ERROR);
      verifyingRef.current = false;
      setPending(false);
      return;
    }
    // Identify from the sign-in body. Do not getSession here: that runs
    // customSession pairing and a throw would leave a consumed code on /login.
    // Keep pending/verifying locked: the code is already consumed.
    try {
      const user = userFromSignIn(data);
      if (user) {
        identifyUser(user.id, user.email ?? email.trim().toLowerCase());
      }
      captureEvent("login_completed", { method: "email_otp" });
    } catch {
      // Analytics must not unlock the form or paint a network error.
    }
    window.location.assign("/");
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

  const errorAlert = error ? (
    <Alert variant="destructive">
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  ) : null;

  const socialButtons =
    googleEnabled || appleEnabled ? (
      <>
        {googleEnabled && (
          <Button
            className="w-full"
            disabled={pending}
            onClick={() => void social("google")}
            size="input"
            type="button"
            variant="outline"
          >
            Continue with Google
          </Button>
        )}
        {appleEnabled && (
          <Button
            className="w-full"
            disabled={pending}
            onClick={() => void social("apple")}
            size="input"
            type="button"
            variant="outline"
          >
            Continue with Apple
          </Button>
        )}
        <FieldSeparator>or</FieldSeparator>
      </>
    ) : null;

  if (step === "otp") {
    return (
      <form
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          void submitOtp(otp);
        }}
      >
        <FieldGroup className="gap-5">
          <Field>
            <FieldLabel className="w-full justify-center" htmlFor="login-otp">
              One-time code
            </FieldLabel>
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
            <FieldDescription className="text-center">
              We sent a code to {email}.{" "}
              <Button
                className="h-auto px-0 text-xs"
                disabled={pending || cooldown > 0}
                onClick={() => void resendOtp()}
                type="button"
                variant="link"
              >
                {cooldown > 0 ? `Resend in ${cooldown}s` : "Resend code"}
              </Button>
            </FieldDescription>
          </Field>
          {errorAlert}
          <Button
            className="w-full"
            disabled={otp.length !== OTP_LENGTH}
            loading={pending}
            size="input"
            type="submit"
          >
            Verify and sign in
          </Button>
          <Button
            className="w-full"
            onClick={() => {
              setStep("email");
              setOtp("");
              setError(null);
              setCooldown(0);
            }}
            size="input"
            type="button"
            variant="outline"
          >
            Use a different email
          </Button>
        </FieldGroup>
      </form>
    );
  }

  return (
    <form className="flex flex-col gap-5" onSubmit={(event) => void requestOtp(event)}>
      <FieldGroup className="gap-5">
        {socialButtons}
        <Field>
          <FieldLabel htmlFor="login-email">Email</FieldLabel>
          <Input
            autoComplete="email"
            id="login-email"
            onChange={(event) => setEmail(event.target.value)}
            placeholder="name@domain.com"
            required
            type="email"
            value={email}
          />
        </Field>
        {errorAlert}
        <Button
          className="w-full"
          disabled={!email.trim()}
          loading={pending}
          size="input"
          type="submit"
        >
          Send me a one-time password
        </Button>
      </FieldGroup>
    </form>
  );
}
