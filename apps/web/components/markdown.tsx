import { memo } from "react";
import { Streamdown } from "streamdown";
import type { StreamdownProps } from "streamdown";

/**
 * Shiki ships its own themed code chrome. Streamdown still renders through
 * `.prose-chat` so fences stay consistent with the rest of the transcript.
 */
const COMPONENTS: StreamdownProps["components"] = {
  code: ({ children, className, ...props }) => (
    <code className={className} {...props}>
      {children}
    </code>
  ),
  pre: ({ children, ...props }) => <pre {...props}>{children}</pre>,
};

/**
 * Assistant markdown. Streamdown, because half-arrived text is the normal case
 * here: an unterminated fence or a dangling `**` renders cleanly as it streams.
 * Memoized: the reducer rebuilds the message array on every stream event.
 */
export const Markdown = memo(
  ({ text }: { text: string }): React.ReactElement => (
    <Streamdown className="prose-chat max-w-none text-sm" components={COMPONENTS} controls={false}>
      {text}
    </Streamdown>
  ),
);

Markdown.displayName = "Markdown";
