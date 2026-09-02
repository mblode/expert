import type { Logger } from "pino";

/**
 * HTTP client for the hub's channel ingress. Forwards an inbound WhatsApp
 * message to `POST ${COMPUTER_URL}/channels/<channel_id>/message` and returns
 * the Bot's reply text, with bounded retry/backoff so a transient blip never
 * drops accepted work.
 *
 * The payload is bridge protocol v1, the shape `vcmc-agent`'s channel already
 * speaks (`token`, `message`, `sender`, `senderPhone`, `senderName`,
 * `context[]`, `surface`, `media[]`), plus `acct` so a Bot served by two
 * numbers can tell them apart. Auth is the account's channel secret in
 * `x-channel-secret`; the hub matches it against channels.json and forwards to
 * that Bot's Eve on loopback. The endpoint, secret, timeout, logger and sleep
 * are injected so this module owns no env or global state and the retry
 * policy tests without a socket.
 */

/** An image or PDF downloaded off a message, ready to forward as a file part. */
export interface Media {
  dataUrl: string;
  mime: string;
}

/** Arguments forwarded to the hub. */
export interface AskAgentArgs {
  context?: string[];
  media?: Media[];
  message: string;
  sender: string;
  senderName: string | undefined;
  /** The sender's phone-based identity (from senderPn), used for admin checks. */
  senderPhone: string | null;
  surface: string;
  token: string;
}

/** What the Bot returned. */
export interface AgentReply {
  reply: string;
}

/** Config for the client; injected so the module owns no env/global state. */
export interface ChannelClientConfig {
  /** Which account this client speaks for; rides in the payload as `acct`. */
  acct: string;
  endpoint: string;
  channelSecret: string;
  timeoutMs: number;
  logger: Logger;
  sleep: (ms: number) => Promise<void>;
  /** Total attempts on transient failures. Defaults to 3; 1 disables retries. */
  maxAttempts?: number;
}

/** An error that may carry a `retryable` flag set by askAgent. */
type RetryableError = Error & { retryable?: boolean };

/**
 * Build an `askAgent(args)` bound to one account's endpoint and secret.
 *
 * Transient failures (HTTP 429 / >=500, or network errors where fetch throws)
 * are retried up to `maxAttempts` total attempts with exponential backoff so we
 * never drop accepted work on a blip. Other non-OK statuses (4xx except 429)
 * are not retryable and throw immediately.
 */
export const createChannelClient =
  ({
    acct,
    endpoint,
    channelSecret,
    timeoutMs,
    logger,
    sleep,
    maxAttempts = 3,
  }: ChannelClientConfig): ((args: AskAgentArgs) => Promise<AgentReply>) =>
  async ({
    context,
    media,
    message,
    sender,
    senderName,
    senderPhone,
    surface,
    token,
  }: AskAgentArgs): Promise<AgentReply> => {
    let lastErr: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const res = await fetch(endpoint, {
          body: JSON.stringify({
            acct,
            context,
            media,
            message,
            sender,
            senderName,
            senderPhone,
            surface,
            token,
          }),
          headers: {
            "content-type": "application/json",
            "x-channel-secret": channelSecret,
          },
          method: "POST",
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (res.ok) {
          const data = (await res.json()) as { reply?: unknown };
          return {
            reply: typeof data.reply === "string" ? data.reply.trim() : "",
          };
        }

        const detail = await res.text().catch(() => "");
        const retryable = res.status === 429 || res.status >= 500;
        const err: RetryableError = new Error(`hub responded ${res.status}: ${detail}`);
        err.retryable = retryable;
        // 4xx (except 429) is a caller/auth problem: fail fast, don't retry.
        if (!retryable) {
          throw err;
        }
        lastErr = err;
      } catch (error) {
        // Non-retryable HTTP errors are tagged so we rethrow without burning
        // the retry budget; everything else (network-level fetch failures, an
        // abort from the timeout, plus retryable HTTP statuses) is safe to retry.
        if ((error as RetryableError)?.retryable === false) {
          throw error;
        }
        if ((error as { name?: string })?.name === "TimeoutError") {
          logger.warn({ attempt, timeoutMs }, "askAgent attempt timed out");
        }
        lastErr = error;
      }

      if (attempt < maxAttempts) {
        // ~500ms, 1000ms, 2000ms, with a little jitter to avoid thundering herds.
        const backoff = 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
        logger.warn(
          { attempt, backoff, err: lastErr },
          "askAgent retrying after transient failure",
        );
        await sleep(backoff);
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  };
