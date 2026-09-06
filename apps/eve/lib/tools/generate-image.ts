import { gateway } from "@ai-sdk/gateway";
import { generateImage } from "ai";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { bridgeConfigured, bridgePost } from "../vibey/bridge-client.ts";
import { groupJidFromAuth } from "../vibey/session.ts";

/**
 * Generate an image via the Vercel AI Gateway and deliver it straight into the
 * chat through the bridge's POST /send-media (allowlisted + rate-capped there).
 * The image bytes never enter model context: the tool returns a small receipt
 * and the member sees the picture land in WhatsApp before vibey's text reply.
 *
 * Off-group (the eve TUI) or with the bridge unconfigured it returns
 * `available: false` like the other bridge tools, so evals and local dev
 * degrade instead of throwing.
 */

/** Gateway image model id; override with IMAGE_MODEL. */
const DEFAULT_IMAGE_MODEL = "google/gemini-2.5-flash-image";

/** Image generation can take tens of seconds; bound it so a turn can't hang. */
const generationTimeoutMs = (): number => {
  const v = Number(process.env.IMAGE_GEN_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 60_000;
};

// Matches the bridge's default MAX_SEND_MEDIA_BYTES; anything bigger would be
// refused there, so skip the upload and report the miss instead.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

// The upload carries the base64 image, so give it a longer leash than the
// default 4s bridge timeout.
const SEND_TIMEOUT_MS = 30_000;

export default defineTool({
  description:
    "Generate an image from a text prompt and post it directly into this chat. Use when someone asks you to draw, generate, render or mock up a picture. Write the prompt as a tight visual description (subject, style, mood); pass a short caption only if one was asked for. The image is delivered by the tool itself, so after it returns sent:true just add your short text reply, don't describe the image or claim you can't make images.",
  async execute({ prompt, caption }, ctx) {
    const jid = groupJidFromAuth(ctx.session.auth);
    if (!bridgeConfigured() || !jid) {
      return {
        available: false,
        note: "Image delivery is only available inside a WhatsApp chat.",
        sent: false,
      };
    }

    try {
      const model = process.env.IMAGE_MODEL || DEFAULT_IMAGE_MODEL;
      const { image } = await generateImage({
        abortSignal: AbortSignal.timeout(generationTimeoutMs()),
        model: gateway.image(model),
        prompt,
      });
      // base64 inflates bytes by 4/3, so decoded size is length * 3/4.
      if (image.base64.length * 0.75 > MAX_IMAGE_BYTES) {
        return {
          error: "generated image is over the delivery size cap",
          sent: false,
        };
      }
      await bridgePost(
        "/send-media",
        {
          base64: image.base64,
          caption,
          jid,
          mime: image.mediaType || "image/png",
        },
        SEND_TIMEOUT_MS,
      );
      return { model, sent: true };
    } catch (error) {
      return { error: String(error), sent: false };
    }
  },
  inputSchema: z.object({
    caption: z
      .string()
      .max(300)
      .optional()
      .describe(
        "Optional short caption sent with the image. Usually leave it off and reply in text instead.",
      ),
    prompt: z
      .string()
      .min(1)
      .max(2000)
      .describe("Visual description of the image to generate: subject, style, composition, mood."),
  }),
});
