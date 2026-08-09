/**
 * Ported from `BuilderGPTComponent.call_llm` (component.py:63-104).
 *
 * Two transports, on purpose.
 *
 * **OpenAI, Gemini and Custom** go through Node's builtin `fetch` against the
 * OpenAI-compatible `/chat/completions`. The Python original's provider
 * branches differ only in base URL and the whole request is three fields, so
 * an SDK would add nothing. This is also what removed the CORS problem that
 * motivated the Electron pivot: the request is made from the main process,
 * which is Node, not a browser.
 *
 * **OpenCode** goes through the AI SDK (`@ai-sdk/openai-compatible`). This
 * closes RULEBOOK.md DEV-013, which had been open on "use the official
 * OpenCode SDK" -- with a finding rather than a simple yes. `@opencode-ai/sdk`
 * is a client for a *local opencode agent server*: it depends on `cross-spawn`,
 * expects the opencode CLI installed and listening on localhost, and drives
 * agent sessions. It has no path to a chat completion against OpenCode Zen, and
 * adopting it would have meant this app could not generate anything without a
 * separate CLI install -- the opposite of "one installer, no runtime to set up".
 *
 * What OpenCode *does* designate for Zen is `@ai-sdk/openai-compatible`: its
 * own model registry (models.dev, provider `opencode`) publishes exactly that
 * as the client, alongside the `https://opencode.ai/zen/v1` endpoint. So the
 * spirit of the request is honoured -- the provider-blessed client, typed and
 * maintained -- without the local-server dependency. Pure JS, so the
 * zero-native-dependencies invariant in CLAUDE.md still holds.
 */

import { readFile } from "fs/promises";
import path from "path";

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, type ModelMessage } from "ai";

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
}

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

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

async function buildUserContent(req: LlmRequest): Promise<ContentPart[]> {
  const parts: ContentPart[] = [];
  if (req.userPrompt) {
    parts.push({ type: "text", text: req.userPrompt });
  }
  const image = await readImage(req.imagePath, req.acceptsImages);
  if (image) {
    parts.push({
      type: "image_url",
      image_url: { url: `data:${image.mime};base64,${image.bytes.toString("base64")}` },
    });
  }
  return parts;
}

/**
 * OpenCode Zen, through the client its own registry designates.
 *
 * `generateText` handles the request/response shape, so the only things worth
 * spelling out here are the two contracts this app relies on: every failure
 * leaves as an `LlmError` (`services/generate.ts:184` classifies by that
 * message prefix, not by `instanceof`), and an empty string is a failure rather
 * than a result -- the caller is about to feed it to a JS parser.
 */
async function callOpenCode(req: LlmRequest, baseUrl: string, apiKey: string): Promise<string> {
  const messages: ModelMessage[] = [{ role: "system", content: req.systemPrompt }];

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
  } else if (req.userPrompt) {
    messages.push({ role: "user", content: req.userPrompt });
  }

  const opencode = createOpenAICompatible({
    name: "opencode",
    baseURL: baseUrl,
    apiKey,
  });

  let text: string;
  try {
    const result = await generateText({
      model: opencode(req.model),
      messages,
      temperature: 0.2, // component.py:100
      abortSignal: req.signal,
    });
    text = result.text;
  } catch (err) {
    throw new LlmError(err instanceof Error ? err.message : String(err));
  }

  if (typeof text !== "string" || text.trim() === "") {
    throw new LlmError("response contained no message content");
  }
  return text;
}

export async function callLlm(req: LlmRequest): Promise<string> {
  const baseUrl = resolveBaseUrl(req.provider, req.baseUrl).replace(/\/+$/, "");

  // component.py:68 -- an empty key becomes the literal "none", which is what
  // OpenCode's free tier expects and what the other providers reject anyway.
  const apiKey = req.apiKey.trim() !== "" ? req.apiKey.trim() : "none";

  if (req.provider === "OpenCode") {
    return await callOpenCode(req, baseUrl, apiKey);
  }

  const messages: Array<{ role: string; content: string | ContentPart[] }> = [
    { role: "system", content: req.systemPrompt },
  ];

  const userContent = await buildUserContent(req);
  if (userContent.length > 0) {
    messages.push({ role: "user", content: userContent });
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: req.model,
        messages,
        temperature: 0.2, // component.py:100
      }),
      signal: req.signal,
    });
  } catch (err) {
    throw new LlmError(err instanceof Error ? err.message : String(err));
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new LlmError(`${response.status} ${response.statusText}${body ? ` - ${body.slice(0, 500)}` : ""}`);
  }

  let payload: {
    choices?: Array<{ message?: { content?: string | null } }>;
    error?: { message?: string };
  };
  try {
    payload = (await response.json()) as typeof payload;
  } catch (err) {
    throw new LlmError(`malformed JSON response: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (payload.error?.message) {
    throw new LlmError(payload.error.message);
  }

  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    // component.py:102 indexed `choices[0]` unconditionally and would have
    // raised an IndexError wrapped as "LLM API Error"; same class of failure,
    // with a message that says what actually went wrong.
    throw new LlmError("response contained no message content");
  }
  return content;
}
