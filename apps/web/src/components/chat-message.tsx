import type {
  EveDynamicToolPart,
  EveMessage,
  EveMessageInputRequest,
  EveMessagePart,
} from "eve/react";

import { Markdown } from "./markdown";

/** The client's reply to a human-in-the-loop input request. */
export type Answer = { optionId?: string; requestId: string; text?: string };

const MAX_SUMMARY = 40;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const truncate = (text: string): string =>
  text.length > MAX_SUMMARY ? `${text.slice(0, MAX_SUMMARY - 1)}…` : text;

/**
 * The one argument that tells two calls of the same tool apart. A turn calls
 * `computer` a dozen times; without this the chain reads as a dozen identical
 * rows. Ordered by how much of this agent's traffic each shape covers.
 */
function summarizeToolInput(input: unknown): string | null {
  if (!isRecord(input)) return null;

  const { actions } = input;
  if (Array.isArray(actions) && actions.length > 0) {
    const first = isRecord(actions[0]) ? String(actions[0].type ?? "") : "";
    if (!first) return null;
    return actions.length > 1 ? `${first} +${actions.length - 1}` : first;
  }

  const { argv } = input;
  if (Array.isArray(argv)) return truncate(argv.join(" "));

  for (const key of ["path", "skill", "query", "search", "title", "name"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return truncate(value.trim());
  }
  return null;
}

const toolLabel = (part: EveDynamicToolPart): string => {
  const name = part.toolMetadata?.eve?.name ?? part.toolName;
  const summary = summarizeToolInput(part.input);
  return summary ? `${name} · ${summary}` : name;
};

const isRunning = (part: EveDynamicToolPart): boolean =>
  part.state === "input-streaming" ||
  part.state === "input-available" ||
  part.state === "approval-requested";

/**
 * Screenshots the `computer` tool brings back. They ride inside the tool's own
 * result rather than as message `file` parts, so they are pulled out here — the
 * picture is the whole point of the call.
 */
function toolImages(part: EveDynamicToolPart): string[] {
  if (part.state !== "output-available" || !isRecord(part.output)) return [];
  const images: string[] = [];
  const push = (data: unknown, mediaType: unknown) => {
    if (typeof data === "string" && data.length > 0) {
      images.push(`data:${typeof mediaType === "string" ? mediaType : "image/png"};base64,${data}`);
    }
  };
  const { results } = part.output;
  if (Array.isArray(results)) {
    for (const result of results) {
      if (isRecord(result)) push(result.image_b64, result.media_type);
    }
  }
  push(part.output.screenshot_b64, "image/png");
  return images;
}

/** A run of tool calls, collapsed into one chain rather than a row per call. */
function ToolSteps({ parts }: { parts: EveDynamicToolPart[] }): React.ReactElement {
  const running = parts.some(isRunning);
  return (
    <details className="rounded-lg border border-edge bg-panel/60 text-xs">
      <summary className="cursor-pointer select-none px-3 py-2 text-mute marker:text-mute">
        {running ? "Thinking…" : "Thinking"}
        <span className="ml-1.5 opacity-70">
          {parts.length} {parts.length === 1 ? "step" : "steps"}
        </span>
      </summary>
      <ol className="space-y-2 border-t border-edge px-3 py-2">
        {parts.map((part) => {
          const images = toolImages(part);
          return (
            <li className="space-y-1.5" key={part.toolCallId}>
              <div className="flex items-baseline gap-2">
                <span
                  className={`size-1.5 shrink-0 translate-y-[-1px] rounded-full ${
                    part.state === "output-error"
                      ? "bg-red-400"
                      : isRunning(part)
                        ? "animate-pulse bg-amber-400"
                        : "bg-emerald-400"
                  }`}
                />
                <span className="min-w-0 break-words font-mono text-mute">
                  {part.state === "output-error" ? `Failed: ${toolLabel(part)}` : toolLabel(part)}
                </span>
              </div>
              {images.map((src) => (
                <img
                  alt="Screen"
                  className="max-h-56 w-auto max-w-full rounded-md border border-edge"
                  key={src.slice(-48)}
                  src={src}
                />
              ))}
            </li>
          );
        })}
      </ol>
    </details>
  );
}

/**
 * eve marks the destructive choice itself; guessing which of "approve" and
 * "cancel" is the dangerous one gets it backwards for a session limit.
 */
const OPTION_CLASS = {
  danger: "bg-red-500 text-white hover:bg-red-400",
  primary: "bg-accent text-ink hover:opacity-90",
  default: "border border-edge hover:border-accent",
} as const;

/**
 * The card for a parked turn: an approval before a tool changes something, or
 * a question the model is asking. Both arrive on the same `input.requested`
 * protocol and are told apart by `kind`.
 */
function InputRequestCard({
  disabled,
  onAnswer,
  part,
  request,
}: {
  disabled: boolean;
  onAnswer: (answer: Answer) => void;
  part: EveDynamicToolPart;
  request: EveMessageInputRequest;
}): React.ReactElement {
  const summary = summarizeToolInput(part.input);
  const isApproval = request.kind !== "question";

  return (
    <div
      aria-label={isApproval ? "Approval required" : "Question"}
      className={`rounded-lg border border-edge bg-panel p-3 ${disabled ? "pointer-events-none opacity-60" : ""}`}
      role="group"
    >
      {isApproval && (
        <p className="pb-1 text-xs text-mute">
          <span className="font-medium text-white">{part.toolMetadata?.eve?.name ?? part.toolName}</span>
          {summary && <span className="ml-1.5">{summary}</span>}
        </p>
      )}
      <p className="text-sm leading-6">{request.prompt}</p>
      <div className="flex flex-wrap gap-2 pt-3">
        {(request.options ?? []).map((option) => (
          <button
            className={`rounded-md px-2.5 py-1 text-xs font-medium ${OPTION_CLASS[option.style ?? "default"]}`}
            disabled={disabled}
            key={option.id}
            onClick={() => onAnswer({ optionId: option.id, requestId: request.requestId })}
            title={option.description}
            type="button"
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function MessagePart({
  disabled,
  onAnswer,
  part,
  role,
}: {
  disabled: boolean;
  onAnswer: (answer: Answer) => void;
  part: EveMessagePart;
  role: EveMessage["role"];
}): React.ReactElement | null {
  if (part.type === "text") {
    if (!part.text) return null;
    if (role === "user") {
      return (
        <p className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-2xl bg-panel px-3 py-2 text-sm">
          {part.text}
        </p>
      );
    }
    return <Markdown text={part.text} />;
  }

  if (part.type === "file") {
    if (!part.url) return null;
    return part.mediaType.startsWith("image/") ? (
      <img
        alt={part.filename ?? "Attachment"}
        className="max-h-64 w-auto max-w-full rounded-lg border border-edge"
        src={part.url}
      />
    ) : (
      <a className="text-sm text-accent underline" href={part.url} rel="noreferrer" target="_blank">
        {part.filename ?? "Attachment"}
      </a>
    );
  }

  if (part.type === "dynamic-tool") {
    const request = part.toolMetadata?.eve?.inputRequest;
    // Regular tool calls are grouped into the chain before reaching here.
    if (!request) return null;
    const response = part.toolMetadata?.eve?.inputResponse;
    if (response) {
      const chosen =
        request.options?.find((option) => option.id === response.optionId)?.label ??
        response.text ??
        "Answered";
      return <p className="text-xs text-mute">You answered: {chosen}</p>;
    }
    return (
      <InputRequestCard disabled={disabled} onAnswer={onAnswer} part={part} request={request} />
    );
  }

  if (part.type === "authorization") {
    return (
      <p className="rounded-lg border border-edge bg-panel p-3 text-sm">
        {part.state === "completed"
          ? `${part.displayName} authorization ${part.outcome}`
          : part.description}
        {part.state === "required" && part.authorization?.url && (
          <a
            className="ml-2 text-accent underline"
            href={part.authorization.url}
            rel="noreferrer"
            target="_blank"
          >
            Sign in
          </a>
        )}
      </p>
    );
  }

  return null;
}

type Item =
  | { kind: "single"; key: string; part: EveMessagePart }
  | { kind: "tools"; key: string; parts: EveDynamicToolPart[] };

const isPlainTool = (part: EveMessagePart): part is EveDynamicToolPart =>
  part.type === "dynamic-tool" && !part.toolMetadata?.eve?.inputRequest;

/**
 * Parts that render nothing must not split a run of tool calls into separate
 * chains. `step-start` is the common one: a turn that loads a skill and then
 * uses it has a step boundary between the two calls, and the chain fragments
 * into a stack of one-step "Thinking" boxes without this.
 */
const isInvisible = (part: EveMessagePart): boolean =>
  part.type === "step-start" || (part.type === "text" && !part.text);

function buildItems(parts: readonly EveMessagePart[]): Item[] {
  const items: Item[] = [];
  let run: EveDynamicToolPart[] = [];
  let runStart = 0;

  const flush = () => {
    if (run.length > 0) {
      items.push({ key: `tools-${runStart}`, kind: "tools", parts: run });
      run = [];
    }
  };

  for (const [index, part] of parts.entries()) {
    if (isPlainTool(part)) {
      if (run.length === 0) runStart = index;
      run.push(part);
      continue;
    }
    if (isInvisible(part)) continue;
    flush();
    items.push({ key: `part-${index}`, kind: "single", part });
  }
  flush();
  return items;
}

export function ChatMessage({
  disabled,
  message,
  onAnswer,
}: {
  disabled: boolean;
  message: EveMessage;
  onAnswer: (answer: Answer) => void;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-2">
      {buildItems(message.parts).map((item) =>
        item.kind === "tools" ? (
          <ToolSteps key={item.key} parts={item.parts} />
        ) : (
          <MessagePart
            disabled={disabled}
            key={item.key}
            onAnswer={onAnswer}
            part={item.part}
            role={message.role}
          />
        ),
      )}
    </div>
  );
}
