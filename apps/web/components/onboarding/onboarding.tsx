"use client";

import { ArrowLeftIcon, CheckIcon } from "blode-icons-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { captureEvent, posthogForwardHeaders } from "@/lib/posthog-client";
import { onboardingSteps, onboardingTools } from "@/lib/onboarding";
import { cn } from "@/lib/utils";

import { ComputerArt, HandoffArt, MeetArt } from "./art";

const LAST = onboardingSteps.length - 1;

/** The card's button moves you on; the question's says whether you answered. */
function nextLabel(onQuestion: boolean, picked: number): string {
  if (!onQuestion) {
    return "Next";
  }
  return picked > 0 ? "Continue" : "Skip";
}

/**
 * The first run, between signing in and the workspace.
 *
 * Four cards on one column: three that say what this thing is, and one
 * question. It is a whole screen rather than a dialog over the workspace
 * because the workspace behind it would be answering the same questions
 * badly, and it appears exactly once: the server renders it while this
 * account has no `onboarding` row (`app/page.tsx`), so finishing means a
 * refresh rather than a second piece of client state deciding what to show.
 *
 * Nothing here reads the seat. The computer is already paired by the time the
 * session exists, so this screen has no provisioning to wait for, and it must
 * not become the place a hub outage is first reported: that is the workspace's
 * job, with a retry beside it.
 */
export function Onboarding(): React.ReactElement {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [tools, setTools] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  const current = onboardingSteps[step] ?? onboardingSteps[0];
  const onQuestion = step === LAST;

  const finish = async (answer: string[]) => {
    setSaving(true);
    setFailed(false);
    try {
      const response = await fetch("/api/onboarding", {
        body: JSON.stringify({ tools: answer }),
        headers: { "content-type": "application/json", ...posthogForwardHeaders() },
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(String(response.status));
      }
      // The gate is a row in the database, so the server has to look again.
      router.refresh();
    } catch {
      // Letting them through anyway would bounce straight back here on the
      // next render, which reads as the button doing nothing.
      setFailed(true);
      setSaving(false);
    }
  };

  const advance = () => {
    if (!onQuestion) {
      captureEvent("onboarding_step_completed", { step });
      setStep(step + 1);
      return;
    }
    void finish(tools);
  };

  return (
    <div className="marketing flex h-full flex-col overflow-y-auto">
      {/* Header, cards and button share one column: the flow was drawn for a
          phone, and a wall-wide Next button on a laptop reads as a banner. */}
      <header className="mx-auto flex h-16 w-full max-w-md shrink-0 items-center justify-between px-2">
        {step > 0 ? (
          <Button
            aria-label="Back"
            className="rounded-full bg-white/10 text-white hover:bg-white/20"
            onClick={() => setStep(step - 1)}
            size="icon"
            type="button"
            variant="ghost"
          >
            <ArrowLeftIcon />
          </Button>
        ) : (
          <span />
        )}
        {/* One way out, on the cards but not on the question: the question's
            own button already says Skip when nothing is picked, and two Skips
            on one screen is a choice about which Skip. */}
        {onQuestion ? (
          <span />
        ) : (
          <Button
            className="rounded-full text-white/60 hover:bg-white/10 hover:text-white"
            disabled={saving}
            onClick={() => void finish([])}
            type="button"
            variant="ghost"
          >
            Skip
          </Button>
        )}
      </header>

      <main className="flex min-h-0 flex-1 flex-col px-6 pb-4" key={step}>
        <div className="fade-in slide-in-from-bottom-2 mx-auto w-full max-w-md animate-in text-center duration-500">
          <h1 className="text-balance font-semibold text-3xl tracking-tight sm:text-4xl">
            {current.title}
          </h1>
          <p className="mx-auto mt-4 max-w-[46ch] text-pretty text-white/60">{current.body}</p>
        </div>

        <div className="fade-in mx-auto flex w-full max-w-md flex-1 animate-in items-center justify-center py-10 duration-700">
          {current.art === "meet" && <MeetArt />}
          {current.art === "computer" && <ComputerArt />}
          {current.art === "handoff" && <HandoffArt />}
          {current.art === "tools" && <ToolPicker onChange={setTools} picked={tools} />}
        </div>
      </main>

      <footer className="mx-auto w-full max-w-md shrink-0 px-6 pt-2 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        {failed && (
          <p className="mb-3 text-center text-sm text-white/60">
            That did not save. Check your connection and try again.
          </p>
        )}
        <div aria-hidden className="mb-5 flex items-center justify-center gap-1.5">
          {onboardingSteps.map((one, index) => (
            <span
              className={cn(
                "h-1.5 rounded-full transition-all duration-300",
                index === step ? "w-5 bg-white" : "w-1.5 bg-white/25",
              )}
              key={one.title}
            />
          ))}
        </div>
        <Button
          className="h-14 w-full rounded-full text-base"
          disabled={saving}
          loading={saving}
          onClick={advance}
          type="button"
        >
          {nextLabel(onQuestion, tools.length)}
        </Button>
      </footer>
    </div>
  );
}

/**
 * The one question, as a grid of names.
 *
 * Multi-select with no minimum, because the honest answer for a lot of people
 * is none of these, and a required pick would make the answer worthless for
 * exactly the accounts it is meant to help.
 */
function ToolPicker({
  onChange,
  picked,
}: {
  onChange: (tools: string[]) => void;
  picked: string[];
}): React.ReactElement {
  return (
    <ul className="grid w-full grid-cols-3 gap-2.5">
      {onboardingTools.map((tool) => {
        const on = picked.includes(tool.id);
        return (
          <li key={tool.id}>
            <button
              aria-pressed={on}
              className={cn(
                "relative flex h-20 w-full items-center justify-center rounded-2xl border px-2 text-center text-sm transition-colors",
                on
                  ? "border-white/70 bg-white/15 text-white"
                  : "border-white/12 text-white/70 hover:border-white/30 hover:bg-white/5",
              )}
              onClick={() =>
                onChange(on ? picked.filter((id) => id !== tool.id) : [...picked, tool.id])
              }
              type="button"
            >
              {tool.label}
              {on && (
                <span className="absolute top-1.5 right-1.5 flex size-4 items-center justify-center rounded-full bg-white text-black">
                  <CheckIcon className="size-3" />
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
