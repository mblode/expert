/**
 * Speech-to-text for WhatsApp voice notes. The bridge downloads the audio and
 * transcribes it through the Vercel AI Gateway (the same gateway, and same
 * AI_GATEWAY_API_KEY, the agent uses for chat and images), then forwards the
 * text to the agent, mirroring how documents are flattened to text. Off unless
 * a key is set, degrading to the plain [audio] placeholder as before.
 *
 * The `ai` SDK's `transcribe` does the request and infers the media type from
 * the audio bytes, so there's no hand-rolled multipart call or extension map.
 */

import { gateway } from "@ai-sdk/gateway";
import { transcribe } from "ai";

/** Minimal logger surface, matching how the bridge's pino logger is used here. */
interface WarnLogger {
  warn: (obj: unknown, msg?: string) => void;
}

// Gateway transcription model id (provider/model); override with TRANSCRIBE_MODEL.
const DEFAULT_MODEL = "openai/gpt-4o-mini-transcribe";

/**
 * The gateway model to transcribe voice notes with, or null when transcription
 * is off (no AI_GATEWAY_API_KEY), the caller then keeps the [audio] placeholder.
 */
export const transcriptionModel = (env: NodeJS.ProcessEnv = process.env): string | null => {
  if (!env.AI_GATEWAY_API_KEY?.trim()) {
    return null;
  }
  return env.TRANSCRIBE_MODEL?.trim() || DEFAULT_MODEL;
};

/**
 * Transcribe an audio buffer through the AI Gateway. Returns the trimmed
 * transcript, or null on any failure (network, provider error, empty result) so
 * the caller can degrade to the [audio] placeholder. `opts.transcribe` is a
 * test seam.
 */
export const transcribeAudio = async (
  buf: Uint8Array,
  model: string,
  opts: {
    logger?: WarnLogger;
    signal?: AbortSignal;
    transcribe?: typeof transcribe;
  } = {},
): Promise<string | null> => {
  try {
    const { text } = await (opts.transcribe ?? transcribe)({
      abortSignal: opts.signal,
      audio: buf,
      model: gateway.transcription(model),
    });
    return text.trim() || null;
  } catch (error) {
    opts.logger?.warn({ error }, "transcription request errored");
    return null;
  }
};
