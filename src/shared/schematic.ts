/**
 * Schematic vocabulary shared by main and the renderer.
 *
 * `SchematicFormat` started in `pipeline/loader_formats.ts`, which is where it
 * is decided. It moved here once the renderer needed to name it too -- the
 * title bar says which container the open document is, and the Save As menu
 * offers the others. Like everything in `shared/`, this file imports nothing
 * and touches no Electron, so both processes can read it.
 */

export type SchematicFormat = "sponge2" | "sponge3" | "mcedit";

/** How each container is described to a human. */
export const SCHEMATIC_FORMAT_LABEL: Readonly<Record<SchematicFormat, string>> = {
  sponge2: "Sponge v2 (.schem)",
  sponge3: "Sponge v3 (.schem)",
  mcedit: "MCEdit legacy (.schematic)",
};

/** The extension each container is conventionally stored under. */
export function schematicExtension(format: SchematicFormat): string {
  return format === "mcedit" ? "schematic" : "schem";
}
