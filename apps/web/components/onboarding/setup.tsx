"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConnectWhatsApp } from "./whatsapp";

/** A claim is an explicit action, never a side effect of a link preview. */
export function ClaimComputer({ token, phone = false }: { token: string; phone?: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const claim = async () => {
    if (pending) return;
    setPending(true);
    setMessage("");
    try {
      const response = await fetch("/api/enrollment", {
        method: "POST",
        signal: AbortSignal.timeout(45_000),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: phone ? "claim-phone" : "claim", token }),
      });
      const body = await response.json();
      if (!response.ok) {
        setMessage(body.error ?? "Could not set up your computer. Try again.");
        setPending(false);
        return;
      }
      router.replace("/start");
      router.refresh();
    } catch {
      setMessage(
        "Could not reach setup. Check your connection and try again. Your invitation is still saved.",
      );
      setPending(false);
    }
  };
  return (
    <div className="space-y-4">
      <p className="text-muted-foreground">
        {phone
          ? "Open the private workspace for your WhatsApp assistant."
          : "Your assistant has a private computer. Claim it to start chatting and connect WhatsApp."}
      </p>
      {message && (
        <p role="alert" className="text-sm text-destructive">
          {message}
        </p>
      )}
      <Button
        className="min-h-12"
        aria-label={phone ? "Open my workspace" : "Create my workspace"}
        loading={pending}
        onClick={() => void claim()}
      >
        {phone ? "Open my workspace" : "Create my workspace"}
      </Button>
    </div>
  );
}

export function ComputerInvitation() {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [url, setUrl] = useState("");
  return (
    <form
      className="space-y-4"
      onSubmit={async (event) => {
        event.preventDefault();
        if (pending) return;
        const form = event.currentTarget;
        const fields = Object.fromEntries(new FormData(form));
        setPending(true);
        setMessage("");
        setUrl("");
        try {
          const response = await fetch("/api/enrollment", {
            method: "POST",
            signal: AbortSignal.timeout(45_000),
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...fields, action: "invite" }),
          });
          const body = await response.json();
          if (!response.ok) {
            setMessage(body.error ?? "Could not create the invitation. Try again.");
            return;
          }
          setUrl(body.url);
          form.reset();
        } catch {
          setMessage(
            "Could not reach setup. Check your connection and try again. Your details are still here.",
          );
        } finally {
          setPending(false);
        }
      }}
    >
      <p className="text-sm text-muted-foreground">
        Invite someone to a prepared, private computer. The invitation works only for their email
        and expires in seven days.
      </p>
      <div className="space-y-1 text-sm">
        <label htmlFor="enrollment-email">Recipient email</label>
        <Input id="enrollment-email" name="email" type="email" autoComplete="off" required />
      </div>
      <div className="space-y-1 text-sm">
        <label htmlFor="enrollment-label">Workspace name</label>
        <Input id="enrollment-label" name="label" maxLength={64} required />
      </div>
      <div className="space-y-1 text-sm">
        <label htmlFor="enrollment-hubUrl">Computer address</label>
        <Input
          id="enrollment-hubUrl"
          name="hubUrl"
          type="url"
          placeholder="https://your-computer.fly.dev"
          required
        />
      </div>
      <div className="space-y-1 text-sm">
        <label htmlFor="enrollment-setupCode">Setup credential</label>
        <Input
          id="enrollment-setupCode"
          name="setupCode"
          type="password"
          autoComplete="off"
          minLength={16}
          maxLength={512}
          required
        />
      </div>
      {message && (
        <p role="alert" className="text-sm text-destructive">
          {message}
        </p>
      )}
      <Button className="min-h-12" aria-label="Create invitation" type="submit" loading={pending}>
        Create invitation
      </Button>
      {url && (
        <output className="block space-y-2">
          <p className="text-sm">Invitation ready. Share this link with the recipient.</p>
          <Input
            aria-label="Invitation link"
            value={url}
            readOnly
            onFocus={(event) => event.target.select()}
          />
        </output>
      )}
    </form>
  );
}

export function SetupReady() {
  return (
    <div className="space-y-4">
      <p>Your private computer is ready. Start a conversation here or connect your WhatsApp.</p>
      <div className="flex flex-wrap gap-3">
        <Link className="inline-flex min-h-12 items-center underline underline-offset-4" href="/">
          Open workspace
        </Link>
      </div>
      <ConnectWhatsApp />
    </div>
  );
}
