import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { captureEvent } from "@/lib/posthog-client";

/**
 * Enter sends, shift-Enter breaks a line. While a turn is in flight the send
 * button becomes stop, because cancelling is the only useful thing to do then.
 */
export function ChatComposer({
  busy,
  disabled,
  onSend,
  onStop,
}: {
  busy: boolean;
  disabled: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}): React.ReactElement {
  const [text, setText] = useState("");

  const send = () => {
    const message = text.trim();
    if (!message || busy || disabled) {
      return;
    }
    setText("");
    captureEvent("chat_message_sent", { length: message.length });
    onSend(message);
  };

  return (
    <div className="flex items-end gap-2 border-t border-edge p-3">
      <div className="min-w-0 flex-1">
        <Textarea
          className="max-h-40 min-h-10 resize-none"
          disabled={disabled}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
          placeholder="Ask Eve to do something on the box…"
          rows={1}
          value={text}
        />
      </div>
      {busy ? (
        <Button onClick={onStop} type="button" variant="outline">
          Stop
        </Button>
      ) : (
        <Button disabled={disabled || !text.trim()} onClick={send} type="button">
          Send
        </Button>
      )}
    </div>
  );
}
