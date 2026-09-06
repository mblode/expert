import {
  BoltIcon,
  ConsoleSparkleIcon,
  CursorClickIcon,
  FileEditIcon,
  FileTextIcon,
  Hand5FingerIcon,
  KeyboardIcon,
  KeyIcon,
  MouseScrollDownIcon,
  ScreenCaptureIcon,
  SearchIcon,
  ShieldCheckIcon,
  SquareCursorIcon,
} from "blode-icons-react";
import { useState } from "react";
import type {
  EveDynamicToolPart,
  EveMessage,
  EveMessageInputRequest,
  EveMessagePart,
} from "eve/react";

import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { Message, MessageContent } from "@/components/ui/message";
import {
  ThinkingStep,
  ThinkingStepDetails,
  ThinkingStepImage,
  ThinkingSteps,
  ThinkingStepsContent,
  ThinkingStepsHeader,
} from "@/components/ui/thinking-steps";
import type { StepStatus } from "@/components/ui/thinking-steps";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Markdown } from "./markdown";

/** The client's reply to a human-in-the-loop input request. */
export interface Answer {
  optionId?: string;
  requestId: string;
  text?: string;
}

const MAX_SUMMARY = 40;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const truncate = (text: string): string =>
  text.length > MAX_SUMMARY ? `${text.slice(0, MAX_SUMMARY - 1)}…` : text;

/**
 * URLs here come from the agent, and the agent reads web pages. Only schemes a
 * browser can render safely are allowed into `href`/`src`; a `javascript:`
 * attachment is a click-to-XSS with the seat token on the other side.
 */
export function safeUrl(url: string | undefined, allowImage = false): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    const { protocol } = new URL(url, "https://x/");
    if (protocol === "https:" || protocol === "http:" || protocol === "blob:") {
      return url;
    }
    if (allowImage && protocol === "data:" && /^data:image\//i.test(url)) {
      return url;
    }
  } catch {
    // unparseable
  }
  return undefined;
}

/** The first `computer` action in a batch, which is what the step is really doing. */
function firstAction(input: unknown): Record<string, unknown> | null {
  if (!isRecord(input) || !Array.isArray(input.actions)) {
    return null;
  }
  const [first] = input.actions;
  return isRecord(first) ? first : null;
}

/**
 * The one argument that tells two calls of the same tool apart. A turn calls
 * `computer` a dozen times; without this the chain reads as a dozen identical
 * rows. Ordered by how much of this agent's traffic each shape covers.
 */
function summarizeToolInput(input: unknown): string | null {
  if (!isRecord(input)) {
    return null;
  }

  const { actions } = input;
  if (Array.isArray(actions) && actions.length > 0) {
    const first = isRecord(actions[0]) ? String(actions[0].type ?? "") : "";
    if (!first) {
      return null;
    }
    return actions.length > 1 ? `${first} +${actions.length - 1}` : first;
  }

  const { argv } = input;
  if (Array.isArray(argv)) {
    return truncate(argv.join(" "));
  }

  for (const key of ["path", "skill", "query", "search", "title", "name"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      return truncate(value.trim());
    }
  }
  return null;
}

/**
 * The tool's own name, and for `computer` the action inside it. A run of
 * `computer` calls is the normal shape of a turn here, so a chain that said
 * "computer" twelve times would say nothing; the action is the verb a person
 * is actually watching.
 */
const toolLabel = (part: EveDynamicToolPart): string => {
  const name = toolNameOf(part);
  const summary = summarizeToolInput(part.input);
  return summary ? `${name} · ${summary}` : name;
};

/**
 * Marker icon per step. The model's surface is five tools, and `computer` is
 * a union of actions, so the icon is chosen from the action when there is one:
 * a chain of clicks and keystrokes reads as what the agent did to the screen
 * rather than a column of identical bolts.
 */
