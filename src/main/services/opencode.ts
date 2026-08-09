/**
 * The OpenCode Zen model catalogue.
 *
 * Replaces `BuilderGPTComponent._fetch_opencode_models` (component.py:180-204),
 * which listed `/v1/models` and guessed everything else from the model id --
 * "free" in the name meant free, "think" or "reason" meant a reasoning model.
 * That guess is not good enough now that the API key is required per model
 * rather than per provider, and that we need to know whether a model can accept
 * a reference image at all.
 *
 * Zen's `/models` is a plain OpenAI-compatible listing: `id`, `object`,
 * `created`, `owned_by`, and nothing else -- no pricing, no modalities. The
 * metadata comes from **models.dev**, the catalogue the OpenCode team maintains
 * and the same one OpenCode itself reads (its entry declares
 * `api: https://opencode.ai/zen/v1` and `npm: @ai-sdk/openai-compatible`).
 *
 * The two are merged rather than swapped:
 *
 * - `/models` is authoritative on **availability** -- it is the list of ids the
 *   gateway will actually accept.
 * - models.dev is authoritative on **properties** -- cost and modalities.
 *
 * So the catalogue is the live list, enriched. An id that models.dev has not
 * heard of still appears, marked `unknown`, because a model you cannot see is
 * worse than one whose price we cannot state.
 *
 * No Electron imports: `services/resources.ts` resolves the snapshot path and
 * passes it in, which is also what lets the test suite drive the merge offline.
 */

import { readFile } from "fs/promises";

import type { OpenCodeModelInfo } from "../../shared/ipc.js";
import { PROVIDER_DEFAULT_BASE_URL } from "../../shared/settings.js";

const MODELS_URL = `${PROVIDER_DEFAULT_BASE_URL.OpenCode}/models`;
const MODELS_DEV_URL = "https://models.dev/api.json";
const TTL_MS = 3600_000; // component.py:181 ttl=3600
const TIMEOUT_MS = 5000; // component.py:184 timeout=5
/** models.dev is a ~3.5 MB document; 5s is optimistic for a cold connection. */
const MODELS_DEV_TIMEOUT_MS = 15_000;

/** The subset of a models.dev model entry this app reads. */
export interface ModelsDevEntry {
  name?: string;
  description?: string;
  cost?: { input?: number; output?: number };
  modalities?: { input?: string[] };
  limit?: { context?: number };
  reasoning?: boolean;
}

export type ModelsDevCatalogue = Readonly<Record<string, ModelsDevEntry>>;

let cached: { at: number; models: OpenCodeModelInfo[] } | null = null;

/**
 * component.py:192-198's derived label, kept as the last resort for a model
 * models.dev has no entry for. It is a guess -- "free" in the id -- which is
 * exactly why it is no longer what the key gate consults.
 */
export function labelFor(modelId: string): string {
  const lower = modelId.toLowerCase();
  let category = lower.includes("free") ? "Gratuito" : "A pagamento";
  if (lower.includes("think") || lower.includes("reason")) {
    category += " | Thinking";
  }
  return `${modelId} (${category})`;
}

