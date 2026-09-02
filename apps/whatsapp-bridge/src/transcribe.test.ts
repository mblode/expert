// oxlint-disable no-import-node-test, prefer-importing-vitest-globals -- run via node's built-in test runner (tsx --test), not vitest
import assert from "node:assert/strict";
import { test } from "node:test";

import type { transcribe } from "ai";

import { transcribeAudio, transcriptionModel } from "./transcribe.ts";

// A typed stub for the `ai` SDK's transcribe(); we only read `.text`, so the
// rest of TranscriptionResult is filled from a loose cast.
const stubTranscribe = (
  text: string,
): { calls: Parameters<typeof transcribe>[0][]; fn: typeof transcribe } => {
  const calls: Parameters<typeof transcribe>[0][] = [];
  const fn = ((args: Parameters<typeof transcribe>[0]) => {
    calls.push(args);
    return Promise.resolve({ text } as Awaited<ReturnType<typeof transcribe>>);
  }) as typeof transcribe;
  return { calls, fn };
};

test("transcriptionModel returns null without a gateway key", () => {
  assert.equal(transcriptionModel({}), null);
  assert.equal(transcriptionModel({ AI_GATEWAY_API_KEY: "   " }), null);
});

test("transcriptionModel defaults the model and honours an override", () => {
  assert.equal(transcriptionModel({ AI_GATEWAY_API_KEY: "gk-1" }), "openai/gpt-4o-mini-transcribe");
  assert.equal(
    transcriptionModel({
      AI_GATEWAY_API_KEY: "gk-1",
      TRANSCRIBE_MODEL: "openai/whisper-1",
    }),
    "openai/whisper-1",
  );
});

test("transcribeAudio passes the audio to the SDK and trims the text", async () => {
  const { calls, fn } = stubTranscribe("  hello there  ");
  const audio = new Uint8Array([1, 2, 3]);

  const out = await transcribeAudio(audio, "openai/whisper-1", {
    transcribe: fn,
  });

  assert.equal(out, "hello there");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.audio, audio);
});

test("transcribeAudio returns null on an empty transcript", async () => {
  const { fn } = stubTranscribe("   ");
  const out = await transcribeAudio(new Uint8Array([1]), "openai/whisper-1", {
    transcribe: fn,
  });
  assert.equal(out, null);
});

test("transcribeAudio returns null when transcribe throws", async () => {
  const fn = (() => Promise.reject(new Error("network down"))) as typeof transcribe;
  const out = await transcribeAudio(new Uint8Array([1]), "openai/whisper-1", {
    transcribe: fn,
  });
  assert.equal(out, null);
});
