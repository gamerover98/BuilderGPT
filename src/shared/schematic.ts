/**
 * Schematic vocabulary shared by main and the renderer.
 *
 * `SchematicFormat` started in `pipeline/loader_formats.ts`, which is where it
 * is decided. It moved here once the renderer needed to name it too -- the
 * title bar says which container the open document is, and the Save As menu
 * offers the others. Like everything in `shared/`, this file imports nothing
 * and touches no Electron, so both processes can read it.
 */

export type SchematicFormat = "sponge2" | "sponge3" | "mcedit" | "litematic";

/**
 * Every container the app can write, best first.
 *
 * Ordered rather than a set: a format picker that has to sort its own options
 * is a picker whose order can drift from this file's.
 */
export const SCHEMATIC_FORMATS: readonly SchematicFormat[] = [
  "sponge3",
  "litematic",
  "sponge2",
  "mcedit",
];

/** How each container is described to a human. */
export const SCHEMATIC_FORMAT_LABEL: Readonly<Record<SchematicFormat, string>> = {
  sponge2: "Sponge v2 (.schem)",
  sponge3: "Sponge v3 (.schem)",
  mcedit: "MCEdit legacy (.schematic)",
  litematic: "Litematica (.litematic)",
};

/**
 * The extension each container is conventionally stored under.
 *
 * **This is the only copy.** It was written out three times — here, as
 * `extensionFor` in `writers.ts`, and inline in `App.svelte` — which was
 * harmless while the answer was a single ternary and stopped being harmless the
 * moment a fourth container arrived: two of the three would have gone on
 * calling a `.litematic` a `.schem`, and the file would have saved.
 */
export function schematicExtension(format: SchematicFormat): string {
  if (format === "mcedit") return "schematic";
  if (format === "litematic") return "litematic";
  return "schem";
}

/**
 * Where a WorldEdit vector actually sits inside a file of this container.
 *
 * This exists because the app was right and looked wrong. The anchor is written
 * on every save, in all three formats -- but *where* it lands differs, and the
 * panel that sets it said "Offset" regardless. In a Sponge v3 file that is the
 * top-level tag and true; in a v2 file the top-level `Offset` holds the world
 * corner instead and the anchor is off in `Metadata`, so the sentence pointed
 * at a tag containing a different vector. Someone who then looked where they
 * were told, found the wrong number or no `WE*` key at all, and reported the
 * anchor as never written, would be reasoning correctly from what the app said.
 *
 * The table is `spongeVectors`'s, in `main/pipeline/loader_formats.ts`, and it
 * is here rather than there for the reason `openCodeModelRequiresKey` is in
 * `shared/`: the renderer has to name the tag and may not import out of `main/`.
 * Two copies of a table is how the two come to disagree, so `tests/formats.ts`
 * saves a real file and walks the path this names -- the vector has to be
 * exactly there, in every format, or the check fails.
 */
export interface TagLocation {
  /** Compound names from the root down; empty when the tag sits at the root. */
  readonly path: readonly string[];
  /**
   * The tag holding it, or the stem of the three that do. `"triple"` means
   * `X`, `Y` and `Z` are appended -- WorldEdit's own MCEdit spelling, which
   * Sponge v2 kept for the anchor and nothing else.
   */
  readonly tag: string;
  readonly kind: "vector" | "triple";
}

/**
 * Where the paste anchor is stored. `doc.offset`'s home.
 *
 * `null` for a container that has nowhere to put one, which Litematica is: it
 * has a region `Position` and a `Metadata.EnclosingSize` and no concept of a
 * paste anchor at all. Nullable rather than pointed at some plausible tag,
 * because these two functions exist precisely to stop the app naming a tag that
 * does not hold what it says — inventing `Metadata.WEOffsetX` here would be
 * the same mistake in a new container, and the file would even round-trip
 * through this app while meaning nothing to Litematica.
 */
export function anchorLocation(format: SchematicFormat): TagLocation | null {
  if (format === "litematic") return null;
  if (format === "sponge3") return { path: [], tag: "Offset", kind: "vector" };
  if (format === "sponge2") return { path: ["Metadata"], tag: "WEOffset", kind: "triple" };
  return { path: [], tag: "WEOffset", kind: "triple" };
}

/**
 * Where the world position of the minimum corner is stored. `doc.worldOrigin`.
 *
 * `null` for Litematica, for `anchorLocation`'s reason.
 */
export function originLocation(format: SchematicFormat): TagLocation | null {
  if (format === "litematic") return null;
  if (format === "sponge3") return { path: ["Metadata", "WorldEdit"], tag: "Origin", kind: "vector" };
  if (format === "sponge2") return { path: [], tag: "Offset", kind: "vector" };
  return { path: [], tag: "WEOrigin", kind: "triple" };
}

/** The path as a person reads it: `Metadata.WEOffsetX/Y/Z`. */
export function tagPathLabel(location: TagLocation): string {
  const name = location.kind === "triple" ? `${location.tag}X/Y/Z` : location.tag;
  return [...location.path, name].join(".");
}
