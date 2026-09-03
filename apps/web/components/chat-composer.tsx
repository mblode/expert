import { ArrowUpIcon, StopIcon } from "blode-icons-react";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { captureEvent } from "@/lib/posthog-client";

const MAX_ROWS_PX = 200;

/**
 * Enter sends, shift-Enter breaks a line. While a turn is in flight the send
 * button becomes stop, because cancelling is the only useful thing to do then.
 *
 * One field in a pill rather than a bordered box with a button beside it: the
 * composer is the only thing at the foot of the conversation, so its edge is
 * the affordance and a second frame around it is one divide too many.
 */
export function ChatComposer({
  botId,
  busy,
  disabled,
  onSend,
  onStop,
}: {
  botId: string;
  busy: boolean;
  disabled: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}): React.ReactElement {
  const [text, setText] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);

  const send = () => {
    const message = text.trim();
    if (!message || busy || disabled) {
      return;
    }
    setText("");
    if (field.current) {
      field.current.style.height = "auto";
    }
    captureEvent("chat_message_sent", { length: message.length });
    onSend(message);
  };

  // Grow with the text up to a ceiling, then scroll. A fixed single row hides
  // what you already wrote; an unbounded one pushes the conversation away.
  const resize = (element: HTMLTextAreaElement) => {
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, MAX_ROWS_PX)}px`;
  };

  return (
    <div className="px-3 pt-1 pb-3 sm:px-4 sm:pb-4">
      <div className="mx-auto flex w-full max-w-3xl items-end gap-2 rounded-3xl border border-border bg-card py-2 pr-2 pl-4 shadow-xs transition-colors focus-within:border-ring">
        <label className="sr-only" htmlFor="chat-composer">
          Message {botId}
        </label>
        <textarea
          className="max-h-[200px] min-h-9 flex-1 resize-none self-center bg-transparent py-1.5 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-50"
          disabled={disabled}
          id="chat-composer"
          onChange={(event) => {
            setText(event.target.value);
            resize(event.target);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
          placeholder={`Message ${botId}`}
          ref={field}
          rows={1}
          value={text}
        />
        {busy ? (
          <Button
            aria-label="Stop"
            className="rounded-full"
            onClick={onStop}
            size="icon-sm"
            type="button"
            variant="secondary"
          >
            <StopIcon />
          </Button>
        ) : (
          <Button
            aria-label="Send"
            className="rounded-full"
            disabled={disabled || !text.trim()}
            onClick={send}
            size="icon-sm"
            type="button"
          >
            <ArrowUpIcon />
          </Button>
        )}
      </div>
    </div>
  );
}
