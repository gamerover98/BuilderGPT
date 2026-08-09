/**
 * Ported from `BuilderGPTComponent.call_llm` (component.py:63-104).
 *
 * ARCHITECTURE.md §3 "LLM transport": Node's builtin `fetch` against the
 * OpenAI-compatible `/chat/completions`, not the `openai` npm package. The
 * Python original's four provider branches differ **only** in base URL, and
 * the whole request is three fields; an SDK adds nothing here. This also
 * removes the CORS problem that motivated the Electron pivot: the request is
 * made from the main process, which is Node, not a browser.
 *
 * Departure from the Step 00 answer ("provvedere sdk ufficiale" for OpenCode)
 * is logged as RULEBOOK.md DEV-013, ratification pending -- `component.py`
 * already talks to OpenCode over its OpenAI-compatible endpoint, so a
 * provider-specific SDK for one of four providers would be the odd one out.
 */

import { readFile } from "fs/promises";
import path from "path";

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

async function buildUserContent(
  userPrompt: string,
  imagePath: string | null | undefined,
): Promise<ContentPart[]> {
  const parts: ContentPart[] = [];
  if (userPrompt) {
    parts.push({ type: "text", text: userPrompt });
  }
  if (imagePath) {
    // component.py:85 gated on `os.path.exists`; the equivalent here is
    // "try to read it, and treat a missing file as no image" -- same outcome,
    // no TOCTOU pre-check (RULEBOOK.md §1 standard-library-I/O row).
    try {
      const bytes = await readFile(imagePath);
      // component.py:90 hardcoded `data:image/jpeg` regardless of the actual
      // upload type, even though the uploader accepted png/gif/bmp. Corrected
      // to the real type -- a mislabeled data URL is a latent provider-side
      // decode failure, not a behavior worth preserving.
      const mime = IMAGE_MIME[path.extname(imagePath).toLowerCase()] ?? "image/jpeg";
      parts.push({
        type: "image_url",
        image_url: { url: `data:${mime};base64,${bytes.toString("base64")}` },
      });
    } catch {
      // Missing/unreadable image: proceed text-only, as the source did.
    }
  }
  return parts;
}

export async function callLlm(req: LlmRequest): Promise<string> {
  const baseUrl = resolveBaseUrl(req.provider, req.baseUrl).replace(/\/+$/, "");
  const messages: Array<{ role: string; content: string | ContentPart[] }> = [
    { role: "system", content: req.systemPrompt },
  ];

  const userContent = await buildUserContent(req.userPrompt, req.imagePath);
  if (userContent.length > 0) {
    messages.push({ role: "user", content: userContent });
  }

  // component.py:68 -- an empty key becomes the literal "none", which is what
  // OpenCode's free tier expects and what the other providers reject anyway.
  const apiKey = req.apiKey.trim() !== "" ? req.apiKey.trim() : "none";

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
