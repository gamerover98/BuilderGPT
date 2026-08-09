/**
 * The compile-time version table `core.ts`'s `inputVersionToMcsTag` was written
 * to receive.
 *
 * RULEBOOK.md DEV-014 / ARCHITECTURE.md §5: the inventory row for
 * `input_version_to_mcs_tag` demanded "an explicit lookup table built at
 * compile time", replacing Python's `getattr(mcschematic.Version, name)`
 * dynamic attribute lookup. This module-level `const` IS that table; the
 * function keeps its parameter so it stays independently testable.
 *
 * Keys mirror `mcschematic.Version`'s enum member names (`JE_1_20_4`), which is
 * what `component.py:273` put in the Game Version dropdown and what therefore
 * round-trips through saved settings. Values are Minecraft's own `DataVersion`
 * integers -- the number a Sponge schematic must carry in its `DataVersion` tag.
 *
 * Range starts at 1.13: Sponge Schematic v2 stores flattened `namespace:id[state]`
 * block strings, which only exist from the Flattening (1.13) onward, and the
 * loader/mesher this feeds were only ever exercised against flattened data.
 */

export interface McVersion {
  /** `mcschematic.Version` enum member name, e.g. `JE_1_20_4`. */
  readonly name: string;
  /** Minecraft `DataVersion`. */
  readonly dataVersion: number;
}

const TABLE: Readonly<Record<string, number>> = {
  JE_1_21_4: 4189,
  JE_1_21_3: 4082,
  JE_1_21_1: 3955,
  JE_1_21: 3953,
  JE_1_20_6: 3839,
  JE_1_20_4: 3700,
  JE_1_20_2: 3578,
  JE_1_20_1: 3465,
  JE_1_20: 3463,
  JE_1_19_4: 3337,
  JE_1_19_3: 3218,
  JE_1_19_2: 3120,
  JE_1_19: 3105,
  JE_1_18_2: 2975,
  JE_1_18_1: 2865,
  JE_1_18: 2860,
  JE_1_17_1: 2730,
  JE_1_17: 2724,
  JE_1_16_5: 2586,
  JE_1_16_4: 2584,
  JE_1_16_2: 2578,
  JE_1_16_1: 2567,
  JE_1_16: 2566,
  JE_1_15_2: 2230,
  JE_1_15: 2225,
  JE_1_14_4: 1976,
  JE_1_14: 1952,
  JE_1_13_2: 1631,
  JE_1_13: 1519,
};

/** The table itself, as `inputVersionToMcsTag`'s `versionTable` argument. */
export const VERSION_TABLE: Readonly<Record<string, number>> = TABLE;

/** Dropdown contents, newest first -- same ordering `mcschematic.Version` yields. */
export const VERSION_NAMES: readonly string[] = Object.keys(TABLE);

export const DEFAULT_VERSION = "JE_1_20_4";

export function dataVersionFor(name: string): number {
  const found = TABLE[name];
  if (found === undefined) {
    throw new Error(`unknown Minecraft version: ${name}`);
  }
  return found;
}
