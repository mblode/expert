"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

type Status = { state: string; phone: string | null; expired: boolean } | null;
export function ConnectWhatsApp() {
  const [status, setStatus] = useState<Status>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [url, setUrl] = useState("");
  const [actionError, setActionError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [pending, setPending] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (pending || status?.state === "active") return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        const response = await fetch("/api/whatsapp/connection", {
          cache: "no-store",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
        });
        if (!response.ok) throw new Error("Could not check your connection.");
        const body = await response.json();
        if (controller.signal.aborted) return;
        setStatus(body.connection);
        setAvailable(body.available);
        setLoadError("");
        if (body.connection?.state === "active") return;
      } catch {
        if (controller.signal.aborted) return;
        setLoadError("Could not check WhatsApp. Check your internet connection and try again.");
      }
      // A completed request schedules the next. Slow responses cannot race a
      // later poll, and starting a mutation aborts the previous status request.
      if (!controller.signal.aborted) timer = setTimeout(() => void check(), 5000);
    };
    void check();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- revision is the explicit retry trigger
  }, [pending, revision, status?.state]);

  const act = async (action: string) => {
    if (pending) return;
    setPending(true);
    setActionError("");
    try {
      const response = await fetch("/api/whatsapp/connection", {
        method: "POST",
        signal: AbortSignal.timeout(45_000),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, phone: status?.phone }),
      });
      const body = await response.json();
      if (!response.ok) {
        setActionError(body.error ?? "Could not connect WhatsApp. Try again.");
        return;
      }
      if (body.url) {
        setUrl(body.url);
        setStatus(null);
      }
      if (body.connected) setStatus((previous) => previous && { ...previous, state: "active" });
      setLoadError("");
    } catch {
      setActionError(
        "Could not reach WhatsApp setup. Check your connection and retry to check it safely.",
      );
    } finally {
      setPending(false);
      setRevision((value) => value + 1);
    }
  };

  return (
    <section className="min-h-48 space-y-4" aria-labelledby="whatsapp-setup-title">
      <h2 id="whatsapp-setup-title" className="text-lg font-medium">
        Connect WhatsApp
      </h2>
      <div aria-live="polite" className="space-y-4">
        {status?.state === "active" ? (
          <p>
            WhatsApp connected: +{status.phone}. Message Expert from this number to talk to your
            assistant.
          </p>
        ) : available === null ? (
          <p className="text-muted-foreground">Checking your WhatsApp connection…</p>
        ) : status?.phone && !status.expired ? (
          <>
            <p className="text-muted-foreground">This number sent your connection code:</p>
            <p className="text-xl font-medium tabular-nums">+{status.phone}</p>
            <p className="text-sm text-muted-foreground">
              Connecting lets this number chat with your private assistant and receive its replies.
              Only connect your own number.
            </p>
            <Button
              className="min-h-12"
              aria-label="Connect this number"
              loading={pending}
              onClick={() => void act("confirm")}
            >
              Connect this number
            </Button>
            {status.state === "pending" && (
              <Button
                className="min-h-12"
                variant="ghost"
                disabled={pending}
                onClick={() => void act("start")}
              >
                Use a different number
              </Button>
            )}
            {status.state === "binding" && (
              <p className="text-sm text-muted-foreground">
                Setup started. Retry with this number to finish the connection.
              </p>
            )}
          </>
        ) : (
          <>
            <p className="text-muted-foreground">
              Chat with Expert from the WhatsApp account you already use.
            </p>
            {available ? (
              url && !status?.expired ? (
                <>
                  <a
                    className="inline-flex min-h-12 items-center underline underline-offset-4"
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open WhatsApp and send the code
                  </a>
                  <p className="text-sm text-muted-foreground">
                    Then return here to connect your number. Your code lasts 15 minutes.
                  </p>
                  <Button
                    className="min-h-12"
                    aria-label="Get a new code"
                    variant="ghost"
                    loading={pending}
                    onClick={() => void act("start")}
                  >
                    Get a new code
                  </Button>
                </>
              ) : (
                <Button
                  className="min-h-12"
                  aria-label="Get connection code"
                  loading={pending}
                  onClick={() => void act("start")}
                >
                  Get connection code
                </Button>
              )
            ) : (
              <p className="text-sm text-muted-foreground">
                WhatsApp setup is being prepared. You can use your workspace now.
              </p>
            )}
            {status?.expired && (
              <p className="text-sm">Your code expired. Get a new one to continue.</p>
            )}
          </>
        )}
      </div>
      {(actionError || loadError) && (
        <div role="alert" className="space-y-2">
          <p className="text-sm text-destructive">{actionError || loadError}</p>
          {loadError && (
            <Button
              className="min-h-12"
              variant="outline"
              onClick={() => setRevision((value) => value + 1)}
            >
              Retry connection check
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