function iconForTool(part: EveDynamicToolPart): React.ElementType {
  const name = toolNameOf(part);
  const action = firstAction(part.input);
  const type = typeof action?.type === "string" ? action.type : "";

  switch (type) {
    case "screenshot": {
      return ScreenCaptureIcon;
    }
    case "click":
    case "double_click":
    case "right_click": {
      return CursorClickIcon;
    }
    case "type": {
      return KeyboardIcon;
    }
    case "key": {
      return KeyIcon;
    }
    case "scroll": {
      return MouseScrollDownIcon;
    }
    case "move":
    case "drag": {
      return SquareCursorIcon;
    }
    default: {
      break;
    }
  }

  if (name.includes("shell")) {
    return ConsoleSparkleIcon;
  }
  if (name.includes("write")) {
    return FileEditIcon;
  }
  if (name.includes("read")) {
    return FileTextIcon;
  }
  if (name.includes("search")) {
    return SearchIcon;
  }
  return BoltIcon;
}

const isRunning = (part: EveDynamicToolPart): boolean =>
  part.state === "input-streaming" ||
  part.state === "input-available" ||
  part.state === "approval-requested";

const stepStatus = (part: EveDynamicToolPart): StepStatus =>
  isRunning(part) ? "active" : "complete";

/**
 * Screenshots the `computer` tool brings back. They ride inside the tool's own
 * result rather than as message `file` parts, so they are pulled out here: the
 * picture is the whole point of the call.
 */
function toolImages(part: EveDynamicToolPart): string[] {
  if (part.state !== "output-available" || !isRecord(part.output)) {
    return [];
  }
  const images: string[] = [];
  const push = (data: unknown, mediaType: unknown) => {
    if (typeof data === "string" && data.length > 0) {
      images.push(`data:${typeof mediaType === "string" ? mediaType : "image/png"};base64,${data}`);
    }
  };
  const { results } = part.output;
  if (Array.isArray(results)) {
    for (const result of results) {
      if (isRecord(result)) {
        push(result.image_b64, result.media_type);
      }
    }
  }
  push(part.output.screenshot_b64, "image/png");
  return images;
}

