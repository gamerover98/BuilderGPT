// Ported from app/pipeline/translate.py.
//
// TODO(port): NEEDS RULEBOOK RATIFICATION. RULEBOOK.md §1 "No-equivalent-library
// pattern" row sanctions dependency injection only for genuinely no-equivalent
// cases, with one concrete named example (`mcschematic`). `pymctranslate` has
// no named npm replacement anywhere in §1's third-party-deps row (only
// `pngjs`, `adm-zip`, `prismarine-nbt` are named — `prismarine-nbt` covers
// `nbtlib`, not this file's dependency), so DI is the correct pattern *class*
// here, but this is an EXTENSION of the row to a case not explicitly named in
// its table. Per the row's tightened wording (closing stress-test round 2's
// DEV-009 finding, where the same implementer flagged an identical situation
// as ratification-needed in one file and silently pre-approved in another):
// this must be flagged inline, not silently treated as pre-approved, even
// though the pattern class itself is clearly sanctioned. Resolving
// inventory.tsv's `translate.py normalize_palette` row ("needs rulebook
// decision, not just translation" — bundle a hard npm dep, or an explicit
// feature-flag/DI seam, never an implicit try/catch on `require`): since no
// hard npm equivalent of `pymctranslate` exists, this port takes the DI seam
// option (a caller-supplied `PaletteTranslator`, possibly `undefined`) rather
// than inventing a third convention. Flag stands until the human ratifies it
// at a rulebook gate.

import type { PaletteEntry, StructureData } from "./types.js";

/**
 * DI seam replacing Python's `pymctranslate.TranslationManager` /
 * `translator.block` API surface (translate.py:6, 24-25, 33-36). The
 * consuming module takes this as a caller-supplied interface instead of
 * importing a concrete translation library — see the ratification-needed
 * note above.
 *
 * inventory.tsv `translate.py normalize_palette (per-entry loop)` row:
 * `to_universal`'s `properties` result is itself a union — either a
 * dict-like mapping directly, or a list of dicts to be merged. The return
 * type here reflects that union explicitly rather than assuming one shape.
 */
export interface PaletteTranslator {
  /**
   * Mirrors `translator.block.from_universal(entry.namespaced_name, entry.properties)`
   * (translate.py:33-35) followed immediately by
   * `translator.block.to_universal(block)` (translate.py:36) — the source
   * never observes the intermediate "versioned block" value, so this seam
   * collapses both calls into one round-trip to keep the no-equivalent-library
   * boundary at exactly the granularity the source uses it.
   *
   * Returns `null` for the "normalized is None" branch (translate.py:40-42:
   * fall back to the original entry), or a `[name, properties]` pair mirroring
   * `normalized = (name, properties)` (translate.py:43).
   *
   * MAY THROW. Implementations are not required to catch their own translation
   * failures — `normalizePalette` isolates per-entry errors itself (mirroring
   * Python's `except Exception:` around this exact pair of calls, translate.py:
   * 32-39) by catching here and falling back to the original entry. Added
   * 2026-08-05 per Step 3 review (translate.ts reviewer 2): this contract was
   * previously only inferable from the one caller that happens to exist today,
   * not stated on the interface itself.
   */
  normalizeBlock(
    namespacedName: string,
    properties: Readonly<Record<string, string>>,
  ): [string, Record<string, string> | Record<string, string>[]] | null;
}

/**
 * Best-effort palette normalisation using an injected `PaletteTranslator`.
 *
 * Ported from `normalize_palette` (translate.py:11-50).
 *
 * inventory.tsv `translate.py normalize_palette` row (import-guard,
 * confirmed): Python's `try: from pymctranslate import TranslationManager
 * except ImportError: TranslationManager = None` (translate.py:5-9), then
 * `if TranslationManager is None: return struct` (translate.py:20-21) is an
 * optional-dependency no-op fallback. Node has no equivalent "package failed
 * to import" runtime state for a *required* import the way Python's
 * try/except ImportError does at module scope — per the DI decision above,
 * this becomes "no translator was supplied", i.e. `translator === undefined`,
 * checked explicitly rather than an implicit failed `require`.
 *
 * inventory.tsv `translate.py normalize_palette (per-entry loop)` row
 * (per-entry fault isolation, confirmed — "a real behavioral requirement,
 * not just typing noise"): a translation failure on ONE palette entry must
 * not abort the whole structure's translation. Preserved exactly: the
 * try/catch is scoped to a single loop iteration, and a caught error falls
 * back to re-appending the original `entry`, matching translate.py:37-39.
 *
 * The `manager.get_version(target)` construction/version-lookup failure
 * (translate.py:23-28, its own broad `except Exception: return struct`) has
 * no DI-seam equivalent to fail at construction time here — a translator
 * that can't resolve `target` at all is the injecting caller's
 * responsibility to not hand in; this function only owns the per-entry loop.
 */
export function normalizePalette(
  struct: StructureData,
  translator: PaletteTranslator | undefined,
): StructureData {
  if (translator === undefined) {
    return struct;
  }

  const newPalette: PaletteEntry[] = [];
  for (const entry of struct.palette) {
    let normalized: [string, Record<string, string> | Record<string, string>[]] | null;
    try {
      normalized = translator.normalizeBlock(entry.namespacedName, entry.properties);
    } catch {
      // Per-entry fault isolation — inventory.tsv row above. One bad entry
      // falls back to itself; the rest of the structure keeps translating.
      newPalette.push(entry);
      continue;
    }

    if (normalized === null) {
      newPalette.push(entry);
      continue;
    }

    const [name, rawProperties] = normalized;
    let properties: Record<string, string>;
    if (Array.isArray(rawProperties)) {
      // inventory.tsv return-union row: `to_universal`'s properties result
      // may be a list of dicts to merge (translate.py:44-48), not just a
      // single mapping. Mirrors `merged = {}; for prop in properties:
      // merged.update(prop)` — later entries in the list win on key
      // collision, same as Python dict.update().
      const merged: Record<string, string> = {};
      for (const prop of rawProperties) {
        Object.assign(merged, prop);
      }
      properties = merged;
    } else {
      properties = rawProperties;
    }

    newPalette.push({ namespacedName: name, properties: { ...properties } });
  }

  return { bounds: struct.bounds, palette: newPalette, voxels: struct.voxels };
}

// PORT STATUS: confidence=medium todos=1
