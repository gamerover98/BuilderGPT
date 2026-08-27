// Ported from app/pipeline/types.py.
//
// Data-object shape: RULEBOOK.md §1 "Data-object shape for ported @dataclass"
// row — interface + free functions, not class + getters/methods. Plain
// objects survive Electron's structured-clone IPC boundary without extra
// (de)serialization; classes with methods don't.
//
// Internal keyed collections use Record<string, T>, not Map<string, T> —
// RULEBOOK.md §1 "Internal keyed-collection type" row. No site in this file
// needs non-string keys or Map's insertion-order guarantees.

/**
 * `StructureBounds` — ported from `types.py:11-25` (`@dataclass(frozen=True)`).
 * inventory.tsv confirms this frozen dataclass has no aliasing gap (all
 * fields are plain ints, copied by value in both languages) — a
 * `readonly`-fielded interface is a direct, gap-free fit, no decision needed.
 */
export interface StructureBounds {
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
}

/**
 * Ported from `StructureBounds.size` (`types.py:19-25`), a `@property` on
 * the frozen dataclass. Per the interface+functions convention (RULEBOOK.md
 * §1), properties on ported dataclasses become free functions taking the
 * interface as their first argument, e.g. `entry.cacheKey` -> `paletteEntryCacheKey(entry)`.
 */
export function structureBoundsSize(bounds: StructureBounds): readonly [number, number, number] {
  return [
    bounds.maxX - bounds.minX + 1,
    bounds.maxY - bounds.minY + 1,
    bounds.maxZ - bounds.minZ + 1,
  ];
}

/**
 * `PaletteEntry` — ported from `types.py:29-66` (`@dataclass(frozen=True)`).
 *
 * TODO(port): rulebook silent on the immutability-enforcement question
 * raised by inventory.tsv row `PaletteEntry.properties` (types.py:28-31) —
 * the source's `frozen=True` + `Mapping[str, str]` is a *documented*
 * contract, not one the Python type system enforces either (a caller could
 * still mutate the dict passed in). No rulebook row in §1/§2 resolves
 * whether the TS port should go further and call `Object.freeze` at
 * construction. Per §2's UNKNOWN rule, taking the most conservative
 * (= source-matching) representation: `readonly` on the field only, same
 * documented-but-unenforced contract as the source, no `Object.freeze`
 * added. Revisit if the rulebook is amended.
 */
export interface PaletteEntry {
  readonly namespacedName: string;
  readonly properties: Readonly<Record<string, string>>;
}

/** Ported from `PaletteEntry.cache_key` (`types.py:33-40`). */
export function paletteEntryCacheKey(entry: PaletteEntry): string {
  const keys = Object.keys(entry.properties);
  if (keys.length === 0) {
    return entry.namespacedName;
  }
  const props = keys
    .slice()
    .sort()
    .map((key) => `${key}=${entry.properties[key]}`)
    .join(",");
  return `${entry.namespacedName}[${props}]`;
}

/**
 * Ported from `PaletteEntry.is_air` (`types.py:42-45`), widened on purpose.
 *
 * The source matched `:air` only, which is `minecraft:air` and nothing else --
 * `minecraft:cave_air` and `minecraft:void_air` end in `_air`, not `:air`. Both
 * are air in every sense that matters here: the game draws neither, and a
 * schematic cut out of a cave is full of the first one. Left out, they were
 * meshed as solid cubes wearing a hashed fallback colour *and* they hid every
 * neighbouring face, walling the structure in.
 *
 * This predicate is the single answer to "is there nothing here", used by the
 * mesher for both questions it asks of a voxel: skip it as a source, and never
 * let it occlude (`block_shapes.ts`'s `occludesNeighbours`).
 */
export function paletteEntryIsAir(entry: PaletteEntry): boolean {
  // Any namespace, not just `minecraft:` -- the source's `endsWith(":air")`
  // accepted a modded one and there is no reason to narrow that.
  const name = entry.namespacedName.replace(/^[^:]*:/, "");
  return name === "air" || name === "cave_air" || name === "void_air";
}

/**
 * Loose shape of a decoded NBT tag as `prismarine-nbt`'s `parse()` returns it.
 *
 * Lives here rather than in `loader_formats.ts` (which is where it started)
 * because block entities carry raw NBT and both the decoder and the document
 * model need to name that type. `loader_formats.ts` re-exports both for its
 * existing importers.
 */