/** Text output worth reading under a step: what `shell` and `read_file` return. */
function toolText(part: EveDynamicToolPart): string | null {
  if (part.state === "output-error") {
    return typeof part.errorText === "string" ? part.errorText : null;
  }
  if (part.state !== "output-available" || !isRecord(part.output)) {
    return null;
  }
  for (const key of ["stdout", "text", "content", "stderr"]) {
    const value = part.output[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return null;
}

const MAX_DETAIL_LINES = 12;

/** A run of tool calls, collapsed into one chain rather than a row per call. */
function ToolSteps({ parts }: { parts: EveDynamicToolPart[] }): React.ReactElement {
  const running = parts.some(isRunning);
  return (
    <ThinkingSteps defaultOpen={false}>
      <ThinkingStepsHeader>
        {running ? "Working" : `${parts.length} ${parts.length === 1 ? "step" : "steps"}`}
      </ThinkingStepsHeader>
      <ThinkingStepsContent>
        {parts.map((part, index) => {
          const images = toolImages(part);
          const text = toolText(part);
          const failed = part.state === "output-error";
          return (
            <ThinkingStep
              icon={iconForTool(part)}
              isLast={index === parts.length - 1}
              key={part.toolCallId}
              label={failed ? `Failed: ${toolLabel(part)}` : toolLabel(part)}
              status={stepStatus(part)}
            >
              {text && (
                <ThinkingStepDetails
                  details={text.split("\n").slice(0, MAX_DETAIL_LINES)}
                  summary={failed ? "Error" : "Output"}
                />
              )}
              {images.map((src, imageIndex) => (
                <ThinkingStepImage
                  alt="What the agent saw"
                  key={`${part.toolCallId}-${imageIndex}`}
                  src={src}
                />
              ))}
            </ThinkingStep>
          );
        })}
      </ThinkingStepsContent>
    </ThinkingSteps>
  );
}

/**
 * eve marks the destructive choice itself; guessing which of "approve" and
 * "cancel" is the dangerous one gets it backwards for a session limit.
 */
const OPTION_VARIANT = {
  danger: "destructive",
  default: "outline",
  primary: "default",
} as const;

/**
 * The card for a parked turn: an approval before a tool changes something, or
 * a question the model is asking. Both arrive on the same `input.requested`
 * protocol and are told apart by `kind`.
 *
 * An approval shows the full input rather than a truncated summary. The calls
 * the policy parks are the ones about to change something the person did not
 * watch happen, and approving without being told what you are approving is not
 * approval.
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
  const isApproval = request.kind !== "question";
  const input = isApproval && part.input !== undefined ? JSON.stringify(part.input, null, 2) : null;

  return (
    <fieldset
      aria-label={isApproval ? "Approval required" : "Question"}
      className={`w-full rounded-xl border border-border bg-card p-3 ${
        disabled ? "pointer-events-none opacity-60" : ""
      }`}
      disabled={disabled}
    >
      {isApproval && (
        <div className="flex items-center gap-1.5 pb-2 text-muted-foreground text-xs">
          <ShieldCheckIcon className="size-3.5 shrink-0" />
          <span className="font-medium text-foreground">
            {part.toolMetadata?.eve?.name ?? part.toolName}
          </span>
        </div>
      )}
      {input && (
        <pre className="mb-2.5 max-h-48 overflow-auto rounded-lg bg-muted p-2.5 font-mono text-muted-foreground text-xs">
          {input}
        </pre>
      )}
      <p className="text-sm leading-6">{request.prompt}</p>
      <div className="flex flex-wrap gap-2 pt-3">
        {(request.options ?? []).map((option) => {
          const button = (
            <Button
              disabled={disabled}
              onClick={() => onAnswer({ optionId: option.id, requestId: request.requestId })}
              size="sm"
              type="button"
              variant={OPTION_VARIANT[option.style ?? "default"]}
            >
              {option.label}
            </Button>
          );
          if (!option.description) {
            return (
              <span className="contents" key={option.id}>
                {button}
              </span>
            );
          }
          return (
            <Tooltip key={option.id}>
              <TooltipTrigger render={button} />
              <TooltipContent>{option.description}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </fieldset>
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
    if (!part.text) {
      return null;
    }
    if (role === "user") {
      return (
        <Bubble align="end">
          {/* leading-normal keeps the bubble on the same rhythm as the prose. */}
          <BubbleContent className="whitespace-pre-wrap leading-normal">{part.text}</BubbleContent>
        </Bubble>
      );
    }
    return <Markdown text={part.text} />;
  }

  if (part.type === "file") {
    const isImage = part.mediaType.startsWith("image/");
    const url = safeUrl(part.url, isImage);
    if (!url) {
      return null;
    }
    return isImage ? (
      <img
        alt={part.filename ?? "Attachment"}
        className="max-h-64 w-auto max-w-full rounded-xl border border-border"
        src={url}
      />
    ) : (
      <a
        className="flex w-fit max-w-full items-center gap-2.5 rounded-xl border border-border bg-background px-3 py-2.5 hover:bg-muted"
        href={url}
        rel="noreferrer"
        target="_blank"
      >
        <FileTextIcon className="size-5 shrink-0 text-muted-foreground" />
        <span className="truncate font-medium text-sm">{part.filename ?? "Attachment"}</span>
      </a>
    );
  }

  if (part.type === "dynamic-tool") {
    const request = part.toolMetadata?.eve?.inputRequest;
    // Regular tool calls are grouped into the chain before reaching here.
    if (!request) {
      return null;
    }
    const response = part.toolMetadata?.eve?.inputResponse;
    if (response) {
      const chosen =
        request.options?.find((option) => option.id === response.optionId)?.label ??
        response.text ??
        "Answered";
      return (
        <Marker variant="border">
          <MarkerIcon>
            <Hand5FingerIcon />
          </MarkerIcon>
          <MarkerContent>You answered: {chosen}</MarkerContent>
        </Marker>
      );
    }
    return (
      <InputRequestCard disabled={disabled} onAnswer={onAnswer} part={part} request={request} />
    );
  }

  if (part.type === "reasoning") {
    if (!part.text) {
      return null;
    }
    return (
      <ThinkingSteps defaultOpen={false}>
        <ThinkingStepsHeader>Reasoning</ThinkingStepsHeader>
        <ThinkingStepsContent>
          <ThinkingStep isLast label="Reasoning" showIcon={false}>
            <p className="whitespace-pre-wrap text-[13px] text-muted-foreground leading-snug">
              {part.text}
            </p>
          </ThinkingStep>
        </ThinkingStepsContent>
      </ThinkingSteps>
    );
  }

  if (part.type === "authorization") {
    const url = part.state === "required" ? safeUrl(part.authorization?.url) : undefined;
    return (
      <Marker variant="border">
        <MarkerIcon>
          <KeyIcon />
        </MarkerIcon>
        <MarkerContent>
          {part.state === "completed"
            ? `${part.displayName} authorization ${part.outcome}`
            : part.description}
          {url && (
            <a className="ml-2" href={url} rel="noreferrer" target="_blank">
              Sign in
            </a>
          )}
        </MarkerContent>
      </Marker>
    );
  }

  return null;
}

