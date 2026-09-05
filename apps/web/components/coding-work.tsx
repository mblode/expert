"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { codingRequestId } from "@/lib/coding-request";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { CodingSession, Seat } from "@/lib/seat";

/** Provider results are data, including their links. */
function httpsLink(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function CodingWork({
  seat,
  display,
  sourceConversation,
}: {
  seat: Seat;
  display: number;
  sourceConversation?: string;
}) {
  const [sessions, setSessions] = useState<CodingSession[]>([]);
  const [repo, setRepo] = useState("");
  const [prompt, setPrompt] = useState("");
  const [autoPr, setAutoPr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // A timeout keeps the same launch identity; an edited brief is a new request.
  const intent = useRef<{ key: string; payload: string; storageKey: string } | null>(null);
  const load = useCallback(async () => {
    const { conversations } = await seat.conversations(display);
    const coding = conversations.filter((c) => c.route.kind === "code");
    const results = await Promise.allSettled(coding.map((c) => seat.refreshCoding(c.id)));
    return results.map((result, index) => ({
      id: coding[index]!.id,
      session: result.status === "fulfilled" ? result.value : undefined,
    }));
  }, [display, seat]);
  useEffect(() => {
    let live = true;
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        const rows = await load();
        if (live) {
          setSessions((previous) =>
            rows.flatMap((row) => {
              const session = row.session ?? previous.find((old) => old.conversation_id === row.id);
              return session ? [session] : [];
            }),
          );
          setProblem(
            rows.some((row) => !row.session)
              ? "Some sessions could not refresh. Showing their last known status."
              : null,
          );
        }
      } catch (error) {
        if (live)
          setProblem(error instanceof Error ? error.message : "Could not read coding work.");
      } finally {
        running = false;
        if (live) setLoading(false);
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 15_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [load]);
  useEffect(() => {
    if (!sourceConversation) return;
    let live = true;
    void seat
      .conversations(display)
      .then(({ conversations }) => {
        const source = conversations.find((row) => row.id === sourceConversation);
        if (!source) throw new Error("Original conversation is unavailable.");
        return seat.occurrences(source.id, String(Math.max(0, source.last_seq - 100)));
      })
      .then(({ entries }) => {
        const request = entries.findLast((entry) => entry.kind === "human" && entry.text)?.text;
        if (live && request) setPrompt((current) => current || request);
      })
      .catch(() => {
        if (live) setProblem("Could not load the original request. You can enter a brief below.");
      });
    return () => {
      live = false;
    };
  }, [seat, display, sourceConversation]);
  const start = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const payload = JSON.stringify({ display, repo, prompt, autoPr });
    try {
      if (intent.current?.payload !== payload) {
        const saved = await codingRequestId(
          sessionStorage,
          `${seat.hubUrl}:${display}:${sourceConversation ?? ""}`,
          payload,
        );
        intent.current = { key: saved.id, payload, storageKey: saved.storageKey };
      }
      const session = await seat.startCoding({
        display,
        repo,
        prompt,
        auto_create_pr: autoPr,
        request_id: intent.current.key,
        source_conversation_id: sourceConversation,
      });
      setSessions((rows) => [
        session,
        ...rows.filter((row) => row.conversation_id !== session.conversation_id),
      ]);
      setPrompt("");
      sessionStorage.removeItem(intent.current.storageKey);
      intent.current = null;
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Could not start this coding session.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="mx-auto w-full max-w-3xl space-y-6 p-5">
      <header>
        <h1 className="font-semibold text-xl">Coding work</h1>
        <p className="mt-1 text-muted-foreground text-sm">
          Start a cloud session, then open its work to review or continue the conversation.
        </p>
      </header>
      {problem && (
        <p role="alert" className="text-destructive text-sm">
          {problem}
        </p>
      )}
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
      >
        <label htmlFor="coding-repo" className="block text-sm">
          GitHub repository
          <Input
            id="coding-repo"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder="https://github.com/owner/repository"
            required
            disabled={busy}
          />
        </label>
        <label htmlFor="coding-prompt" className="block text-sm">
          What would you like changed?
          <Textarea
            id="coding-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            required
            disabled={busy}
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={autoPr}
            onChange={(e) => setAutoPr(e.target.checked)}
            disabled={busy}
          />
          Open a pull request when ready
        </label>
        <p className="text-muted-foreground text-xs">
          This sends the brief and selected repository to your configured coding provider and uses
          its credits.
        </p>
        <Button type="submit" disabled={busy || !repo.trim() || !prompt.trim()}>
          Start coding session
        </Button>
      </form>
      {loading && <p className="text-muted-foreground text-sm">Loading coding work…</p>}
      {!loading && sessions.length === 0 && (
        <p className="text-muted-foreground text-sm">No coding sessions yet.</p>
      )}
      <ul className="space-y-5">
        {sessions.map((session) => (
          <li key={session.conversation_id} className="space-y-2 border-border border-t pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="break-all font-medium text-sm">{session.repo}</h2>
              <span className="text-muted-foreground text-xs">
                {
                  {
                    pending: "Queued",
                    active: "In progress",
                    awaitingInput: "Needs you",
                    complete: "Result available",
                    error: "Failed",
                    stale: "Stopped",
                  }[session.state]
                }
              </span>
            </div>
            {session.branch && (
              <p className="break-all text-muted-foreground text-xs">{session.branch}</p>
            )}
            {session.summary && <p className="whitespace-pre-wrap text-sm">{session.summary}</p>}
            <div className="flex gap-4 text-sm">
              {httpsLink(session.url) && (
                <a
                  className="underline"
                  href={httpsLink(session.url)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open coding session
                </a>
              )}
              {httpsLink(session.pr_url) && (
                <a
                  className="underline"
                  href={httpsLink(session.pr_url)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Review pull request
                </a>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
