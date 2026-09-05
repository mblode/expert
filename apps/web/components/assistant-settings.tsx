"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import type { RuntimeConfiguration, Seat } from "@/lib/seat";

/** Load on demand, so opening profile settings never overwrites an in-flight draft. */
export function AssistantSettings({ botId, seat }: { botId: string; seat: Seat }) {
  const [config, setConfig] = useState<RuntimeConfiguration>();
  const [instructions, setInstructions] = useState("");
  const [memory, setMemory] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [saved, setSaved] = useState(false);
  const run = async (operation: "read" | "replace" | "undo") => {
    setBusy(true);
    setProblem(undefined);
    setSaved(false);
    try {
      const current = await seat.configureAssistant(botId, {
        operation,
        ...(operation === "read" ? {} : { base_revision: config?.revision }),
        ...(operation === "replace"
          ? {
              instructions,
              memory: memory
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean),
            }
          : {}),
      });
      setConfig(current);
      setInstructions(current.instructions);
      setMemory(current.memory.join("\n"));
      setSaved(operation !== "read");
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Could not read the configuration.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="flex flex-col gap-4 border-border border-t pt-5"
      aria-label="Assistant instructions"
    >
      <div>
        <h3 className="font-medium text-sm">Instructions and memory</h3>
        <p className="text-muted-foreground text-sm">Changes take effect on the next message.</p>
      </div>
      {config ? (
        <>
          <Field>
            <FieldLabel htmlFor="assistant-instructions">Instructions</FieldLabel>
            <Textarea
              id="assistant-instructions"
              value={instructions}
              maxLength={10_000}
              rows={4}
              onChange={(event) => {
                setInstructions(event.target.value);
                setSaved(false);
              }}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="assistant-memory">Remember</FieldLabel>
            <Textarea
              id="assistant-memory"
              value={memory}
              rows={4}
              onChange={(event) => {
                setMemory(event.target.value);
                setSaved(false);
              }}
            />
            <FieldDescription>
              One fact per line, up to 50. Saving replaces the saved facts.
            </FieldDescription>
          </Field>
          {config.skills.length > 0 && (
            <div className="text-sm">
              <p className="font-medium">Procedures</p>
              {config.skills.map((skill) => (
                <details key={skill.id} className="py-1">
                  <summary>{skill.description}</summary>
                  <pre className="whitespace-pre-wrap text-muted-foreground text-xs">
                    {skill.markdown}
                  </pre>
                </details>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={busy} onClick={() => void run("replace")}>
              Save instructions
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy || config.revision === 0}
              onClick={() => void run("undo")}
            >
              Undo last change
            </Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => void run("read")}>
              Reload
            </Button>
          </div>
          <output className="text-muted-foreground text-xs">
            {saved ? "Saved. " : ""}Revision {config.revision}
          </output>
        </>
      ) : (
        <Button type="button" variant="outline" disabled={busy} onClick={() => void run("read")}>
          View instructions
        </Button>
      )}
      {problem && <FieldError>{problem}</FieldError>}
    </section>
  );
}
