/**
 * The pre-Flattening block table, seen from both directions.
 *
 * `resources/legacy_blocks.json` maps `"id:meta"` to a modern spelling --
 * `"35:14"` to `"minecraft:red_wool"` -- and this app needs it read both ways.
 * Forwards to open a `.schematic`; backwards to write one, to say which blocks
 * a legacy schematic may contain, and to *show* somebody the `ID:DATA` their
 * file will actually store.
 *
 * ## Why this is in `shared/`
 *
 * The renderer has to name an `ID:DATA` in the inventory and accept one typed
 * into the block field, and it may not import out of `main/`. The alternative
 * was a second inversion written in the renderer, which is how the two would
 * come to disagree about which `id:meta` a name maps to -- the same argument
 * `spongeVectors` and `schematicExtension` are already settled by.
 *
 * ## The rank rule, which is the part worth having once
 *
 * Seventy-four modern states are produced by more than one `id:meta` (both
 * `8:0` and `9:0` give `minecraft:water[level=0]`, still water and flowing).
 * The numerically lowest wins, so the answer is deterministic and the same
 * everywhere.
 *
 * ## What this deliberately does not do
 *
 * It does not build the writer's `byState` index. That one re-keys through
 * `parsePaletteEntry` and `paletteEntryCacheKey` so property *order* cannot
 * decide a match, and those live in `main/pipeline/`. Matching an exact state
 * is a different job from naming a block, and the writer keeps it.
 */

/** A pre-Flattening block: a numeric id and a metadata nibble. */
export interface LegacyId {
  readonly id: number;
  readonly meta: number;
}

/** `{ id: 35, meta: 14 }` -> `"35:14"`, which is how anyone writes one down. */
export function legacyIdLabel(value: LegacyId): string {
  return `${value.id}:${value.meta}`;
}

/**
 * `"35:14"` -> `{ id: 35, meta: 14 }`, or `null` for anything else.
 *
 * Strict about the shape rather than forgiving, because this decides whether
 * something a user typed into the block field is an id at all. `minecraft:stone`
 * has a colon in it too.
 */
export function parseLegacyId(text: string): LegacyId | null {
  const match = /^(\d{1,3}):(\d{1,2})$/.exec(text.trim());
  if (match === null) return null;
  const id = Number(match[1]);
  const meta = Number(match[2]);
  // The nibble is four bits and the id is what an MCEdit `Blocks` byte plus an
  // `AddBlocks` nibble can hold. Out of range is not a legacy id, it is a typo.
  if (id > 4095 || meta > 15) return null;
  return { id, meta };
}

/** `"minecraft:oak_stairs[facing=north]"` -> `"minecraft:oak_stairs"`. */
export function legacyBaseName(modern: string): string {
  return modern.split("[")[0];
}

export interface LegacyIndex {
  /** Base name -> the lowest `id:meta` that produces it. */
  readonly byName: ReadonlyMap<string, LegacyId>;
  /** `"35:14"` -> the modern spelling, states and all. */
  readonly byId: ReadonlyMap<string, string>;
  /**
   * Every block a pre-Flattening file can name.
   *
   * The set the editor refuses against, and it is names rather than states on
   * purpose -- see `legacyBlockNames` in `services/writers.ts`, which is the
   * same line the MCEdit writer draws between a fatal loss and a degraded one.
   */
  readonly names: ReadonlySet<string>;
  /**
   * Base name -> every property that block may hold **before the Flattening**.
   *
   * The union across its `ID:DATA` rows, because the states are spread over
   * them: `oak_stairs` is sixty-four rows and each names `facing`, `half` and
   * `shape`, while `stone_slab` names only `type`.
   *
   * This is the pre-1.13 half of a question the modern registry answers for
   * the flat era, and CLAUDE.md's rule about the two tables is why it is a
   * second answer rather than a merge: **each is authoritative exactly where
   * the other says nothing.** Asking the registry about a legacy document
   * offered `waterlogged` on every fence, stair, slab and pane in it -- a
   * property 1.13 introduced, on blocks from versions that had no such idea --
   * which is how it was reported.
   *
   * There is no `waterlogged` anywhere in the 1,682 rows. That is not an
   * accident of the data: it is the era.
   */
  readonly properties: ReadonlyMap<string, ReadonlySet<string>>;
}