export interface NbtTag {
  readonly type: string;
  readonly value: unknown;
}

export type NbtCompound = Record<string, NbtTag>;

/**
 * A block entity: the NBT a chest, sign, banner or spawner carries in addition
 * to its block state.
 *
 * Nothing in the app read these before -- the decoder produced blocks and
 * nothing else, and the writer emitted none -- so every import silently threw
 * away chest contents and sign text. They are kept **verbatim**: `nbt` is
 * whatever the file held, unmodelled, because modelling per block type would
 * discard exactly the fields nobody thought to anticipate.
 */
export interface BlockEntityRecord {
  /** `minecraft:chest`. Namespaced even when the file spelled it bare. */
  readonly id: string;
  /** Grid coordinates, relative to the schematic origin like the voxels are. */
  readonly pos: readonly [number, number, number];
  /** Everything else the entry carried, minus the id and position. */
  readonly nbt: NbtCompound;
}

/**
 * An entity — a mob, item frame, armour stand — stored with the schematic.
 *
 * Position is floating point and relative to the schematic origin, which is
 * why this is not just a `BlockEntityRecord`: an item frame at x=3.5 is on a
 * block face, and rounding it to the voxel grid would move it.
 */
export interface EntityRecord {
  readonly id: string;
  readonly pos: readonly [number, number, number];
  readonly nbt: NbtCompound;
}

/**
 * `StructureData` — ported from `types.py:70-73` (plain, non-frozen
 * `@dataclass`).
 *
 * `voxels`: source comment documents "np.int32 array with palette indices",
 * shape `(width, height, length)`, flattened per the RULEBOOK.md §2
 * "StructureData.voxels flat-array index formula" row:
 * `x * height * length + y * length + z` (row-major, matches numpy's C-order
 * storage for `np.zeros((width, height, length))`). Every consumer
 * (loader.ts, mesher.ts, gltf_builder.ts) must use this exact formula.
 *
 * TODO(port): rulebook silent on inventory.tsv's `StructureData.voxels`
 * dtype/shape-contract row (types.py:73) — whether to close the
 * weak-typing gap (source documents dtype/shape only in a comment, not
 * enforced by `np.ndarray`) with a dims-carrying wrapper + validate-on-
 * construct, or accept parity with the source's weak guarantee. Per §2's
 * UNKNOWN rule, taking the conservative option: plain `Int32Array` with
 * the shape documented in this comment, same weak guarantee as the
 * source, no wrapper/validation added. Revisit if the rulebook is amended.
 */
export interface StructureData {
  readonly bounds: StructureBounds;
  readonly palette: readonly PaletteEntry[];
  /** Int32Array, palette indices, row-major over (width, height, length) — see comment above. */
  readonly voxels: Int32Array;
}

/**
 * `BakedFace` — ported from `types.py:77-89` (plain `@dataclass`).
 * `positions`: shape (4, 3) float32. `uvs`: shape (4, 2) float32.
 * Flattened to typed arrays since TS has no shape-carrying ndarray type
 * (same weak-typing gap as the source's numpy usage — accepted per the
 * StructureData.voxels TODO above, same underlying gap).
 */
export interface BakedFace {
  /** Float32Array, length 12 (4 verts * 3 comps), row-major (x,y,z per vertex). */
  readonly positions: Float32Array;
  /** Float32Array, length 8 (4 verts * 2 comps), row-major (u,v per vertex). */
  readonly uvs: Float32Array;
  readonly normal: readonly [number, number, number];
  readonly textureKey: string;
  /**
   * How lit and how buried each of the four vertices is: block light, sky
   * light and occlusion, each 0..1, twelve floats in vertex order.
   *
   * Absent on a face straight out of the baker -- it is a property of *where
   * the block is*, not of what it looks like, so only `culledFaces` can fill
   * it in, and only when it was given a light grid to read. A face without it
   * meshes at full daylight and no occlusion, which is exactly what the
   * viewport did before any of this existed.
   */
  readonly shade?: Float32Array;
}

