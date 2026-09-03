/**
 * Whether the app has a usable API key for what it is about to ask a model.
 *
 * ## Why this is its own module
 *
 * The rule was written out three times -- twice in `ipc/handlers.ts`, once
 * before generation and once before an agent turn -- and **not at all** on the
 * MCP path, which is the one place where getting it wrong is unreadable. The
 * missing gate there produced the raw provider string:
 *
 * ```
 * generate_schematic  LLM API Error: Invalid API key.
 * ```
 *
 * `LlmError` prefixes `LLM API Error: ` and `Invalid API key.` is OpenCode
 * Zen's own answer to an empty key, so what a person sees is a sentence about
 * an API key arriving from a server they have just authenticated to with a
 * bearer token. It was reported, reasonably, as an MCP authentication problem.
 * It is not one: this is the app spending the *user's* provider budget, and the
 * key it wants is the one in the app's own settings.
 *
 * So the check is one function, and the sentence it returns names the provider.
 * The caller supplies the surroundings, because the two audiences want opposite
 * things: a person at the keyboard is already looking at the window that has
 * the field in it, and a model needs to be told which window that is.
 *
 * ## Why the path is a parameter
 *
 * `openCodeSnapshotPath()` reaches Electron and `services/resources.ts` with
 * it, which would put this out of reach of the suites. Injected as a string,
 * exactly as `ToolContext.legacyBlocksPath` and `DocumentSpec.run`'s third
 * parameter are, for the same reason.
 */

import { providerRequiresApiKey, type Provider } from "../../shared/settings.js";
import { openCodeModelRequiresKey } from "../../shared/ipc.js";
import { fetchOpenCodeModels } from "./opencode.js";

export interface KeyCheck {
  provider: Provider;
  model: string;
  apiKey: string;
  /** Where the vendored `opencode_models.json` is; `null` if unavailable. */
  snapshotPath: string | null;
  /**
   * The pre-rename profile, when it has keys and this one does not.
   *
   * Said at the moment of the failure, which is the only moment somebody is
   * certain to be looking. The rename moved userData and nothing migrates, so
   * an install with working keys came back with none and generation stopped;
   * what surfaced was the provider's `Invalid API key.`, pointing at a key
   * that was set, in a folder the app had stopped reading. Two reports.
   */
  legacyProfilePath?: string | null;
}

/**
 * The reason this call cannot be made, or `null`.
 *
 * OpenCode is asked **per model** rather than per provider, because that is how
 * its billing works: some of its models are free and the proportion moves --
 * 9 of 61 when the gate was written, 26 of 87 now -- so a provider-level rule
 * would refuse a free model or admit a paid one depending on the year. Missing
 * metadata fails *open*, which `openCodeModelRequiresKey` already decides: a
 * models.dev outage must not make the free models unusable.
 */
export async function apiKeyRefusal(check: KeyCheck): Promise<string | null> {
  if (check.apiKey.trim() !== "") return null;

  if (check.provider === "OpenCode") {
    const catalogue = await fetchOpenCodeModels({ snapshotPath: check.snapshotPath });
    const model = catalogue?.find((entry) => entry.id === check.model);
    if (!openCodeModelRequiresKey(model)) return null;
    return withLegacyHint(
      `${model?.name ?? check.model} is a paid OpenCode model and no API key is set. ` +
        `Add one, or pick one of the free models in the LLM provider panel.`,
      check,
    );
  }

  if (!providerRequiresApiKey(check.provider)) return null;
  return withLegacyHint(`No API key is set for ${check.provider}.`, check);
}

/**
 * The sentence, plus where the old keys are when there are some.
 *
 * Appended rather than replacing: the first half is what is wrong and the
 * second is why it might be surprising. On a clean install the clause is
 * absent, so nothing invents a folder that was never there.
 */
function withLegacyHint(refusal: string, check: KeyCheck): string {
  const legacy = check.legacyProfilePath;
  if (legacy === undefined || legacy === null || legacy === "") return refusal;
  return (
    `${refusal} An earlier version of this app stored keys in ${legacy}, and this ` +
    `one does not read them — paste the key again under Settings → LLM provider.`
  );
}
