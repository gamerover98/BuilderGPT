/**
 * The compile-time version table `core.ts`'s `inputVersionToMcsTag` was written
 * to receive.
 *
 * RULEBOOK.md DEV-014 / ARCHITECTURE.md §5: the inventory row for
 * `input_version_to_mcs_tag` demanded "an explicit lookup table built at
 * compile time", replacing Python's `getattr(mcschematic.Version, name)`
 * dynamic attribute lookup. This IS that table; the function keeps its
 * parameter so it stays independently testable.
 *
 * ## The data moved, the interface did not
 *
 * The rows now live in `shared/mc_versions.ts`, because three places need the
 * same answer and only one of them is main: the format picker offers
 * containers, the writers refuse the ones that cannot work, and the block
 * inventory filters what it shows. What is left here is the *shape* `core.ts`
 * and generation want — a flat `name -> number` map — derived from it.
 *
 * That derivation drops the legacy rows, and deliberately. They carry no
 * `DataVersion` because they write MCEdit, which has no such tag; a map from
 * name to number has nowhere to put "none", and a caller iterating it to build
 * a Sponge file must not be offered a version Sponge cannot express. The full
 * list, both eras, is `MC_VERSION_NAMES`.
 *
 * The old note here said "range starts at 1.13" as though that were a property
 * of Minecraft. It was a property of this table. The range now starts at 1.8.8
 * and the Flattening is recorded as what it is: the line between two eras, with
 * different block encodings and different containers on either side.
 */

import { MC_VERSIONS, mcVersion } from "../../shared/mc_versions.js";

export interface McVersion {
  /** `mcschematic.Version` enum member name, e.g. `JE_1_20_4`. */
  readonly name: string;
  /** Minecraft `DataVersion`. */
  readonly dataVersion: number;
}

/**
 * Every version that has a `DataVersion`, as a flat map.
 *
 * Built rather than written out, so there is one list of versions in the app
 * and not two that can disagree.
 */
const TABLE: Readonly<Record<string, number>> = Object.fromEntries(
  MC_VERSIONS.filter((entry) => entry.dataVersion !== null).map((entry) => [
    entry.name,
    entry.dataVersion as number,
  ]),
);

/** The table itself, as `inputVersionToMcsTag`'s `versionTable` argument. */
export const VERSION_TABLE: Readonly<Record<string, number>> = TABLE;

/**
 * What generation offers, newest first.
 *
 * Still only the versions with a `DataVersion`: generation writes Sponge, so a
 * pre-Flattening choice here would produce a file whose palette names blocks
 * that version has never heard of. The editor's own picker uses
 * `MC_VERSION_NAMES` and filters by container instead.
 */
export const VERSION_NAMES: readonly string[] = Object.keys(TABLE);

export const DEFAULT_VERSION = "JE_1_20_4";

export function dataVersionFor(name: string): number {
  const found = TABLE[name];
  if (found === undefined) {
    const known = mcVersion(name);
    if (known) {
      throw new Error(
        `${known.label} predates the Flattening and carries no DataVersion; it can only be written as MCEdit.`,
      );
    }
    throw new Error(`unknown Minecraft version: ${name}`);
  }
  return found;
}