type Item =
  | { kind: "single"; key: string; part: EveMessagePart }
  | { kind: "secret"; key: string; part: EveDynamicToolPart; request: SecretRequest }
  | { kind: "tools"; key: string; parts: EveDynamicToolPart[] };

/** What the seat answers: the open request's id and the masked value. */
export interface SecretAnswer {
  occurrenceId: string;
  value: string;
}

interface SecretRequest {
  prompt: string;
  label: string;
  /** From the tool's result; absent while the call is still streaming. */
  occurrenceId?: string;
}

/**
 * A `send_message` whose kind is `secret_request` is the one voice part that
 * renders: it ended the Bot's turn and waits on a person, and this pane is
 * the only client that can answer it (`Seat.ProvideSecret`). The value goes
 * to the box clipboard and never through the model, which is the whole
 * reason it is a masked field here and not a chat reply.
 */
function secretRequestOf(part: EveDynamicToolPart): SecretRequest | null {
  const input = part.input as { kind?: unknown; prompt?: unknown; label?: unknown } | undefined;
  if (input?.kind !== "secret_request") {
    return null;
  }
  const output = part.output as { occurrence_id?: unknown } | undefined;
  return {
    label: typeof input.label === "string" && input.label ? input.label : "the value",
    occurrenceId: typeof output?.occurrence_id === "string" ? output.occurrence_id : undefined,
    prompt: typeof input.prompt === "string" ? input.prompt : "",
  };
}

