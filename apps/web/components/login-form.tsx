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
import { identifyUser } from "@/lib/posthog-client";
import { userFromSignIn } from "@/lib/sign-in-user";

const OTP_LENGTH = 6;
const RESEND_COOLDOWN_SECONDS = 30;
const NETWORK_ERROR = "Couldn't reach the server. Check your connection and try again.";

type Step = "email" | "otp" | "waitlist";

export function LoginForm({
  appleEnabled = false,
  googleEnabled = false,
  next = "/",
}: {
  appleEnabled?: boolean;
  googleEnabled?: boolean;
  /**
   * Where to land after signing in. The workspace unless the person arrived
   * from somewhere that needs them signed in, which today is a shared Bot
   * template: sending them to the workspace instead would lose the link they
   * were sent. The page validates it; this only carries it.
   */
  next?: string;
}): React.ReactElement {
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
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
      setFormError(sendError.message ?? "Could not send a code. Try again.");
      return false;
    }
    return true;
  };

  // Sign-up is gated. An address that may not make an account is put on the
  // waitlist by this call and told so here, instead of being moved to the
  // code step for a code that would never come.
  const requestAccess = async (): Promise<"allowed" | "waitlisted"> => {
    const response = await fetch("/api/waitlist", {
      body: JSON.stringify({ email: email.trim().toLowerCase(), source: "login" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const result = (await response.json().catch(() => null)) as {
      status?: string;
      error?: string;
    } | null;
    if (!response.ok) {
      throw new Error(result?.error ?? NETWORK_ERROR);
    }
    return result?.status === "waitlisted" ? "waitlisted" : "allowed";
  };

  const requestOtp = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) {
      return;
    }
    setPending(true);
    setFormError(null);
    try {
      if ((await requestAccess()) === "waitlisted") {
        setStep("waitlist");
        return;
      }
      if (await sendCode()) {
        setStep("otp");
        setCooldown(RESEND_COOLDOWN_SECONDS);
      }
    } catch (error) {
      setFormError(error instanceof Error && error.message ? error.message : NETWORK_ERROR);
    } finally {
      setPending(false);
    }
  };

  const resendOtp = async () => {
    if (pending || cooldown > 0) {
      return;
    }
    setPending(true);
    setFormError(null);
    try {
      if (await sendCode()) {
        setCooldown(RESEND_COOLDOWN_SECONDS);
      }
    } catch {
      setFormError(NETWORK_ERROR);
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
    setFormError(null);
    let data: unknown;
    try {
      const { data: signInData, error: verifyError } = await authClient.signIn.emailOtp({
        email: email.trim().toLowerCase(),
        otp: code,
      });
      if (verifyError) {
        setFormError(verifyError.message ?? "That code did not work. Try again.");
        verifyingRef.current = false;
        setPending(false);
        return;
      }
      data = signInData;
    } catch {
      setFormError(NETWORK_ERROR);
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
      // The server's session-create hook owns login_completed. Capturing it
      // here as well counts one successful login twice.
    } catch {
      // Analytics must not unlock the form or paint a network error.
    }
    window.location.assign(next);
  };

  const social = async (provider: "google" | "apple") => {
    if (pending) {
      return;
    }
    setPending(true);
    setFormError(null);
    try {
      await authClient.signIn.social({ callbackURL: next, provider });
    } catch {
      setFormError(NETWORK_ERROR);
      setPending(false);
    }
  };

  const errorAlert = formError ? (
    <Alert variant="destructive">
      <AlertDescription>{formError}</AlertDescription>
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

  if (step === "waitlist") {
    return (
      <div className="flex flex-col gap-5">
        <Alert>
          <AlertDescription>
            You are on the list. We will email {email.trim().toLowerCase()} when your computer is
            ready. Nothing to do until then.
          </AlertDescription>
        </Alert>
        <Button
          className="w-full"
          onClick={() => {
            setStep("email");
            setFormError(null);
          }}
          size="input"
          type="button"
          variant="outline"
        >
          Use a different email
        </Button>
      </div>
    );
  }

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
              setFormError(null);
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