/** Ported from `BakedFace.offset` (`types.py:83-89`). */
export function bakedFaceOffset(
  face: BakedFace,
  dx: number,
  dy: number,
  dz: number,
  shade?: Float32Array,
): BakedFace {
  const positions = new Float32Array(face.positions.length);
  for (let i = 0; i < face.positions.length; i += 3) {
    positions[i] = face.positions[i] + dx;
    positions[i + 1] = face.positions[i + 1] + dy;
    positions[i + 2] = face.positions[i + 2] + dz;
  }
  return {
    positions,
    uvs: face.uvs.slice(),
    normal: face.normal,
    textureKey: face.textureKey,
    shade,
  };
}

/**
 * `MeshBuffers` — ported from `types.py:93-97` (plain `@dataclass`).
 * Field dtypes match the source comments: positions/normals/uvs are
 * float32, indices are uint32.
 */
export interface MeshBuffers {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array;
  readonly indices: Uint32Array;
  /**
   * Three floats per vertex: block light, sky light, occlusion.
   *
   * Kept as three channels rather than one brightness because only one of them
   * moves with the time of day. Folding them together here would mean
   * re-meshing the whole document every time the sun moved -- and a torch
   * would go out at dusk along with the sky.
   */
  readonly light: Float32Array;
  /**
   * How many of `indices` at the front belong to faces that can be drawn in the
   * opaque pass. The rest are translucent and must be blended.
   *
   * One number rather than a second set of buffers: the vertices are the same
   * vertices and the split is a draw order, so the renderer expresses it as two
   * geometry groups over one geometry. Zero translucent faces leaves this equal
   * to `indices.length`, which is what every caller that predates it sees.
   *
   * The distinction is *not* "has alpha". A cutout — leaves, petals, a rail —
   * is handled by `alphaTest` in the opaque pass, where it writes depth and
   * needs no sorting. This is for the textures that are genuinely part-way
   * see-through, which today is water, ice, the nether portal and stained
   * glass: they pass any alpha test and then draw solid.
   */
  readonly opaqueIndices: number;
}

/**
 * Replacement for Python's `PIL.Image.Image` — RULEBOOK.md §1 "Image
 * composition" row: hand-rolled composition against a plain
 * `RgbaImage {width, height, data: Uint8Array}` struct (resize/pad/paste as
 * free functions operating on that struct), not a native-binding library
 * like `sharp`. `data` is RGBA8, row-major, length = width * height * 4.
 * Defined here (not in atlas.ts) since it is a shared data shape consumed
 * across the pipeline (atlas.ts produces it, gltf_builder.ts/model_baker.ts
 * consume it via AtlasResult below).
 */
export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  /** Uint8Array, RGBA8, row-major, length = width * height * 4. */
  readonly data: Uint8Array;
}

/**
 * A single atlas UV rect: (u0, v0, u1, v1).
 *
 * TODO(port): inventory.tsv row `AtlasResult.uv_rects` (types.py:103)
 * flags the source's bare `Tuple[float, float, float, float]` as a design
 * -improvement opportunity — a named `{u0,v0,u1,v1}` interface instead of
 * an unnamed positional tuple — and explicitly defers it as "human's call
 * whether to take it." No rulebook row in §1/§2 records that the human
 * took it. Per §2's UNKNOWN rule, keeping the conservative/parity option:
 * a readonly 4-tuple in (u0, v0, u1, v1) order, matching the source's own
 * positional-unpacking convention at every call site (atlas.py:55-58,
 * mesher.py:79: `u0, v0, u1, v1 = rect`). If the human later ratifies the
 * named-interface improvement, this type and its consumers should be
 * revisited together.
 */
export type UVRect = readonly [u0: number, v0: number, u1: number, v1: number];

/**
 * `AtlasResult` — ported from `types.py:101-103` (plain `@dataclass`).
 * `uv_rects`: `Record<string, UVRect>`, not `Map`, per RULEBOOK.md §1
 * "Internal keyed-collection type" row (this dict is named explicitly in
 * that row's rationale).
 */
export interface AtlasResult {
  readonly image: RgbaImage;
  readonly uvRects: Record<string, UVRect>;
}

/**
 * `GLBResult` — ported from `types.py:107-110` (plain `@dataclass`).
 * `glb_bytes`: raw binary GLB payload -> `Uint8Array` (closest TS
 * equivalent of Python `bytes`).
 */
export interface GLBResult {
  readonly glbBytes: Uint8Array;
  readonly center: readonly [number, number, number];
  readonly size: readonly [number, number, number];
}

// PORT STATUS: confidence=high todos=3
