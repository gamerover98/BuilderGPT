/**
 * Ported from `BuilderGPTComponent.call_llm` (component.py:63-104).
 *
 * **One transport, for all four providers**: `@ai-sdk/openai-compatible`.
 *
 * It was two until the agent work. OpenAI, Gemini and Custom went through
 * Node's builtin `fetch` against `/chat/completions`, on the reasonable
 * grounds that the request is three fields and an SDK would add nothing --
 * true, right up until the app needed tool calling. A hand-rolled chat
 * completion cannot do a tool loop: no tool schemas on the way out, no
 * `tool_calls` parsed on the way back, no multi-step. Keeping it would have
 * meant the agent worked on OpenCode and nowhere else.
 *
 * `createOpenAICompatible` speaks the same dialect all four of these endpoints
 * already serve -- Gemini publishes an OpenAI-compatible surface, and
 * "Custom (OpenAI Compatible)" says so in its name -- so unifying costs
 * nothing at the protocol level and buys the whole `ai` toolchain.
 *
 * This also keeps RULEBOOK.md DEV-013 closed the way it was closed: not with
 * `@opencode-ai/sdk`, which is a client for a *local opencode agent server*
 * (it depends on `cross-spawn`, expects the CLI installed and listening on
 * localhost, and has no path to a chat completion against Zen), but with the
 * client OpenCode's own registry designates for Zen. Pure JS, so the
 * zero-native-dependencies invariant in CLAUDE.md still holds.
 */

import { readFile } from "fs/promises";
import path from "path";

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { streamText, type ModelMessage } from "ai";

import { PROVIDER_DEFAULT_BASE_URL, type Provider } from "../../shared/settings.js";

export class LlmError extends Error {
  constructor(message: string) {
    // component.py:104 wraps everything as `LLM API Error: {e}`; the prefix is
    // preserved because users have seen it and it identifies the layer.
    super(`LLM API Error: ${message}`);
    this.name = "LlmError";
  }
}

export interface LlmRequest {
  provider: Provider;
  model: string;
  apiKey: string;
  /** Empty string means "use the provider default". component.py:67/70/73/76. */
  baseUrl: string;
  systemPrompt: string;
  userPrompt: string;
  imagePath?: string | null;
  /**
   * `false` when the selected model is known to be text-only. The image is then
   * dropped before the request rather than after: sending an image part to a
   * text-only Zen model returns a bare 400 that reaches the user as a generic
   * "LLM API Error", with nothing pointing at the actual cause.
   */
  acceptsImages?: boolean;
  signal?: AbortSignal;
  /**
   * The answer as it is written, rather than only once it is finished.
   *
   * Generation is one long call with nothing to show for it -- the model writes
   * a whole build script before a byte of it is usable -- so this is what turns
   * "sending the build spec to the model" followed by a wait into something a
   * person can watch. Optional: the callers that display nothing pass nothing.
   */
  onDelta?: (text: string) => void;
  /** The same for a thinking model's reasoning, which most models do not emit. */
  onReasoning?: (text: string) => void;
}

const IMAGE_MIME: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};

export function resolveBaseUrl(provider: Provider, baseUrl: string): string {
  const explicit = baseUrl.trim();
  if (explicit !== "") {
    return explicit;
  }
  const fallback = PROVIDER_DEFAULT_BASE_URL[provider];
  if (fallback === "") {
    // component.py:76 passed `base_url=None` straight to the OpenAI client for
    // the Custom provider, which then defaulted to api.openai.com -- almost
    // certainly not what someone picking "Custom" wants. Failing loudly here
    // is the deliberate behavior change (ARCHITECTURE.md §4 change 3).
    throw new LlmError("Custom (OpenAI Compatible) requires a Base URL");
  }
  return fallback;
}

