import { memo } from "react";
import { Streamdown } from "streamdown";
import type { StreamdownProps } from "streamdown";

/**
 * Shiki ships its own themed code chrome and switches on a `.dark` class this
 * app does not have, so code renders as plain token-styled elements instead
 * (see `.prose-chat` in index.css).
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