/** `mimo-v2.5-free` -> `Mimo V2.5 Free`, for ids models.dev does not name. */
function titleCaseId(modelId: string): string {
  return modelId
    .split(/[-_]/)
    .filter((part) => part !== "")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Merges the live id list with models.dev metadata. Pure, so the classification
 * rules can be tested without touching the network.
 *
 * Both "unknown" outcomes fail **open** on purpose: an id with no metadata is
 * not gated behind an API key and not refused an image. Failing closed would
 * turn a models.dev outage into "none of the free models work", which is a far
 * worse failure than a 401 from the gateway with a message that says so.
 */
export function mergeCatalogue(
  liveIds: readonly string[],
  metadata: ModelsDevCatalogue | null,
): OpenCodeModelInfo[] {
  const models = liveIds.map((id): OpenCodeModelInfo => {
    const entry = metadata?.[id];
    if (!entry) {
      return { id, name: titleCaseId(id), pricing: "unknown", imageInput: "unknown" };
    }

    const input = entry.cost?.input;
    const output = entry.cost?.output;
    const pricing =
      typeof input === "number" && typeof output === "number"
        ? input === 0 && output === 0
          ? "free"
          : "paid"
        : "unknown";

    const inputModalities = entry.modalities?.input;
    const imageInput = Array.isArray(inputModalities)
      ? inputModalities.includes("image")
        ? "yes"
        : "no"
      : "unknown";

    return {
      id,
      name: entry.name && entry.name !== "" ? entry.name : titleCaseId(id),
      description: entry.description,
      pricing,
      imageInput,
      contextTokens: entry.limit?.context,
      cost:
        typeof input === "number" && typeof output === "number"
          ? { input, output }
          : undefined,
      reasoning: entry.reasoning === true ? true : undefined,
    };
  });

  // Free first, then paid, alphabetically within each group: the free models
  // are the ones usable without any setup, so they are what a new user needs
  // to find. component.py sorted by id alone.
  const rank = { free: 0, unknown: 1, paid: 2 } as const;
  return models.sort(
    (a, b) => rank[a.pricing] - rank[b.pricing] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

async function fetchLiveIds(): Promise<string[] | null> {
  try {
    const response = await fetch(MODELS_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (response.status !== 200) {
      return null;
    }
    const payload = (await response.json()) as { data?: Array<{ id?: string }> };
    return (payload.data ?? []).map((item) => item.id ?? "").filter((id) => id !== "");
  } catch {
    return null;
  }
}

async function fetchModelsDev(): Promise<ModelsDevCatalogue | null> {
  try {
    const response = await fetch(MODELS_DEV_URL, {
      signal: AbortSignal.timeout(MODELS_DEV_TIMEOUT_MS),
    });
    if (response.status !== 200) {
      return null;
    }
    const payload = (await response.json()) as Record<string, { models?: ModelsDevCatalogue }>;
    return payload.opencode?.models ?? null;
  } catch {
    return null;
  }
}

/** The vendored snapshot, so the dropdown is informative on a first offline run. */
async function readSnapshot(snapshotPath: string | null): Promise<ModelsDevCatalogue | null> {
  if (!snapshotPath) {
    return null;
  }
  try {
    const raw = await readFile(snapshotPath, "utf-8");
    const parsed = JSON.parse(raw) as { models?: ModelsDevCatalogue };
    return parsed.models ?? null;
  } catch {
    return null;
  }
}

export interface FetchCatalogueOptions {
  force?: boolean;
  /** Path to the vendored `opencode_models.json`; see `services/resources.ts`. */
  snapshotPath?: string | null;
}

/**
 * Returns `null` only when the **live** list is unavailable -- the Python
 * original swallowed every exception and returned `None`, and the UI's
 * documented fallback is a free text field ("API fetch failed, type model
 * manually", component.py:258). Preserved: a model list is a convenience,
 * never a precondition. Missing *metadata*, by contrast, is not a failure:
 * the list still comes back, with `unknown` where the facts are missing.
 */
export async function fetchOpenCodeModels(
  options: FetchCatalogueOptions = {},
): Promise<OpenCodeModelInfo[] | null> {
  if (!options.force && cached && Date.now() - cached.at < TTL_MS) {
    return cached.models;
  }

  const [liveIds, metadata] = await Promise.all([fetchLiveIds(), fetchModelsDev()]);
  if (!liveIds || liveIds.length === 0) {
    return null;
  }

  const models = mergeCatalogue(liveIds, metadata ?? (await readSnapshot(options.snapshotPath ?? null)));
  cached = { at: Date.now(), models };
  return models;
}

/** Test seam: drops the TTL cache so the next call refetches. */
export function resetCatalogueCacheForTests(): void {
  cached = null;
}
