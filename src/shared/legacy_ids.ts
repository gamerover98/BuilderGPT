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
}

export function buildLegacyIndex(table: Readonly<Record<string, string>>): LegacyIndex {
  const byName = new Map<string, LegacyId>();
  const byId = new Map<string, string>();
  const names = new Set<string>();

  const rank = (a: LegacyId, b: LegacyId): number => a.id - b.id || a.meta - b.meta;

  for (const [key, modern] of Object.entries(table)) {
    const legacy = parseLegacyId(key);
    if (legacy === null) continue;
    byId.set(key, modern);

    const name = legacyBaseName(modern);
    names.add(name);
    const existing = byName.get(name);
    if (existing === undefined || rank(legacy, existing) < 0) byName.set(name, legacy);
  }

  return { byName, byId, names };
}