/** The image bytes plus the MIME the extension implies, or `null`. */
async function readImage(
  imagePath: string | null | undefined,
  acceptsImages: boolean | undefined,
): Promise<{ bytes: Buffer; mime: string } | null> {
  if (!imagePath || acceptsImages === false) {
    return null;
  }
  try {
    const bytes = await readFile(imagePath);
    // component.py:90 hardcoded `data:image/jpeg` regardless of the actual
    // upload type, even though the uploader accepted png/gif/bmp. Corrected
    // to the real type -- a mislabeled data URL is a latent provider-side
    // decode failure, not a behavior worth preserving.
    return { bytes, mime: IMAGE_MIME[path.extname(imagePath).toLowerCase()] ?? "image/jpeg" };
  } catch {
    // component.py:85 gated on `os.path.exists`; the equivalent here is
    // "try to read it, and treat a missing file as no image" -- same outcome,
    // no TOCTOU pre-check (RULEBOOK.md §1 standard-library-I/O row).
    return null;
  }
}

/**
 * The provider handle for a request.
 *
 * Exported because the agent builds its own `generateText` calls -- tools,
 * multi-step -- and must reach the same endpoint, with the same key, resolved
 * the same way. Two places deciding what "OpenCode" means is exactly the kind
 * of drift that produces "it works in generation and not in chat".
 */
export function resolveModel(req: {
  provider: Provider;
  model: string;
  apiKey: string;
  baseUrl: string;
}) {
  const baseUrl = resolveBaseUrl(req.provider, req.baseUrl).replace(/\/+$/, "");
  // component.py:68 -- an empty key becomes the literal "none", which is what
  // OpenCode's free tier expects and what the other providers reject anyway.
  const apiKey = req.apiKey.trim() !== "" ? req.apiKey.trim() : "none";
  const provider = createOpenAICompatible({ name: req.provider, baseURL: baseUrl, apiKey });
  return provider(req.model);
}

/**
 * One completion.
 *
 * `generateText` handles the request/response shape, so the only things worth
 * spelling out here are the two contracts this app relies on: every failure
 * leaves as an `LlmError` (`services/generate.ts` classifies by that message
 * prefix, not by `instanceof`), and an empty string is a failure rather than a
 * result -- the caller is about to feed it to a JS parser.
 */
export async function callLlm(req: LlmRequest): Promise<string> {
  // The system prompt rides `instructions`, NOT a `{role:"system"}` entry in
  // `messages`. AI SDK 7 rejects the latter at runtime -- `validatePrompt`
  // throws `InvalidPromptError: System messages are not allowed in the prompt
  // or messages fields` unless `allowSystemInMessages` is set. Typecheck does
  // not catch it: `ModelMessage` still admits the system role, because the
  // option exists to re-enable it. `instructions` is the supported spelling
  // (`system` is the deprecated alias for the same field), and the provider
  // adapter turns it back into a system message on the wire, so what OpenCode
  // Zen receives is unchanged.
  const messages: ModelMessage[] = [];

  const image = await readImage(req.imagePath, req.acceptsImages);
  if (image) {
    messages.push({
      role: "user",
      content: [
        { type: "text", text: req.userPrompt },
        // `ImagePart`, not a `data:` URL: the SDK encodes the bytes for the
        // provider, so there is no base64 round-trip to get wrong.
        { type: "image", image: new Uint8Array(image.bytes), mediaType: image.mime },
      ],
    });
  } else {
    // Unconditional, unlike the fetch path: with the system prompt moved to
    // `instructions`, an empty user prompt would leave `messages` empty, and
    // the SDK rejects that too ("messages must not be empty").
    messages.push({ role: "user", content: req.userPrompt });
  }

  let text: string;
  try {
    /*
     * Streamed rather than awaited whole, and the difference is only visible to
     * a caller that passes `onDelta`. `result.text` resolves to the same string
     * it always did -- what changes is that the caller can show it arriving
     * instead of showing nothing for however long the model takes.
     */
    const result = streamText({
      model: resolveModel(req),
      instructions: req.systemPrompt,
      messages,
      temperature: 0.2, // component.py:100
      abortSignal: req.signal,
      // The SDK's default here is `console.error`. Errors are raised below
      // instead, where the caller can tell a stop from a failure.
      onError: () => {},
    });
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") req.onDelta?.(part.text);
      else if (part.type === "reasoning-delta") req.onReasoning?.(part.text);
      else if (part.type === "error") throw part.error;
    }
    text = await result.text;
  } catch (err) {
    throw new LlmError(err instanceof Error ? err.message : String(err));
  }

  if (typeof text !== "string" || text.trim() === "") {
    throw new LlmError("response contained no message content");
  }
  return text;
}

