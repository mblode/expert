import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import type { Seat } from "../lib/seat";

/**
 * The box's clipboard, both ways. It is the only reliable channel for anything
 * a person cannot type, a long token, a 2FA code pasted from a phone.
 */
export function ClipboardPanel({
  display,
  readable = true,
  seat,
}: {
  display: number;
  /** A guest seat may paste in and never read out, so the invite hides Read. */
  readable?: boolean;
  seat: Seat;
}): React.ReactElement {
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const act = async (label: string, call: () => Promise<unknown>) => {
    setBusy(true);
    setNote(null);
    try {
      const result = await call();
      if (result && typeof result === "object" && "text" in result) {
        setText(String((result as { text: unknown }).text ?? ""));
      }
      setNote(label);
    } catch (error) {
      setNote(error instanceof Error ? error.message : "clipboard failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 border-t border-border p-3">
      <Field>
        <FieldLabel htmlFor="clip">Clipboard</FieldLabel>
        <Textarea
          className="h-20 font-mono text-xs"
          id="clip"
          onChange={(event) => setText(event.target.value)}
          placeholder={
            readable
              ? "Read from the box, or paste something in and send it."
              : "Paste something in and send it to the box."
          }
          value={text}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        {readable && (
          <Button
            disabled={busy}
            onClick={() => void act("Read from the box.", () => seat.clipboardGet(display))}
            size="xs"
            type="button"
            variant="outline"
          >
            Read
          </Button>
        )}
        <Button
          disabled={busy || !text}
          onClick={() => void act("Sent to the box.", () => seat.clipboardSet(text, display))}
          size="xs"
          type="button"
          variant="outline"
        >
          Send
        </Button>
        {note && <span className="text-xs text-muted-foreground">{note}</span>}
      </div>
    </div>
  );
}