export function buildLegacyIndex(table: Readonly<Record<string, string>>): LegacyIndex {
  const byName = new Map<string, LegacyId>();
  const byId = new Map<string, string>();
  const names = new Set<string>();
  const properties = new Map<string, Set<string>>();

  const rank = (a: LegacyId, b: LegacyId): number => a.id - b.id || a.meta - b.meta;

  for (const [key, modern] of Object.entries(table)) {
    const legacy = parseLegacyId(key);
    if (legacy === null) continue;
    byId.set(key, modern);

    const name = legacyBaseName(modern);
    names.add(name);
    const existing = byName.get(name);
    if (existing === undefined || rank(legacy, existing) < 0) byName.set(name, legacy);

    let held = properties.get(name);
    if (held === undefined) {
      held = new Set<string>();
      properties.set(name, held);
    }
    for (const pair of statePairs(modern)) held.add(pair);
  }

  return { byName, byId, names, properties };
}

/** The property names inside `oak_fence[east=false,north=false]`, if any. */
function statePairs(modern: string): string[] {
  const open = modern.indexOf("[");
  if (open < 0 || !modern.endsWith("]")) return [];
  return modern
    .slice(open + 1, -1)
    .split(",")
    .map((pair) => pair.split("=")[0].trim())
    .filter((name) => name !== "");
}

/**
 * Which properties a block may hold in the era this index describes, or `null`
 * where the table has never heard of the block.
 *
 * `null` and an empty set are different answers and the caller has to tell
 * them apart: a block with no states -- `minecraft:stone` -- really holds
 * none, while a block the table does not list is one this era cannot name at
 * all. Offering the modern registry's properties for the second would be the
 * exact claim this function exists to stop making.
 */
export function legacyPropertiesOf(
  index: LegacyIndex | null,
  block: string,
): ReadonlySet<string> | null {
  if (index === null) return null;
  return index.properties.get(legacyBaseName(block)) ?? null;
}

/**
 * The `ID:DATA` a block name is stored as, or `null`.
 *
 * The **base name** only, and that limit is the honest part rather than a gap.
 * `35:14` answers what block this is; it does not answer which *state* an
 * entry carrying `[facing=north]` will be written as, because several metadata
 * values flatten to one name and picking one of them here would be a precise
 * claim built from a vague question.
 *
 * So this labels the places that list bare block names -- the creative grid,
 * the block field -- and deliberately does not label the materials list, which
 * shows full states. The exact state a palette entry maps to is
 * `buildReverseLegacyTable`'s `byState`, in main, where the writer already asks
 * it.
 */
export function legacyIdFor(index: LegacyIndex | null, block: string): string | null {
  if (index === null) return null;
  const found = index.byName.get(legacyBaseName(block));
  return found === undefined ? null : legacyIdLabel(found);
}

/**
 * Turns an `ID:DATA` somebody typed into the block it means.
 *
 * Anything that is not a legacy id is returned untouched, so this can sit in
 * front of the ordinary parse without a mode: `minecraft:stone` has a colon in
 * it and is not one, and `35:14` on a table that has no such row is a typo
 * rather than an invitation to guess.
 *
 * The answer carries its states -- `53:0` is
 * `minecraft:oak_stairs[half=bottom,shape=outer_right,facing=east]`, because
 * that is what the metadata value *means*. Resolving to the bare name would
 * throw away the half of the id that is not the id.
 */
export function resolveBlockInput(text: string, index: LegacyIndex | null): string {
  if (index === null) return text;
  const id = parseLegacyId(text);
  if (id === null) return text;
  return index.byId.get(legacyIdLabel(id)) ?? text;
}