function SecretRequestCard({
  disabled,
  onSecret,
  request,
}: {
  disabled: boolean;
  onSecret?: (answer: SecretAnswer) => Promise<void>;
  request: SecretRequest;
}): React.ReactElement {
  const [value, setValue] = useState("");
  const [state, setState] = useState<"open" | "sending" | "done" | "error">("open");
  const [failure, setFailure] = useState<string | null>(null);
  const ready = onSecret !== undefined && request.occurrenceId !== undefined;

  if (state === "done") {
    return (
      <Marker variant="border">
        <MarkerIcon>
          <KeyIcon />
        </MarkerIcon>
        <MarkerContent>{request.label} is on the computer clipboard for two minutes.</MarkerContent>
      </Marker>
    );
  }

  const submit = async () => {
    if (!(ready && value) || state === "sending") {
      return;
    }
    setState("sending");
    setFailure(null);
    try {
      await onSecret({ occurrenceId: request.occurrenceId as string, value });
      setValue("");
      setState("done");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Already answered, from another tab or before a reload: that is done,
      // not a failure to show as one.
      if (/already provided/i.test(message)) {
        setState("done");
        return;
      }
      setFailure(message);
      setState("error");
    }
  };

  return (
    <fieldset
      aria-label="Secret requested"
      className={`w-full rounded-xl border border-border bg-card p-3 ${
        disabled ? "pointer-events-none opacity-60" : ""
      }`}
      disabled={disabled}
    >
      <div className="flex items-center gap-1.5 pb-2 text-muted-foreground text-xs">
        <KeyIcon className="size-3.5 shrink-0" />
        <span className="font-medium text-foreground">{request.label}</span>
      </div>
      {request.prompt && <p className="text-sm leading-6">{request.prompt}</p>}
      <form
        className="flex flex-wrap items-center gap-2 pt-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Input
          aria-label={request.label}
          autoComplete="off"
          className="min-w-48 flex-1"
          disabled={!ready || state === "sending"}
          onChange={(event) => setValue(event.target.value)}
          placeholder={request.label}
          type="password"
          value={value}
        />
        <Button disabled={!(ready && value) || state === "sending"} size="sm" type="submit">
          Put on the clipboard
        </Button>
      </form>
      <p className="pt-2 text-muted-foreground text-xs">
        {failure ??
          "Goes straight to the computer clipboard. The Bot pastes it and never reads it."}
      </p>
    </fieldset>
  );
}

const toolNameOf = (part: EveDynamicToolPart): string =>
  part.toolMetadata?.eve?.name ?? part.toolName;

/**
 * `send_message` is the model's voice, not a step it took.
 *
 * It is one of the five tools, so it arrives as a tool call like any other and
 * the chain listed it beside the clicks and keystrokes. But what it carries is
 * the text already rendered as the message underneath, so the row said the
 * same thing twice and made the plumbing look like work. The chain is what the
 * Bot did to the computer; the message is what it said about it.
 */
const isVoice = (part: EveDynamicToolPart): boolean => toolNameOf(part) === "send_message";

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
      // The voice renders nothing here, and must not break a run in two.
      // The exception is a secret request: the one send that waits on the
      // person reading this pane.
      if (isVoice(part)) {
        const request = secretRequestOf(part);
        if (request) {
          flush();
          items.push({ key: `secret-${index}`, kind: "secret", part, request });
        }
        continue;
      }
      if (run.length === 0) {
        runStart = index;
      }
      run.push(part);
      continue;
    }
    if (isInvisible(part)) {
      continue;
    }
    flush();
    items.push({ key: `part-${index}`, kind: "single", part });
  }
  flush();
  return items;
}

/**
 * A person's attachments render above their text.
 *
 * The turn is sent text-first, because that is the order the model should read
 * it in. On screen the opposite is true: every messaging client puts the image
 * above its caption, and a bubble arriving before the thing it refers to reads
 * backwards. Only the render order flips; the wire order stays as it is.
 */
const attachmentsFirst = (parts: readonly EveMessagePart[]): EveMessagePart[] =>
  parts.toSorted((a, b) => Number(b.type === "file") - Number(a.type === "file"));

export function ChatMessage({
  disabled,
  message,
  onAnswer,
  onSecret,
}: {
  disabled: boolean;
  message: EveMessage;
  onAnswer: (answer: Answer) => void;
  /** Answers an open `secret_request`; absent where no seat can (the invite desk). */
  onSecret?: (answer: SecretAnswer) => Promise<void>;
}): React.ReactElement {
  const align = message.role === "user" ? "end" : "start";
  const items = buildItems(
    message.role === "user" ? attachmentsFirst(message.parts) : message.parts,
  );

  return (
    <Message align={align}>
      <MessageContent>
        {items.map((item) =>
          item.kind === "tools" ? (
            <ToolSteps key={item.key} parts={item.parts} />
          ) : item.kind === "secret" ? (
            <SecretRequestCard
              disabled={disabled}
              key={item.key}
              onSecret={onSecret}
              request={item.request}
            />
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
      </MessageContent>
    </Message>
  );
}
