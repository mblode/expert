"use client";

import { useState } from "react";
import { isPossiblePhoneNumber } from "react-phone-number-input";
import { LoginForm } from "./login-form";
import { Button } from "./ui/button";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "./ui/input-otp";
import { PhoneInput } from "./ui/phone-input";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "./ui/field";

export function WhatsAppLoginForm(props: React.ComponentProps<typeof LoginForm>) {
  const [email, setEmail] = useState(false);
  const [phone, setPhone] = useState("");
  const [phoneInvalid, setPhoneInvalid] = useState(false);
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  if (email)
    return (
      <div className="flex flex-col gap-5">
        <LoginForm {...props} />
        <Button className="w-full" variant="link" onClick={() => setEmail(false)}>
          Use WhatsApp instead
        </Button>
      </div>
    );
  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={async (event) => {
        event.preventDefault();
        if (pending) return;
        setError(undefined);
        if (!isPossiblePhoneNumber(phone)) {
          setPhoneInvalid(true);
          return;
        }
        setPending(true);
        try {
          const response = await fetch("/api/auth/sign-in/whatsapp", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ phone, code }),
          });
          if (!response.ok) {
            const result = await response.json();
            setError(result.message ?? "Could not sign in. Request a new code and try again.");
            setPending(false);
            return;
          }
          window.location.assign(props.next ?? "/");
        } catch {
          setError("Could not reach Expert. Please try again.");
          setPending(false);
        }
      }}
    >
      <section
        aria-labelledby="get-code-title"
        className="flex flex-col gap-3 rounded-xl border border-border p-4"
      >
        <div className="space-y-1">
          <h2 id="get-code-title" className="text-sm font-medium">
            Need a sign-in code?
          </h2>
          <p className="text-sm text-muted-foreground">
            Open your private chat with Vibey and send{" "}
            <strong className="text-foreground">sign in</strong>. Then return here with the code.
          </p>
        </div>
        <Button
          render={
            <a
              aria-label="Get a code in WhatsApp"
              href="https://wa.me/message/O7KCFC6HSFCPM1"
              target="_blank"
              rel="noreferrer"
            />
          }
          variant="outline"
          size="input"
        >
          Get a code in WhatsApp
        </Button>
      </section>
      <FieldGroup>
        <Field data-invalid={phoneInvalid || undefined}>
          <FieldLabel htmlFor="whatsapp-phone">WhatsApp number</FieldLabel>
          <PhoneInput
            id="whatsapp-phone"
            name="phone"
            autoComplete="tel"
            defaultCountry="AU"
            placeholder="Phone number"
            value={phone}
            onChange={(value) => {
              setPhone(value);
              setPhoneInvalid(false);
            }}
            aria-invalid={phoneInvalid || undefined}
            aria-describedby={phoneInvalid ? "whatsapp-phone-error" : "whatsapp-phone-description"}
            required
            disabled={pending}
          />
          <FieldDescription id="whatsapp-phone-description">
            Use the number you messaged Vibey from.
          </FieldDescription>
          {phoneInvalid && (
            <FieldError id="whatsapp-phone-error">
              Enter your WhatsApp number and select its country code.
            </FieldError>
          )}
        </Field>
        <Field>
          <FieldLabel htmlFor="whatsapp-code">Sign-in code</FieldLabel>
          <InputOTP
            id="whatsapp-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            pattern="[0-9]*"
            containerClassName="w-full"
            aria-describedby="whatsapp-code-description"
            value={code}
            onChange={(value) => {
              setCode(value);
              setError(undefined);
            }}
            required
            disabled={pending}
          >
            <InputOTPGroup className="w-full">
              {Array.from({ length: 6 }, (_, index) => (
                <InputOTPSlot className="min-w-0 flex-1" index={index} key={index} />
              ))}
            </InputOTPGroup>
          </InputOTP>
          <FieldDescription id="whatsapp-code-description">
            Enter the 6-digit code from Vibey. It expires after 5 minutes.
          </FieldDescription>
        </Field>
      </FieldGroup>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button
        type="submit"
        loading={pending}
        disabled={!phone.trim() || code.length !== 6}
        size="input"
      >
        {pending ? "Signing in…" : "Sign in"}
      </Button>
      <Button type="button" variant="link" disabled={pending} onClick={() => setEmail(true)}>
        Use email instead
      </Button>
    </form>
  );
}
