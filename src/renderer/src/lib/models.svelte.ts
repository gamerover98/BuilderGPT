/**
 * OpenCode's model catalogue, fetched once and shared.
 *
 * This used to live inside `ProviderConfig`, which was fine while that panel
 * was the only thing that needed it. It now has two readers -- the model picker
 * in the chat composer, and the reference-image field in Structure, which is
 * enabled or disabled by whether the chosen model accepts pictures. Two
 * components each running their own fetch would mean two requests and two
 * answers that could disagree.
 *
 * `.svelte.ts` because the catalogue is `$state`: both readers re-render when
 * it lands. See `bridge.svelte.ts` for why that extension is not optional.
 *
 * Only OpenCode publishes a list. The other three providers take a model id as
 * free text, which is why `catalogue()` is null for them rather than empty --
 * "no list exists" and "the list is empty" want different UI.
 */

import { type OpenCodeModelInfo } from "../../../shared/ipc.js";
import { type Provider } from "../../../shared/settings.js";
import { api, bridgeAvailable } from "./bridge.svelte.js";

let catalogue = $state<OpenCodeModelInfo[] | null>(null);
let fetchFailed = $state(false);

/** The provider the current catalogue belongs to, so a switch refetches once. */
let loadedFor: Provider | null = null;

export function openCodeCatalogue(): OpenCodeModelInfo[] | null {
  return catalogue;
}

/**
 * True when the list was asked for and did not arrive.
 *
 * Distinct from "not loaded yet": the picker falls back to a free-text field on
 * a failure, and doing that while the request is still in flight would flicker.
 */
export function openCodeFetchFailed(): boolean {
  return fetchFailed;
}

/**
 * Fetches the catalogue for `provider`, at most once per provider.
 *
 * `onPreferred` is called when the settings name a model the list does not
 * contain -- porting component.py:251-255, which reset the box to
 * `mimo-v2.5-free`. Passed in rather than written here because the settings
 * belong to `App.svelte` and this module deliberately owns no part of them.
 */
export function loadOpenCodeModels(
  provider: Provider,
  currentModel: string,
  onPreferred: (model: string) => void,
): void {
  if (!bridgeAvailable) return;

  if (provider !== "OpenCode") {
    catalogue = null;
    fetchFailed = false;
    loadedFor = null;
    return;
  }
  if (loadedFor === provider) return;
  loadedFor = provider;

  void api()
    .listOpenCodeModels()
    .then((models) => {
      catalogue = models;
      fetchFailed = models === null;
      if (models && !models.some((model) => model.id === currentModel)) {
        const preferred = models.find((model) => model.id === "mimo-v2.5-free") ?? models[0];
        if (preferred) onPreferred(preferred.id);
      }
    })
    .catch(() => {
      // A rejected invoke, not a null answer. Same outcome for the UI: offer
      // the free-text field rather than an empty dropdown.
      catalogue = null;
      fetchFailed = true;
    });
}

/** The catalogue entry for `model`, or null when there is no list to look in. */
export function findOpenCodeModel(
  provider: Provider,
  model: string,
): OpenCodeModelInfo | null {
  if (provider !== "OpenCode" || catalogue === null) return null;
  return catalogue.find((entry) => entry.id === model) ?? null;
}
