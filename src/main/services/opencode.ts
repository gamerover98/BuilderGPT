/**
 * Ported from `BuilderGPTComponent._fetch_opencode_models`
 * (component.py:180-204).
 *
 * The Python original was wrapped in `@st.cache_data(ttl=3600)`; that decorator
 * existed because Streamlit re-ran the whole module on every widget
 * interaction, so an uncached fetch would have hit the network on each
 * keystroke. Electron has no rerun loop, but the TTL cache is still worth
 * keeping: the renderer refetches whenever the provider dropdown lands on
 * OpenCode.
 */

import type { OpenCodeModel } from "../../shared/ipc.js";
import { PROVIDER_DEFAULT_BASE_URL } from "../../shared/settings.js";

const MODELS_URL = `${PROVIDER_DEFAULT_BASE_URL.OpenCode}/models`;
const TTL_MS = 3600_000; // component.py:181 ttl=3600
const TIMEOUT_MS = 5000; // component.py:184 timeout=5

let cached: { at: number; models: OpenCodeModel[] } | null = null;

/**
 * component.py:192-198 -- the label is derived, not returned by the API:
 * "free" anywhere in the id means Gratuito, otherwise A pagamento; "think" or
 * "reason" appends " | Thinking".
 */
export function labelFor(modelId: string): string {
  const lower = modelId.toLowerCase();
  let category = lower.includes("free") ? "Gratuito" : "A pagamento";
  if (lower.includes("think") || lower.includes("reason")) {
    category += " | Thinking";
  }
  return `${modelId} (${category})`;
}

/**
 * Returns `null` on any failure -- the Python original swallowed every
 * exception and returned `None`, and the UI's documented fallback is a free
 * text field ("API fetch failed, type model manually", component.py:258).
 * Preserved: a model list is a convenience, never a precondition.
 */
export async function fetchOpenCodeModels(force = false): Promise<OpenCodeModel[] | null> {
  if (!force && cached && Date.now() - cached.at < TTL_MS) {
    return cached.models;
  }

  try {
    const response = await fetch(MODELS_URL, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status !== 200) {
      return null;
    }
    const payload = (await response.json()) as { data?: Array<{ id?: string }> };
    const models: OpenCodeModel[] = [];
    for (const item of payload.data ?? []) {
      const id = item.id ?? "";
      if (!id) {
        continue;
      }
      models.push({ id, label: labelFor(id) });
    }
    models.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    cached = { at: Date.now(), models };
    return models;
  } catch {
    return null;
  }
}
