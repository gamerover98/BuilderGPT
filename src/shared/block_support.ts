/**
 * What a block needs underneath it before this app will place it.
 *
 * There is exactly one rule here and it is deliberately narrow. Minecraft
 * refuses a great many placements -- a torch on sand, a flower on stone, a rail
 * over a hole -- and reproducing that would be faithful and useless: this is an
 * editor, and the same argument that lets an iron door open here says a builder
 * may put a flower anywhere they like. What earns a rule is a block whose
 * *appearance* lies without one, and redstone dust is that: drawn in mid-air or
 * on the surface of a pond it looks like a working circuit and is a state the
 * game cannot hold.
 *
 * Pure, and in `shared/` for `block_connections.ts`' reason -- it is a fact
 * about Minecraft rather than about a process. Solidity is **passed in**, the
 * same split as `NeighbourBlock.solid`: the answer comes from `coversFace` in
 * `main/pipeline`, which the renderer may not import.
 */

/** The cell under the one being placed into. `null` is outside the document. */
export interface SupportBelow {
  /** Bare or namespaced; both are accepted. */
  readonly name: string;
  /** Whether its shape covers the whole of its top face. `coversFace`'s answer. */
  readonly covers: boolean;
}

/**
 * The fluids, by name. A fluid's *shape* is a full cube, so `coversFace` says
 * yes about a pond and would let a wire float on it.
 */
const FLUIDS: ReadonlySet<string> = new Set(["air", "cave_air", "void_air", "water", "lava"]);

function bare(name: string): string {
  return name.slice(name.indexOf(":") + 1);
}

/** Whether this app refuses to place `id` without a floor under it. */
export function needsFloor(id: string): boolean {
  return bare(id) === "redstone_wire";
}

/**
 * Whether the cell below is something `id` can stand on.
 *
 * Answers `true` for anything the rule does not cover, so a caller may ask
 * about every placement and only the named blocks are ever refused.
 */
export function standsOn(id: string, below: SupportBelow | null): boolean {
  if (!needsFloor(id)) return true;
  if (below === null) return false;
  return !FLUIDS.has(bare(below.name)) && below.covers;
}
