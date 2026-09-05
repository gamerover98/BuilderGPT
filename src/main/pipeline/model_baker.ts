// Ported from app/pipeline/model_baker.py.
//
// RULEBOOK.md §2 `_bake_with_reader` / `ModelLoader` row (DEV-008, confirmed
// 2026-08-05): the Python method always returned `None` regardless of
// whether the optional `minecraft_model_reader` import succeeded — confirmed
// dead code. `_bake_with_reader` and any `ModelLoader` type are DROPPED
// ENTIRELY in this port, not stubbed. `ModelBaker` goes straight to the
// fallback baker.
//
// RULEBOOK.md §1 "Async model" row: file I/O (reading resource-pack bytes,
// decoding PNGs) is async/`Promise`-based at the I/O boundary. Pure in-memory
// computation (face geometry, hashing, key normalization) stays synchronous.
// RULEBOOK.md §1 "Standard library I/O" row: `fs/promises`, catch-ENOENT-
// rethrow-else — except at the one site inventory.tsv explicitly overrides
// this (see `readBytes` below).
// RULEBOOK.md §1 "Third-party deps" / "Image composition" rows: `pngjs` for
// PNG decode only (no composition needed in this file), `adm-zip` for zip
// reading (sync API is the named, sanctioned exception).
// RULEBOOK.md §1 "Data-object shape" row: interface + free functions, not
// class + getters, for ported `@dataclass`es — applies to `BakedBlock` below.
// RULEBOOK.md §1 "Internal keyed-collection type" row: `Record<string, T>`
// for the texture/palette caches and `_SPECIAL_FACE_RULES`-equivalent table.
// RULEBOOK.md §2 error-recovery rule: every guard in this file's
// inventory.tsv rows is `precondition-guard` (confirmed, no allocation-class
// sites) — collapsed-to-null sentinels below are intentional, not bugs.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import AdmZip from "adm-zip";
import { PNG } from "pngjs";

import { defaultStateFor } from "../../shared/block_states.js";
import { DEFAULT_BIOME_COLOR, DEFAULT_WATER_COLOR } from "../../shared/settings.js";
import { shapeFor, type BlockShape, type BoxRotation, type UvWindow } from "./block_shapes.js";
import type { BakedFace, CellFace, PaletteEntry, RgbaImage } from "./types.js";
import { paletteEntryCacheKey } from "./types.js";

/**
 * `BakedBlock` — ported from `model_baker.py:21-24` (`@dataclass(frozen=True)`).
 * inventory.tsv row `BakedBlock` (model_baker.py:21-23): same
 * immutability-implied-not-enforced pattern as `PaletteEntry` in types.ts —
 * one rulebook-level decision (interface + `readonly` fields, no
 * `Object.freeze`), applied uniformly here, not re-litigated per class.
 */
export interface BakedBlock {
  /**
   * The six cube faces, by direction name. Only populated for full cubes --
   * they are the only shape whose faces can be culled against a neighbour.
   */
  readonly faces: Record<string, BakedFace>;
  /**
   * Geometry emitted unconditionally: every box of a multi-box shape, and the
   * two quads of a cross. A staircase has faces at coordinates its neighbours
   * do not cover, so culling them against a neighbour would be wrong.
   */
  readonly extraFaces: readonly BakedFace[];
  readonly textureKey: string;
  /** False for anything that is not one solid 0..16 box. */
  readonly isFullCube: boolean;
}

const FACE_ORDER = ["north", "south", "east", "west", "up", "down"] as const;
const HORIZONTAL_FACES = ["north", "south", "east", "west"] as const;

/** Suffixes naming a *shape* cut from a material, not a texture of its own. */
const SHAPE_SUFFIXES = [
  "_stairs",
  "_slab",
  "_fence_gate",
  "_fence",
  "_wall",
  "_pane",
  "_button",
  "_pressure_plate",
  "_carpet",
] as const;

/**
 * inventory.tsv row `_SPECIAL_FACE_RULES` (model_baker.py:29-71): the inner
 * keys are a fixed small set ("top"/"side"/"bottom"), not arbitrary strings
 * — an explicit interface says so even though the Python type hint
 * (`Dict[str, Dict[str, list[str]]]`) doesn't.
 */
export interface SpecialFaceRule {
  readonly top?: readonly string[];
  readonly side?: readonly string[];
  readonly bottom?: readonly string[];
}

/**
 * Block names that wear another block's texture, one layer at a time.
 *
 * A name that resolves nothing is usually a *variant* of one that does, and the
 * variants compose: `waxed_exposed_cut_copper_slab` is a waxed, exposed, cut
 * copper slab, and only the middle of those words survives into a file name.
 * Each rule below peels one layer and `aliasChain` runs them to a fixed point,
 * so the shape-suffix strip and the `waxed_` prefix never have to know about
 * each other.
 *
 * Every target here was checked against the shipped pack rather than reasoned
 * about, and `tests/blocks.ts` re-checks all 920 ids on every run -- which is
 * how the 162 that reached the hashed-colour cube were found in the first place.
 */
/**
 * Blocks whose texture is chosen by `lit`, and the naming that makes it a
 * table rather than a rule.
 *
 * `lit` was honoured for **light** -- `lighting.ts` has kept two default
 * tables for it since it was written -- and nowhere else, so every redstone
 * torch in every schematic was drawn burning while emitting nothing.
 * `block/redstone_torch_off.png` is in the pack and was reachable from no
 * code path at all. Walking the 52 blocks that carry the property found ten
 * more in exactly that position: the redstone lamp, whose `_on` was equally
 * unreachable, and the eight copper bulbs.
 *
 * A table, because vanilla's naming runs in three directions at once and no
 * derivation covers them. The **torch**'s bare name is the lit one and `_off`
 * is dark. The **lamp**'s bare name is dark and `_on` is lit. A **bulb** is
 * `<name>[_lit][_powered]`, four textures for two booleans.
 *
 * Not in a shape function, which would see the property just as well. Here the
 * swap is of the *whole block*, and two of the three families are
 * `kind: "cube"` with no `ShapeBox` to hang a `texture` on. The campfire went
 * into its shape function because it needed control per **face**, tied to
 * geometry; this does not, and that is the whole of the difference.
 *
 * **`redstone_ore` and `deepslate_redstone_ore` are deliberately absent.**
 * Vanilla ships one texture for each and `lit` there changes the light and
 * nothing else, so they are two of the thirteen the walk found and two that
 * were already right. `tests/blocks.ts` names them as the exception rather
 * than skipping them quietly.
 *
 * The plain name rides along behind the chosen one, so a pack shipping only
 * half of a pair is no worse off than it was.
 */
const LIT_TEXTURES: Readonly<Record<string, readonly [string, string]>> = {
  // [unlit, lit]
  redstone_torch: ["redstone_torch_off", "redstone_torch"],
  redstone_lamp: ["redstone_lamp", "redstone_lamp_on"],
};

/** The four oxidation stages; the waxed eight reach these through the alias. */
const COPPER_BULBS: ReadonlySet<string> = new Set([
  "copper_bulb",
  "exposed_copper_bulb",
  "weathered_copper_bulb",
  "oxidized_copper_bulb",
]);

/**
 * A boolean property, falling back to the **block's own** default.
 *
 * Which is not one answer for all of them, and is the trap: a bare
 * `redstone_torch` is lit and a bare `redstone_lamp` is not. Asking the
 * registry rather than writing the flag into the table above is what stops
 * this becoming a second copy of a fact `block_states.ts` already holds --
 * `lighting.ts` keeps two sets for the identical reason and says so.
 */
function flagOf(entry: PaletteEntry, property: string): boolean {
  const stated = entry.properties[property];
  return (stated ?? defaultStateFor(entry.namespacedName)[property]) === "true";
}

const NAME_ALIASES: ReadonlyArray<(name: string) => string | null> = [
  // Waxing changes nothing you can see: the whole copper family shares its
  // unwaxed textures. 40 of the ids this fixes are these.
  (name) => (name.startsWith("waxed_") ? name.slice("waxed_".length) : null),
  // An infested block is its host block with a silverfish inside it.
  (name) => (name.startsWith("infested_") ? name.slice("infested_".length) : null),
  // A potted plant is the plant. `block_shapes.ts` adds the pot around it.
  (name) => (name.startsWith("potted_") ? name.slice("potted_".length) : null),
  // A "wood" block is a log showing its bark on all six faces, and there is no
  // `oak_wood.png`. The nether's `_hyphae` stands the same way over `_stem`.
  (name) => (name.endsWith("_wood") ? `${name.slice(0, -"_wood".length)}_log` : null),
  (name) => (name.endsWith("_hyphae") ? `${name.slice(0, -"_hyphae".length)}_stem` : null),
  /*
   * A wall-mounted anything is the thing, minus the `_wall`.
   *
   * One rule where there were going to be five: `redstone_wall_torch` ->
   * `redstone_torch`, `oak_wall_sign` -> `oak_sign`, `tube_coral_wall_fan` ->
   * `tube_coral_fan`, `creeper_wall_head` -> `creeper_head`,
   * `acacia_wall_hanging_sign` -> `acacia_hanging_sign`. The leading form --
   * `wall_torch`, `wall_sign` -- is the shape-suffix rule's `wall_` strip below.
   */
  (name) => (name.includes("_wall_") ? name.replace("_wall_", "_") : null),
  /*
   * `chain` became `iron_chain` in 1.21.9 and the pack ships only the new name,
   * while `block_id_list.txt` offers both -- a schematic written for anything
   * earlier names the old one. Renames are the one thing a union registry
   * cannot paper over, because the *texture* moved too.
   */
  (name) => (name === "chain" ? "iron_chain" : null),
  // A cauldron with something in it is a cauldron.
  (name) => (name.endsWith("_cauldron") ? "cauldron" : null),
  // A cake with a candle on it is a cake; `block_shapes.ts` puts the candle on.
  (name) => (name === "candle_cake" || name.endsWith("_candle_cake") ? "cake" : null),
  // The mature two-block plant is drawn from its crop's sheet.
  (name) => (name === "pitcher_plant" ? "pitcher_crop" : null),
  // The Flattening gave the bare 1.12 names a wood: `sign` became `oak_sign`.
  // Both spellings are still in `block_id_list.txt`, so both have to draw.
  (name) => (name === "sign" ? "oak_sign" : null),
  (name) => (name === "wall_sign" ? "oak_wall_sign" : null),
  /*
   * The shape suffix, as an alias rather than only a `materialCandidates`
   * spelling. It has to be in the chain so that a *rule* for the stripped name
   * can apply: `smooth_quartz_stairs` only draws because stripping `_stairs`
   * puts `smooth_quartz` in the chain, where its own entry is waiting.
   */
  (name) => {
    for (const suffix of SHAPE_SUFFIXES) {
      if (name.endsWith(suffix)) return name.slice(0, -suffix.length);
    }
    return name.startsWith("wall_") ? name.slice("wall_".length) : null;
  },
];

/**
 * Crops whose texture is a growth stage, and how an `age` maps onto one.
 *
 * The two numbers are not the same and the difference is not derivable: carrots
 * and potatoes have eight ages and four textures, and vanilla spends them
 * `0,0,1,1,2,2,2,3` -- weighted late, so a field looks nearly ripe for most of
 * its life. Transcribed from `assets/minecraft/blockstates/<crop>.json` at
 * 1.21.4, one file each, not inferred from the texture count.
 */
const AGE_STAGES: Readonly<Record<string, readonly number[]>> = {
  wheat: [0, 1, 2, 3, 4, 5, 6, 7],
  carrots: [0, 0, 1, 1, 2, 2, 2, 3],
  potatoes: [0, 0, 1, 1, 2, 2, 2, 3],
  beetroots: [0, 1, 2, 3],
  nether_wart: [0, 1, 1, 2],
  cocoa: [0, 1, 2],
  torchflower_crop: [0, 1],
  sweet_berry_bush: [0, 1, 2, 3],
};

/** Clockwise from north, which is how a model's `facing` rotates. */
const COMPASS: readonly string[] = ["north", "east", "south", "west"];

const OPPOSITE_FACE: Readonly<Record<string, string>> = {
  north: "south",
  south: "north",
  east: "west",
  west: "east",
  up: "down",
  down: "up",
};

/**
 * A world face expressed in the model's own axes, given which way it faces.
 *
 * Vanilla names a bed's textures by *model-local* direction -- `bed_head_north`
 * is the end of the head whichever way the bed is turned -- so a per-face
 * texture rule has to undo the rotation the blockstate applied. Vertical faces
 * are unaffected, which is why they fall straight through.
 */
function localFace(face: string, facing: string): string {
  const steps = COMPASS.indexOf(facing);
  const at = COMPASS.indexOf(face);
  if (steps < 0 || at < 0) return face;
  return COMPASS[(at - steps + 4) % 4];
}

/**
 * A bed's per-face textures.
 *
 * Beds used to be block entities drawn from one `entity/bed/<colour>` sheet,
 * unwrapped by hand -- which is why `block_shapes.ts` still carries
 * `unwrapCube` for the chests. **1.21.9 moved them onto ordinary block
 * textures**, one per face: `red_bed_head_up`, `red_bed_foot_south`, and two
 * shared ones, `bed_down` and `bed_head_north`, that carry no colour because
 * the underside and the joint end look the same on every bed.
 *
 * That is strictly better than the sheet: no unwrap arithmetic to get wrong,
 * and the two halves cannot disagree. The candidate list falls back from the
 * coloured name to the shared one, which is what resolves those two.
 */
function bedCandidates(entry: PaletteEntry, name: string, face: string): string[] {
  const colour = name.slice(0, -"_bed".length);
  const part = entry.properties.part === "head" ? "head" : "foot";
  const local = localFace(face, entry.properties.facing ?? "north");
  return [`${colour}_bed_${part}_${local}`, `bed_${part}_${local}`, `bed_${local}`];
}

/**
 * The stage textures for a crop, most grown first from the one its `age`
 * selects.
 *
 * Descending rather than exact so a pack shipping fewer stages than vanilla
 * still draws a crop instead of a coloured cube -- the same "offer several
 * spellings and let the pack decide" rule `materialCandidates` follows.
 */
function stageCandidates(entry: PaletteEntry, name: string): string[] {
  const stages = AGE_STAGES[name];
  if (stages === undefined) {
    return [];
  }
  const raw = Number(entry.properties.age ?? "0");
  const age = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 0), stages.length - 1) : 0;
  const out: string[] = [];
  for (let stage = stages[age]; stage >= 0; stage -= 1) {
    out.push(`${name}_stage${stage}`);
  }
  return out;
}

export const SPECIAL_FACE_RULES: Record<string, SpecialFaceRule> = {
  /*
   * The markers, and the only two rules here that point at `item/`.
   *
   * Neither block has a block texture, because neither is drawn in the world —
   * what the game has is the icon it shows you in your hand, and that icon is
   * exactly what identifies it here. `normalizeTextureKey` already honours an
   * `item/` prefix, so this needs nothing else.
   */
  barrier: { top: ["item/barrier"], side: ["item/barrier"], bottom: ["item/barrier"] },
  structure_void: {
    top: ["item/structure_void"],
    side: ["item/structure_void"],
    bottom: ["item/structure_void"],
  },
  // The extended arm, which is what `moving_piston` is a picture of.
  moving_piston: { top: ["piston_top"], side: ["piston_side"], bottom: ["piston_side"] },

  // Dirt-like blocks with distinct top/bottom.
  grass_block: { top: ["grass_block_top"], side: ["grass_block_side"], bottom: ["dirt"] },
  podzol: { top: ["podzol_top"], side: ["podzol_side"], bottom: ["dirt"] },
  mycelium: { top: ["mycelium_top"], side: ["mycelium_side"], bottom: ["dirt"] },
  dirt_path: { top: ["dirt_path_top"], side: ["dirt_path_side"], bottom: ["dirt"] },
  grass_path: {
    top: ["dirt_path_top", "grass_path_top"],
    side: ["dirt_path_side", "grass_path_side"],
    bottom: ["dirt"],
  },
  crimson_nylium: { top: ["crimson_nylium"], side: ["crimson_nylium_side"], bottom: ["netherrack"] },
  warped_nylium: { top: ["warped_nylium"], side: ["warped_nylium_side"], bottom: ["netherrack"] },
  snow_block: { top: ["snow"], side: ["snow"], bottom: ["snow"] },

  // Fluids: the block is `water`, the texture is `water_still`. None of the
  // generic candidates (`water_side`, `water_top`, `water`) exists, so water
  // used to fall through to the hashed-colour cube — whose hash for
  // `minecraft:water[level=0]` happens to be a vivid green.
  water: { top: ["water_still"], side: ["water_still"], bottom: ["water_still"] },
  flowing_water: { top: ["water_still"], side: ["water_flow"], bottom: ["water_flow"] },
  bubble_column: { top: ["water_still"], side: ["water_still"], bottom: ["water_still"] },
  lava: { top: ["lava_still"], side: ["lava_still"], bottom: ["lava_still"] },
  flowing_lava: { top: ["lava_still"], side: ["lava_flow"], bottom: ["lava_flow"] },

  /*
   * Blocks whose texture is simply not named after them.
   *
   * Every one below reached the hashed-colour cube -- a plausible solid block
   * in an arbitrary colour, with no error anywhere -- and every one of these
   * targets was already sitting in the shipped pack. Nothing was missing; the
   * names were just never right. `tests/blocks.ts` walks all 920 ids so a
   * fourteenth spelling of this mistake cannot arrive quietly.
   */
  magma_block: { top: ["magma"], side: ["magma"], bottom: ["magma"] },
  dried_kelp_block: {
    top: ["dried_kelp_top"],
    side: ["dried_kelp_side"],
    bottom: ["dried_kelp_bottom"],
  },
  // Ice that is melting is four textures; a schematic captures one moment and
  // frame 0 is the one that still looks like ice.
  frosted_ice: { top: ["frosted_ice_0"], side: ["frosted_ice_0"], bottom: ["frosted_ice_0"] },
  bamboo: { top: ["bamboo_stalk"], side: ["bamboo_stalk"], bottom: ["bamboo_stalk"] },
  bamboo_sapling: { top: ["bamboo_stage0"], side: ["bamboo_stage0"], bottom: ["bamboo_stage0"] },
  // The brushable blocks: `_0` is undisturbed, which is how a schematic holds
  // them.
  suspicious_sand: {
    top: ["suspicious_sand_0"],
    side: ["suspicious_sand_0"],
    bottom: ["suspicious_sand_0"],
  },
  suspicious_gravel: {
    top: ["suspicious_gravel_0"],
    side: ["suspicious_gravel_0"],
    bottom: ["suspicious_gravel_0"],
  },
  pointed_dripstone: {
    top: ["pointed_dripstone_up_tip"],
    side: ["pointed_dripstone_up_tip"],
    bottom: ["pointed_dripstone_up_tip"],
  },
  sniffer_egg: {
    top: ["sniffer_egg_not_cracked_top"],
    side: ["sniffer_egg_not_cracked_north"],
    bottom: ["sniffer_egg_not_cracked_bottom"],
  },

  /*
   * Blocks drawn from `textures/entity/`, like the beds and chests above but
   * without a sheet layout worth unwrapping. A decorated pot's patterns are a
   * stack of layers this code cannot compose, so it wears its plain side; a
   * skull is drawn from the mob's own texture, which is what vanilla does.
   */
  decorated_pot: {
    top: ["entity/decorated_pot/decorated_pot_base"],
    side: ["entity/decorated_pot/decorated_pot_side"],
    bottom: ["entity/decorated_pot/decorated_pot_base"],
  },
  skeleton_skull: {
    top: ["entity/skeleton/skeleton"],
    side: ["entity/skeleton/skeleton"],
    bottom: ["entity/skeleton/skeleton"],
  },
  skeleton_wall_skull: {
    top: ["entity/skeleton/skeleton"],
    side: ["entity/skeleton/skeleton"],
    bottom: ["entity/skeleton/skeleton"],
  },

  /*
   * A campfire's logs, and `lit` is deliberately **not** decided here.
   *
   * This used to put `campfire_log_lit` first and the cold log behind it, on
   * the reasoning that the default state is lit -- which is true, and which
   * made an *unlit* campfire wear the burning logs, because a candidate list
   * cannot see a property. `block_shapes.ts` reads `lit` and names the
   * texture per face, which is what vanilla does through `campfire_off.json`.
   *
   * What is left here is the block's particle texture and the fallback its
   * boxes resolve against, so it names the one log every campfire has.
   */
  campfire: { top: ["campfire_log"], side: ["campfire_log"], bottom: ["campfire_log"] },
  soul_campfire: { top: ["campfire_log"], side: ["campfire_log"], bottom: ["campfire_log"] },

  /*
   * A hopper's sides are `hopper_outside`, and the generic list asks for
   * `hopper_side` -- **a file the pack does not contain**, because vanilla
   * has never called it that. So every hopper wore its own lid on all six
   * faces, `hopper_top` being the only name that resolved.
   *
   * `hopper_inside` is not reachable from a face rule at all: it belongs to
   * the bowl's floor and the funnel's underside, which are boxes rather than
   * sides of the block. `block_shapes.ts` names it per box.
   */
  hopper: { top: ["hopper_top"], side: ["hopper_outside"], bottom: ["hopper_outside"] },
  fire: { top: ["fire_0"], side: ["fire_0"], bottom: ["fire_0"] },
  soul_fire: { top: ["soul_fire_0"], side: ["soul_fire_0"], bottom: ["soul_fire_0"] },

  // Pistons: the head is the plate and rod that `block_shapes.ts` draws, and a
  // sticky piston differs from an ordinary one only on its face.
  piston_head: { top: ["piston_top"], side: ["piston_side"], bottom: ["piston_side"] },
  sticky_piston: {
    top: ["piston_top_sticky"],
    side: ["piston_side"],
    bottom: ["piston_bottom"],
  },
  redstone_wire: {
    top: ["redstone_dust_dot"],
    side: ["redstone_dust_line0"],
    bottom: ["redstone_dust_dot"],
  },

  /*
   * Polished stone that borrows a *face* of the block it was cut from. There is
   * no rule to derive these -- smooth quartz takes the quartz block's bottom,
   * smooth sandstone its top -- so they are transcribed one at a time.
   */
  smooth_quartz: {
    top: ["quartz_block_bottom"],
    side: ["quartz_block_bottom"],
    bottom: ["quartz_block_bottom"],
  },
  smooth_sandstone: { top: ["sandstone_top"], side: ["sandstone_top"], bottom: ["sandstone_top"] },
  smooth_red_sandstone: {
    top: ["red_sandstone_top"],
    side: ["red_sandstone_top"],
    bottom: ["red_sandstone_top"],
  },
  // The one slab that is not cut from the material its name says: a petrified
  // oak slab is stone that looks like planks.
  petrified_oak_slab: { top: ["oak_planks"], side: ["oak_planks"], bottom: ["oak_planks"] },
  heavy_weighted_pressure_plate: {
    top: ["gold_block"],
    side: ["gold_block"],
    bottom: ["gold_block"],
  },
  light_weighted_pressure_plate: {
    top: ["iron_block"],
    side: ["iron_block"],
    bottom: ["iron_block"],
  },
  // Renamed in 1.20.3. The old id is still offered, so it still has to draw.
  grass: { top: ["short_grass"], side: ["short_grass"], bottom: ["short_grass"] },

  /*
   * The two blocks with no texture at all: vanilla draws both with a shader
   * over a starfield, and there is nothing in a resource pack to read. Black is
   * the honest stand-in -- the same decision as a banner falling back to dyed
   * wool -- because an end portal in a schematic is structural and drawing
   * nothing would hide it.
   */
  end_portal: { top: ["black_concrete"], side: ["black_concrete"], bottom: ["black_concrete"] },

  // A dried ghast rehydrates through four stages and a schematic holds one
  // moment; stage 0 is how it is placed.
  dried_ghast: {
    top: ["dried_ghast_hydration_0_top"],
    side: ["dried_ghast_hydration_0_north"],
    bottom: ["dried_ghast_hydration_0_bottom"],
  },
  // The nether's dripstone, named the same way and sharing its shape.
  sulfur_spike: {
    top: ["sulfur_spike_up_tip"],
    side: ["sulfur_spike_up_tip"],
    bottom: ["sulfur_spike_up_tip"],
  },
  end_gateway: { top: ["black_concrete"], side: ["black_concrete"], bottom: ["black_concrete"] },
};

/**
 * Face geometry for an arbitrary box, in place of model_baker.py:283-290's
 * hardcoded unit cube.
 *
 * Positions reproduce the old `_FACE_DEFINITIONS` exactly when the box is
 * 0..1, so full cubes are unchanged. **UVs are not**: the old `_UNIT_UVS`
 * mapped the world-bottom of a face to V=0, but glTF puts V=0 at the *top* of
 * the image, so every side texture was drawn upside down -- visible on
 * `grass_block`, whose green overhang appeared along the bottom edge. The
 * formulas below put V=0 at the top, deliberately diverging from the Python
 * original, which had the same inversion.
 *
 * Deriving UVs from the box coordinates rather than a fixed 0..1 quad is what
 * keeps a slab's side showing the bottom half of its texture instead of the
 * whole tile squashed into half the height.
 *
 * ## The horizontal half of that rule, which was wrong on all six faces
 *
 * These are vanilla's `BlockElement.uvsByFace`, which is not a convention this
 * app may choose: it is the one every texture in the game is *painted* to, and
 * the one every `uv` window in `block_shapes.ts` was transcribed under.
 *
 * | face | U | V |
 * |---|---|---|
 * | north | `16 - x` | `16 - y` |
 * | south | `x` | `16 - y` |
 * | west | `z` | `16 - y` |
 * | east | `16 - z` | `16 - y` |
 * | up | `x` | `z` |
 * | down | `x` | `16 - z` |
 *
 * Said once instead of six times: seen from outside the block, U runs to the
 * viewer's right and V downward, with north at the top of a top face and south
 * at the top of a bottom one.
 *
 * Every one of them used to be the mirror of that, and the *reason it lasted*
 * is the thing to remember: a Minecraft texture is nearly always symmetric or
 * noise, so a mirrored plank, ore or brick is a mirrored plank, ore or brick.
 * It surfaced three times as a report about something else — a bed whose pillow
 * sat at the joint instead of under the headboard, bed legs whose side faces
 * landed on the transparent part of their own strip, and a chest that would not
 * come out right however its windows were rearranged — and each time the block
 * got the blame. `tests/blocks.ts` states it on the one texture in the game
 * that can be read: the light block wears its level as a number.
 *
 * Two things follow from it that are easy to miss. A box that does not span its
 * axis samples a *different region* on north, west and down than it did — that
 * is what put a bed leg's window on the empty end of its strip. And
 * `windowUvsFrom` has to be turned round with it, or a shape carrying both
 * kinds of face comes out with some of its boxes mirrored and the rest not.
 */
interface FaceGeometry {
  readonly positions: Float32Array;
  readonly uvs: Float32Array;
  readonly normal: readonly [number, number, number];
}

function boxFaceGeometry(
  box: readonly [number, number, number, number, number, number],
): Record<string, FaceGeometry> {
  const [x0, y0, z0, x1, y1, z1] = box;
  const quad = (...p: number[]) => new Float32Array(p);
  const uv = (...p: number[]) => new Float32Array(p);
  return {
    north: {
      positions: quad(x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0),
      uvs: uv(1 - x0, 1 - y0, 1 - x1, 1 - y0, 1 - x1, 1 - y1, 1 - x0, 1 - y1),
      normal: [0, 0, -1],
    },
    south: {
      positions: quad(x1, y0, z1, x0, y0, z1, x0, y1, z1, x1, y1, z1),
      uvs: uv(x1, 1 - y0, x0, 1 - y0, x0, 1 - y1, x1, 1 - y1),
      normal: [0, 0, 1],
    },
    west: {
      positions: quad(x0, y0, z1, x0, y0, z0, x0, y1, z0, x0, y1, z1),
      uvs: uv(z1, 1 - y0, z0, 1 - y0, z0, 1 - y1, z1, 1 - y1),
      normal: [-1, 0, 0],
    },
    east: {
      positions: quad(x1, y0, z0, x1, y0, z1, x1, y1, z1, x1, y1, z0),
      uvs: uv(1 - z0, 1 - y0, 1 - z1, 1 - y0, 1 - z1, 1 - y1, 1 - z0, 1 - y1),
      normal: [1, 0, 0],
    },
    down: {
      positions: quad(x0, y0, z1, x1, y0, z1, x1, y0, z0, x0, y0, z0),
      uvs: uv(x0, 1 - z1, x1, 1 - z1, x1, 1 - z0, x0, 1 - z0),
      normal: [0, -1, 0],
    },
    up: {
      positions: quad(x0, y1, z0, x1, y1, z0, x1, y1, z1, x0, y1, z1),
      uvs: uv(x0, z0, x1, z0, x1, z1, x0, z1),
      normal: [0, 1, 0],
    },
  };
}

const UNIT_BOX = [0, 0, 0, 1, 1, 1] as const;

/**
 * Where a box face has to lie for it to *be* the cell's face: which of the six
 * scaled coordinates to read, and what it has to hold.
 *
 * This is vanilla's rule for when a model face carries `cullface`, derived
 * rather than transcribed -- vanilla writes it out per face in the JSON, and
 * it writes it on exactly the faces this arithmetic names. A box in the middle
 * of the cell gets none, which is what keeps a candle's flame and a fence's
 * rails on screen however they are surrounded.
 */
const CULL_BOUNDARY: Readonly<Record<CellFace, readonly [number, number]>> = {
  west: [0, 0],
  down: [1, 0],
  north: [2, 0],
  east: [3, 1],
  up: [4, 1],
  south: [5, 1],
};

/**
 * Textures Minecraft ships **greyscale** and tints at render time with the
 * biome's grass or foliage colour. Left untinted they come out a flat grey,
 * which is what made grass tops, leaves and vines look washed out next to
 * correctly-coloured dirt and planks. Matched by suffix so modded and
 * per-wood variants are covered without listing every one.
 */
const BIOME_TINTED: readonly string[] = [
  "block/grass_block_top",
  "block/grass_block_side_overlay",
  "block/short_grass",
  "block/grass",
  "block/tall_grass_top",
  "block/tall_grass_bottom",
  "block/fern",
  "block/large_fern_top",
  "block/large_fern_bottom",
  "block/vine",
  "block/lily_pad",
  /*
   * Leaf litter ships greyscale and takes the foliage colour, exactly as leaves
   * do -- it is fallen leaves. Without the tint it came out flat grey, which
   * reads as a texture that failed to load rather than as one that is waiting
   * for a colour. Pink petals and wildflowers are *not* here: they are painted
   * their own colours and vanilla tints only their stems.
   */
  "block/leaf_litter",
  "block/sugar_cane",
  "block/attached_melon_stem",
  "block/attached_pumpkin_stem",
  "block/melon_stem",
  "block/pumpkin_stem",
];

/**
 * Water ships greyscale too, but takes the biome's **water** colour, which is
 * a different number from the grass/foliage one — hence two settings rather
 * than one. Lava is not tinted: its texture is already orange.
 */
const WATER_TINTED: readonly string[] = [
  "block/water_still",
  "block/water_flow",
  "block/water_overlay",
];

/** Which of the two tints a texture takes, if any. */
function tintKindFor(textureKey: string): "foliage" | "water" | null {
  const path = textureKey.slice(textureKey.indexOf(":") + 1);
  if (WATER_TINTED.includes(path)) {
    return "water";
  }
  return path.endsWith("_leaves") || BIOME_TINTED.includes(path) ? "foliage" : null;
}

function parseHexColor(value: string): [number, number, number] {
  const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  if (!match) {
    return parseHexColor(DEFAULT_BIOME_COLOR);
  }
  const n = parseInt(match[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/**
 * Minecraft stores an animated block texture as its frames stacked vertically
 * in one file — `lantern.png` is 16x48, three frames of 16x16 — with the
 * timing in a sibling `.mcmeta`. Anything downstream that treats the file as a
 * single image gets a squashed, unusable strip: the atlas resizes it to a
 * square tile, so a lantern's UV windows then address the wrong pixels
 * entirely. Taking frame 0 is the still-image equivalent and is what a preview
 * wants.
 *
 * Detected by shape rather than by reading the `.mcmeta`: block textures are
 * square by convention, so a height that is an exact multiple of the width is
 * the animation layout and nothing else.
 */
export interface TextureAnimation {
  /** The frames in play order, each one square and the size of the tile. */
  readonly frames: readonly RgbaImage[];
  /** Minecraft ticks per frame. A tick is 50ms; vanilla's default is 1. */
  readonly frameTime: number;
}

/**
 * Cuts a stacked strip into its frames, in the order the `.mcmeta` asks for.
 *
 * `firstAnimationFrame` below takes frame 0 and is what goes in the atlas; this
 * keeps the rest, so the viewer can put a different one there ten times a
 * second. The strip is the source of truth for *what* the frames are and the
 * `.mcmeta` only for their order and speed — an absent or unreadable one leaves
 * the natural order at vanilla's default of one tick.
 *
 * `frames` entries are either a bare index or `{index, time}`; the per-frame
 * time is deliberately not honoured, because a single interval is the whole of
 * what the viewer's clock can express and getting it wrong per frame would be a
 * subtler lie than a uniform one. `interpolate` is likewise ignored: it blends
 * between frames, and every texture in this app is sampled with NEAREST.
 */
function cutAnimation(strip: RgbaImage, meta: unknown): TextureAnimation | null {
  const count = Math.floor(strip.height / strip.width);
  if (count < 2) return null;
  const size = strip.width;
  const bytes = size * size * 4;
  const all: RgbaImage[] = [];
  for (let i = 0; i < count; i += 1) {
    all.push({ width: size, height: size, data: strip.data.slice(i * bytes, (i + 1) * bytes) });
  }

  const animation = (meta as { animation?: { frametime?: unknown; frames?: unknown } } | null)
    ?.animation;
  const stated = Number(animation?.frametime);
  const frameTime = Number.isFinite(stated) && stated > 0 ? Math.round(stated) : 1;

  const order = animation?.frames;
  if (!Array.isArray(order) || order.length === 0) {
    return { frames: all, frameTime };
  }
  const chosen: RgbaImage[] = [];
  for (const item of order) {
    const index = typeof item === "number" ? item : Number((item as { index?: unknown })?.index);
    if (Number.isInteger(index) && index >= 0 && index < all.length) chosen.push(all[index]);
  }
  return chosen.length > 0 ? { frames: chosen, frameTime } : { frames: all, frameTime };
}

function firstAnimationFrame(image: RgbaImage): RgbaImage {
  const { width, height } = image;
  if (height <= width || height % width !== 0) {
    return image;
  }
  return { width, height: width, data: image.data.slice(0, width * width * 4) };
}

/**
 * Applies a vanilla model element's `rotation` to a baked face.
 *
 * Boxes are axis-aligned by construction, so a tilt cannot be expressed in the
 * box bounds — it has to move the vertices. Normals are rotated with them, or
 * a leaning wall torch would be lit as though it stood upright.
 */
/**
 * The same quad seen from behind: the four vertices in reverse order, and the
 * normal negated to match.
 *
 * Reversing the order is what reverses the winding, and `buildMesh` decides
 * which side of a triangle is its front from the winding alone. Each uv pair
 * travels with its own vertex, so the picture is the same picture -- mirrored,
 * because that is what looking at it from the other side does.
 *
 * Only the cross needs it. Every other paper-thin element in the game is a box
 * with `from` and `to` equal on one axis, and `boxFaces` already gives one of
 * those the two real faces of the six.
 */
function reversedFace(face: BakedFace): BakedFace {
  const positions = new Float32Array(12);
  const uvs = new Float32Array(8);
  for (let v = 0; v < 4; v += 1) {
    const from = 3 - v;
    positions[v * 3] = face.positions[from * 3];
    positions[v * 3 + 1] = face.positions[from * 3 + 1];
    positions[v * 3 + 2] = face.positions[from * 3 + 2];
    uvs[v * 2] = face.uvs[from * 2];
    uvs[v * 2 + 1] = face.uvs[from * 2 + 1];
  }
  return {
    ...face,
    positions,
    uvs,
    normal: [-face.normal[0], -face.normal[1], -face.normal[2]],
  };
}

function tiltFace(face: BakedFace, rotation: BoxRotation): BakedFace {
  const radians = (rotation.angle * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  // The origin is stated in the model's 0..16 units; positions are 0..1.
  const [ox, oy, oz] = rotation.origin.map((n) => n / 16);

  const spin = (x: number, y: number, z: number): [number, number, number] => {
    switch (rotation.axis) {
      case "x":
        return [x, y * cos - z * sin, y * sin + z * cos];
      case "y":
        return [x * cos + z * sin, y, -x * sin + z * cos];
      default:
        return [x * cos - y * sin, x * sin + y * cos, z];
    }
  };

  const positions = new Float32Array(face.positions.length);
  for (let i = 0; i < face.positions.length; i += 3) {
    const [x, y, z] = spin(
      face.positions[i] - ox,
      face.positions[i + 1] - oy,
      face.positions[i + 2] - oz,
    );
    positions[i] = x + ox;
    positions[i + 1] = y + oy;
    positions[i + 2] = z + oz;
  }
  const normal = spin(face.normal[0], face.normal[1], face.normal[2]);
  return { positions, uvs: face.uvs.slice(), normal, textureKey: face.textureKey };
}

/** Multiplies RGB by the tint, the same operation the game's shader performs. */
function applyTint(image: RgbaImage, tint: readonly [number, number, number]): RgbaImage {
  const data = new Uint8Array(image.data.length);
  for (let i = 0; i < image.data.length; i += 4) {
    data[i] = (image.data[i] * tint[0]) / 255;
    data[i + 1] = (image.data[i + 1] * tint[1]) / 255;
    data[i + 2] = (image.data[i + 2] * tint[2]) / 255;
    data[i + 3] = image.data[i + 3];
  }
  return { width: image.width, height: image.height, data };
}

/**
 * A vanilla model's explicit `uv` window, `[u0, v0, u1, v1]` in the tile's
 * 0..16 space with V already running downward, expanded to the four corners in
 * the same vertex order `boxFaceGeometry` emits.
 *
 * **It has to agree with the derived UVs face by face**, which is why it takes
 * the direction. A window is stated the way vanilla states one — `u0` is the
 * *left* edge of the picture as somebody outside the block sees it — and the
 * corner of the box that lands on is not the same for all six faces: on the
 * four sides the picture's left is the box's far corner along the face's own
 * axis, and on the top and the bottom it is `x0`. Applying one order to
 * everything is what put a window on backwards relative to the coordinate-
 * derived UVs beside it in the same shape.
 */
function windowUvsFrom(
  face: string,
  window: readonly [number, number, number, number],
): Float32Array {
  const [u0, v0, u1, v1] = window.map((n) => n / 16) as [number, number, number, number];
  return face === "up" || face === "down"
    ? new Float32Array([u0, v0, u1, v0, u1, v1, u0, v1])
    : new Float32Array([u1, v1, u0, v1, u0, v0, u1, v0]);
}

/**
 * A vanilla face's `rotation`, applied to the four corners a window produced.
 *
 * Vanilla turns the *texture* within the face by shifting which corner of the
 * window each vertex reads (`BlockFaceUV.getShiftedIndex`), and that is exactly
 * a cyclic shift of the four pairs above — the window itself does not move. So
 * one quarter-turn of the assignment is one quarter-turn of the picture, and no
 * arithmetic on the coordinates is involved at all.
 *
 * It matters wherever the window's aspect does not match the face's: the anvil
 * states its foot's west face as a 4x12 window on a face that is 12 wide and 4
 * tall, and without the turn that window is stretched across the face sideways.
 *
 * **Which way it turns is decided by `windowUvsFrom`, not by anything here.**
 * A shift is only a rotation once you know which way round the four corners
 * already run, and they used to run the other way — so a `rotation: 90`
 * transcribed from a vanilla model came out as vanilla's 270. That is a
 * half-turn of the picture, which on the anvil's and the grindstone's bands is
 * invisible, so it was never going to be reported. Both were corrected by the
 * same edit, because both are the same fact stated once.
 */
function rotateWindowUvs(uvs: Float32Array, degrees: number): Float32Array {
  const quarters = ((Math.round(degrees / 90) % 4) + 4) % 4;
  if (quarters === 0) {
    return uvs;
  }
  const out = new Float32Array(8);
  for (let corner = 0; corner < 4; corner += 1) {
    const from = (corner + quarters) % 4;
    out[corner * 2] = uvs[from * 2];
    out[corner * 2 + 1] = uvs[from * 2 + 1];
  }
  return out;
}

/**
 * Thin wrapper around either a directory or `.zip` resource pack.
 * Ported from `_ResourcePackSource` (model_baker.py:74-100). Not exported —
 * module-private, matching the Python leading-underscore convention.
 */
class ResourcePackSource {
  private constructor(
    private readonly rootPath: string,
    private readonly isDir: boolean,
    private readonly zip: AdmZip | null,
  ) {}

  static async create(rootPath: string): Promise<ResourcePackSource> {
    // RULEBOOK §1 "Standard library I/O" row: stat, not existsSync (TOCTOU).
    const stat = await fs.stat(rootPath).catch(() => null);
    const isDir = stat !== null && stat.isDirectory();
    // SAFETY: adm-zip's constructor synchronously loads the whole zip into
    // memory — RULEBOOK §1 names adm-zip as the sync-API sanctioned
    // exception for zip reading, specifically because this matches the
    // source's own `zipfile.ZipFile(str(path))` usage pattern.
    const zip = isDir ? null : new AdmZip(rootPath);
    return new ResourcePackSource(rootPath, isDir, zip);
  }

  /**
   * Ported from `read_bytes` (model_baker.py:84-100).
   * inventory.tsv row `ResourcePackTextures.read_bytes`: collapses three
   * causes (file missing, OSError-on-read, missing zip entry) into one
   * `null` — confirmed precondition-guard, intentional. This OVERRIDES the
   * general fs-convention row (RULEBOOK §1, catch-ENOENT-rethrow-else) for
   * this specific site: the inventory row is authoritative per §2's
   * delegating rule, and here the source's own `except OSError: return None`
   * is broader than ENOENT alone, so every read error collapses to `null`,
   * not just missing-file.
   */
  async readBytes(relativePath: string): Promise<Uint8Array | null> {
    const normalized = relativePath.replace(/\\/g, "/");
    if (this.isDir) {
      const filePath = path.join(this.rootPath, relativePath);
      try {
        return await fs.readFile(filePath);
      } catch {
        return null;
      }
    }
    if (this.zip === null) {
      return null;
    }
    const entry = this.zip.getEntry(normalized);
    if (entry === null) {
      return null;
    }
    try {
      return entry.getData();
    } catch {
      return null;
    }
  }
}

function splitTextureKey(textureKey: string): [namespace: string, texturePath: string] {
  let namespace = "minecraft";
  let texturePath = textureKey;
  if (textureKey.includes(":")) {
    const idx = textureKey.indexOf(":");
    namespace = textureKey.slice(0, idx);
    texturePath = textureKey.slice(idx + 1);
  }
  texturePath = texturePath.trim().replace(/^\/+/, "").replace(/\\/g, "/");
  if (texturePath.startsWith("textures/")) {
    texturePath = texturePath.slice("textures/".length);
  }
  if (texturePath.endsWith(".png")) {
    texturePath = texturePath.slice(0, -4);
  }
  return [namespace, texturePath];
}

function candidatePaths(namespace: string, texturePath: string): string[] {
  const relPaths: string[] = [];
  const primary = `assets/${namespace}/textures/${texturePath}.png`;
  relPaths.push(primary);
  const alternative = `assets/${namespace}/${texturePath}.png`;
  if (alternative !== primary) {
    relPaths.push(alternative);
  }
  return relPaths;
}


/**
 * Utility that fetches textures from user-supplied or bundled resource
 * packs. Ported from `ResourcePackTextures` (model_baker.py:103-194).
 *
 * Construction does I/O (stat, possibly zip load, possibly a `readdir` for
 * the fallback pack) — RULEBOOK §1's async-model row requires that at the
 * I/O boundary, and a constructor can't be async, so this uses a static
 * async factory (`create`) instead of a public constructor.
 */
export class ResourcePackTextures {
  private readonly sources: ResourcePackSource[];
  // RULEBOOK §1 "Internal keyed-collection type" row: Record, not Map — this
  // dict is one of the row's own named examples ("texture ... caches").
  private readonly cache: Record<string, RgbaImage> = {};
  /** The frames of every animated texture decoded so far, by key. */
  readonly animationCache: Record<string, TextureAnimation> = {};
  private readonly missing = new Set<string>();

  private constructor(sources: ResourcePackSource[]) {
    this.sources = sources;
  }

  /**
   * Sources are consulted in order, so a user-supplied pack that only covers
   * some blocks still falls back to the bundled one for the rest — the layering
   * the Python original got from `_discover_fallback`.
   *
   * Both paths are supplied by the caller. This used to discover the bundled
   * pack itself by walking up from `import.meta.url` to find `public/*.zip`,
   * which broke as soon as the main process was bundled into a single file (see
   * `services/resources.ts`'s `defaultResourcePackPath`). Passing it in also
   * keeps this module free of any Electron import, so it stays testable
   * headlessly.
   */
  static async create(
    primaryPath: string | null,
    fallbackPath: string | null = null,
  ): Promise<ResourcePackTextures> {
    const sources: ResourcePackSource[] = [];
    const seen = new Set<string>();

    for (const candidate of [primaryPath, fallbackPath]) {
      if (!candidate) {
        continue;
      }
      const resolved = path.resolve(candidate);
      if (seen.has(resolved)) {
        // The user picked the bundled pack explicitly; don't load it twice.
        continue;
      }
      const exists = await fs
        .stat(candidate)
        .then(() => true)
        .catch(() => false);
      if (exists) {
        sources.push(await ResourcePackSource.create(candidate));
        seen.add(resolved);
      }
    }

    return new ResourcePackTextures(sources);
  }

  get hasSources(): boolean {
    return this.sources.length > 0;
  }

  /**
   * Ported from `load_texture` (model_baker.py:148-171).
   * inventory.tsv row: collapses "not found in any source" and "found but
   * failed to decode" into one `null` — confirmed intentional (best-effort
   * multi-candidate lookup; a decode failure on one candidate must not
   * abort the search for the next candidate/source).
   */
  async loadTexture(textureKey: string): Promise<RgbaImage | null> {
    if (textureKey in this.cache) {
      return this.cache[textureKey];
    }
    if (this.missing.has(textureKey) || this.sources.length === 0) {
      return null;
    }

    const [namespace, texturePath] = splitTextureKey(textureKey);
    const relCandidates = candidatePaths(namespace, texturePath);

    for (const relPath of relCandidates) {
      for (const source of this.sources) {
        const data = await source.readBytes(relPath);
        if (data === null) {
          continue;
        }
        let rgba: RgbaImage;
        try {
          // RULEBOOK §1 "Third-party deps" / "Image composition" rows:
          // pngjs decode only — PNG.sync.read always decodes to RGBA8,
          // matching the source's `img.convert("RGBA")`.
          const png = PNG.sync.read(Buffer.from(data));
          const strip: RgbaImage = {
            width: png.width,
            height: png.height,
            data: new Uint8Array(png.data),
          };
          rgba = firstAnimationFrame(strip);
          if (rgba !== strip) {
            // Only a strip has more than one frame, and only then is the
            // `.mcmeta` worth a read -- it exists for exactly this and for
            // nothing else this app looks at.
            const meta = await source.readBytes(`${relPath}.mcmeta`);
            let parsed: unknown = null;
            if (meta !== null) {
              try {
                parsed = JSON.parse(Buffer.from(meta).toString("utf-8"));
              } catch {
                // A pack with a malformed `.mcmeta` still has usable frames;
                // the natural order at one tick is the honest default.
              }
            }
            const cut = cutAnimation(strip, parsed);
            if (cut !== null) {
              this.animationCache[textureKey] = cut;
              /*
               * The atlas gets the first frame **in play order**, which is not
               * always the first in the strip: lava's `.mcmeta` reorders 20
               * source frames into a 38-frame sequence and prismarine's turns 4
               * into 22. Taking the strip's frame 0 would leave the atlas
               * showing something the animation never starts on — visible for
               * the moment before the first blit, and, worse, a second answer
               * to "what is in that tile" for anything that reads the atlas
               * back.
               */
              rgba = cut.frames[0];
            }
          }
        } catch {
          continue;
        }
        this.cache[textureKey] = rgba;
        return rgba;
      }
    }

    this.missing.add(textureKey);
    return null;
  }
}

/**
 * Fallback-friendly block baker.
 *
 * Ported from `ModelBaker` (model_baker.py:197-415). The Python class kept
 * an optional `minecraft_model_reader`-backed path
 * (`_bake_with_reader`/`ModelLoader`) that always returned `None` — RULEBOOK
 * §2 confirms this as dead code (DEV-008) and mandates dropping it entirely.
 * This port has NO `_bake_with_reader` method and NO `ModelLoader` type —
 * `bakeBlockstate` goes straight from cache-miss to the fallback baker.
 * (inventory.tsv's `ModelBaker.__init__` row, about the broad
 * `except Exception` around `ModelLoader(...)` construction, is therefore
 * moot too: there is nothing left to construct.)
 */
export class ModelBaker {
  // RULEBOOK §1 Record-over-Map row: both caches below.
  private readonly cache: Record<string, BakedBlock> = {};
  private readonly textureCache: Record<string, RgbaImage> = {};
  /** Cut glyphs, and the ones known to have nothing to draw. */
  private readonly glyphCache = new Map<string, { key: string | null; advance: number } | null>();
  /** `undefined` until asked for, `null` once the pack is known to lack it. */
  private fontSheet: RgbaImage | null | undefined;
  /** Memo for `alphaOf`; a texture's alpha does not change once decoded. */
  private readonly opaqueTextures = new Map<string, "opaque" | "cutout" | "translucent">();
  /** Tinted copies of the animated textures, and the keys already done. */
  private readonly animationCache: Record<string, TextureAnimation> = {};
  private readonly tintedAnimations = new Set<string>();
  private readonly textureSource: ResourcePackTextures;

  private readonly biomeTint: readonly [number, number, number];
  private readonly waterTint: readonly [number, number, number];

  private constructor(
    textureSource: ResourcePackTextures,
    biomeTint: readonly [number, number, number],
    waterTint: readonly [number, number, number],
  ) {
    this.textureSource = textureSource;
    this.biomeTint = biomeTint;
    this.waterTint = waterTint;
  }

  /**
   * Async factory — construction needs `ResourcePackTextures.create`'s I/O
   * (see that class's doc comment for why it can't be a plain constructor).
   *
   * `biomeColor` is a `#rrggbb` string; see `BIOME_TINTED` for what it is
   * multiplied into and why those textures are grey without it.
   */
  static async create(
    resourcePackPath: string | null = null,
    fallbackResourcePackPath: string | null = null,
    biomeColor: string = DEFAULT_BIOME_COLOR,
    waterColor: string = DEFAULT_WATER_COLOR,
  ): Promise<ModelBaker> {
    const textureSource = await ResourcePackTextures.create(resourcePackPath, fallbackResourcePackPath);
    return new ModelBaker(textureSource, parseHexColor(biomeColor), parseHexColor(waterColor));
  }

  get textures(): Readonly<Record<string, RgbaImage>> {
    return this.textureCache;
  }

  /**
   * The frames of every animated texture the baker has decoded, by texture key.
   *
   * The *atlas* holds frame 0 and always will — packing 32 frames of water into
   * a square tile would either grow the atlas thirty-twofold or leave each frame
   * eleven pixels across. What moves is a small blit into the atlas texture on
   * the GPU, so the frames travel beside it and the viewer puts one of them in
   * place ten times a second.
   *
   * Keyed the same way the atlas is, so a caller can look each one's tile up in
   * `uvRects` and know where to write.
   */
  get animations(): Readonly<Record<string, TextureAnimation>> {
    // The source's own frames, with the tinted ones laid over them: `water_still`
    // reaches the atlas coloured by the biome, and its frames have to match.
    return { ...this.textureSource.animationCache, ...this.animationCache };
  }

  /**
   * Whether a decoded texture has a pixel you can see through.
   *
   * This is what decides whether a surface may hide the one behind it, and it
   * is asked of the *pixels* rather than of a list of names on purpose. The
   * list was `isSeeThrough` in `block_shapes.ts`, which is geometry and cannot
   * open a PNG, so every block whose shape covers a face but whose art does not
   * had to be remembered by hand — and the ones nobody remembered deleted the
   * face behind them. Pink petals scattered on grass took the grass's top face
   * with them and the gaps between the petals became a hole through the floor.
   *
   * Cached per key, because the answer is a property of the image and a
   * structure asks it once per palette entry per chunk. Scanning a 64x64 tile
   * is four thousand reads, once.
   */
  isTextureOpaque(key: string): boolean {
    return this.alphaOf(key) === "opaque";
  }

  /**
   * Whether a texture has pixels that are *partly* see-through, as opposed to
   * either solid or cut away.
   *
   * The two are different jobs for the renderer and only one of them is
   * expensive. A cutout — leaves, petals, a rail — is every pixel either 0 or
   * 255, and `alphaTest` handles it in the opaque pass for free. Water is
   * `alpha 180` across its whole tile, which passes any alpha test and then
   * draws **solid**: that is the whole of "the water block has no transparency".
   * Blending it needs a second pass, and a second pass is worth paying for only
   * where it is actually needed.
   */
  isTextureTranslucent(key: string): boolean {
    return this.alphaOf(key) === "translucent";
  }

  /**
   * One character of sign text, as an atlas tile and the width it takes up.
   *
   * `textures/font/ascii.png` is a 16x16 grid indexed by code point, which the
   * bundled pack ships like any other texture -- so a sign's text needs nothing
   * vendored and nothing fetched, the same standing rule the block models are
   * under. Cut into per-character tiles rather than registered whole for two
   * reasons: `MAX_TILE` is 256 and the sheet is 512 in this pack, so the atlas
   * would subsample it four to one and take a pixel in sixteen of a font; and
   * the tint has to be per character anyway, because it is baked in.
   *
   * **Only the ASCII page.** The accented and non-latin pages are laid out by
   * `font/default.json`, which lives in the client jar and is not in a texture
   * pack, so their code points cannot be looked up here. A character outside
   * the page draws nothing rather than drawing the wrong glyph.
   *
   * `advance` is in the font's own 8-pixel units and is *measured*, exactly as
   * the game measures it: the last column with a pixel in it, plus one for the
   * gap. Minecraft's font is proportional -- an `i` is two wide and an `m` is
   * six -- and laying it out fixed-width is instantly recognisable as wrong.
   * A space has no pixels and no column to find, so it takes vanilla's four.
   */
  async glyph(
    code: number,
    colour: readonly [number, number, number],
  ): Promise<{ key: string | null; advance: number } | null> {
    if (!Number.isInteger(code) || code < 0 || code > 0xff) return null;
    const hex = colour.map((c) => c.toString(16).padStart(2, "0")).join("");
    const key = `minecraft:font/glyph_${code}_${hex}`;
    const known = this.glyphCache.get(key);
    if (known !== undefined) return known;

    const sheet = await this.fontPage();
    if (sheet === null) {
      this.glyphCache.set(key, null);
      return null;
    }
    const cell = Math.floor(sheet.width / 16);
    const left = (code % 16) * cell;
    const top = Math.floor(code / 16) * cell;
    const tile = new Uint8Array(cell * cell * 4);
    let lastInk = -1;
    for (let y = 0; y < cell; y += 1) {
      for (let x = 0; x < cell; x += 1) {
        const from = ((top + y) * sheet.width + left + x) * 4;
        const to = (y * cell + x) * 4;
        const alpha = sheet.data[from + 3];
        tile[to] = (sheet.data[from] * colour[0]) / 255;
        tile[to + 1] = (sheet.data[from + 1] * colour[1]) / 255;
        tile[to + 2] = (sheet.data[from + 2] * colour[2]) / 255;
        tile[to + 3] = alpha;
        if (alpha >= 8 && x > lastInk) lastInk = x;
      }
    }
    // The sheet is drawn at some multiple of the font's 8-pixel cell; the pack
    // decides which, and the advance is stated in the font's units.
    const scale = cell / 8;
    /*
     * Three answers, not two. `null` is "there is nothing here" -- a code point
     * off the page -- and a **null key with an advance** is a space: it takes
     * room and draws nothing. Folded together, a space got a tile that was
     * never registered, and every one of them emitted a quad addressing a
     * texture the atlas had never heard of.
     */
    const answer: { key: string | null; advance: number } | null =
      lastInk < 0
        ? code === 0x20
          ? { key: null, advance: 4 }
          : null
        : { key, advance: Math.ceil((lastInk + 1) / scale) + 1 };
    if (answer !== null && answer.key !== null) {
      this.textureCache[key] = { width: cell, height: cell, data: tile };
    }
    this.glyphCache.set(key, answer);
    return answer;
  }

  /** The ASCII font page, loaded once. `null` once it is known to be absent. */
  private async fontPage(): Promise<RgbaImage | null> {
    if (this.fontSheet === undefined) {
      this.fontSheet = await this.textureSource.loadTexture("minecraft:font/ascii");
    }
    return this.fontSheet;
  }

  /** Cached verdict on a decoded texture's alpha channel. */
  private alphaOf(key: string): "opaque" | "cutout" | "translucent" {
    const known = this.opaqueTextures.get(key);
    if (known !== undefined) return known;
    const image = this.textureCache[key];
    // A texture that has not been decoded cannot be shown to be see-through,
    // and answering "opaque" here only ever preserves the culling that was
    // already happening.
    let verdict: "opaque" | "cutout" | "translucent" = "opaque";
    if (image !== undefined) {
      for (let i = 3; i < image.data.length; i += 4) {
        const alpha = image.data[i];
        if (alpha === 255) continue;
        if (alpha === 0) {
          // Keep looking: one cut-away pixel does not stop a later one being a
          // real blend, and translucent is the answer that wins.
          verdict = "cutout";
          continue;
        }
        verdict = "translucent";
        break;
      }
    }
    this.opaqueTextures.set(key, verdict);
    return verdict;
  }

  /**
   * Ported from `bake_blockstate` (model_baker.py:220-229).
   * inventory.tsv row `ModelBaker.bake_blockstate cache`: the cache is
   * keyed ONLY by `paletteEntryCacheKey(entry)` (types.ts) — the sole
   * sanctioned cache key everywhere `BakedBlock` is memoized. A second
   * ad-hoc key format anywhere would silently fragment the cache.
   */
  async bakeBlockstate(entry: PaletteEntry): Promise<BakedBlock> {
    const cacheKey = paletteEntryCacheKey(entry);
    if (cacheKey in this.cache) {
      return this.cache[cacheKey];
    }

    // RULEBOOK §2 `_bake_with_reader` row (DEV-008): dropped entirely, go
    // straight to the fallback baker.
    const baked = await this.bakeFallback(entry);
    this.cache[cacheKey] = baked;
    return baked;
  }

  private async bakeFallback(entry: PaletteEntry): Promise<BakedBlock> {
    const shape = shapeFor(entry);
    const texturedFaces = await this.cubeFaceTextures(entry);
    if (texturedFaces !== null) {
      // inventory.tsv row `_cube_face_textures` (6-way first-non-null-wins
      // chain): `??` chain is a direct fit — texture keys are never empty
      // strings (normalizeTextureKey always produces a non-empty
      // "namespace:path"), so `??` vs `||` doesn't diverge here.
      const primaryKey =
        texturedFaces.north ??
        texturedFaces.east ??
        texturedFaces.west ??
        texturedFaces.south ??
        texturedFaces.up ??
        texturedFaces.down;
      if (primaryKey) {
        return await this.bakeShape(shape, primaryKey, texturedFaces);
      }
    }
    return await this.hashedColorCube(entry, shape);
  }

  /**
   * Resolves a `ShapeBox`'s own texture (a beacon's glass shell, say). Falls
   * back to the block's texture if the pack does not have it, so an override
   * can never make a block disappear.
   */
  private async resolveBoxTexture(name: string | undefined, fallback: string): Promise<string> {
    if (name === undefined) {
      return fallback;
    }
    const [path, hex] = name.split("#");
    const key = ModelBaker.normalizeTextureKey(path);
    if (!(await this.ensureTextureCached(key))) {
      return fallback;
    }
    return hex === undefined ? key : this.tintedTexture(key, hex);
  }

  /**
   * A copy of one texture multiplied by a colour, under a key of its own.
   *
   * The tint in `ensureTextureCached` is keyed on the *texture path* and its
   * colour is a constant of the baker, which is right for grass and water --
   * every leaf in a document takes the same biome -- and cannot express a
   * colour that varies with the block's **state**. A banner's cloth is one
   * sheet in sixteen colours; redstone dust is one texture at sixteen
   * powers. Neither can be a second `BIOME_TINTED` row.
   *
   * The way round it already existed, for the glyphs: mint a synthetic key
   * and write the multiplied pixels into the cache under it. The atlas packs
   * whatever is in `textures`, so nothing else has to know.
   *
   * An **animated** source is handed back untinted rather than half-done.
   * `animationCache` is keyed on the texture as well, so a tinted copy would
   * need its frames tinted too, and today nothing asks: the banner base and
   * the redstone dust are both still images.
   */
  private tintedTexture(key: string, hex: string): string {
    const source = this.textureCache[key];
    if (source === undefined || this.animationCache[key] !== undefined) {
      return key;
    }
    const tinted = `${key}#${hex}`;
    if (!(tinted in this.textureCache)) {
      this.textureCache[tinted] = applyTint(source, parseHexColor(hex));
    }
    return tinted;
  }

  /** Turns a `BlockShape` into geometry, once its textures are known. */
  private async bakeShape(
    shape: BlockShape,
    primaryKey: string,
    faceKeys: Record<string, string>,
  ): Promise<BakedBlock> {
    if (shape.kind === "cube") {
      return {
        faces: ModelBaker.boxFaces(UNIT_BOX, primaryKey, faceKeys),
        extraFaces: [],
        textureKey: primaryKey,
        isFullCube: true,
      };
    }

    if (shape.kind === "cross") {
      return {
        faces: {},
        extraFaces: ModelBaker.crossFaces(primaryKey),
        textureKey: primaryKey,
        isFullCube: false,
      };
    }

    if (shape.kind !== "boxes") {
      // `invisible` is handled before textures are ever resolved; reaching
      // here would mean a new shape kind was added without a branch.
      return { faces: {}, extraFaces: [], textureKey: primaryKey, isFullCube: false };
    }

    const extraFaces: BakedFace[] = [];
    for (const part of shape.boxes) {
      // block_shapes.ts works in Minecraft's 0..16 model units; the mesher
      // works in 0..1 block units.
      const scaled: [number, number, number, number, number, number] = [
        part.box[0] / 16,
        part.box[1] / 16,
        part.box[2] / 16,
        part.box[3] / 16,
        part.box[4] / 16,
        part.box[5] / 16,
      ];
      const boxKey = await this.resolveBoxTexture(part.texture, primaryKey);
      /*
       * A box that names its own textures answers for every face of itself,
       * and the block-level map is dropped.
       *
       * That map comes from `cubeFaceTextures`, which guesses from the block's
       * name: for `chipped_anvil` the only texture that exists is
       * `chipped_anvil_top`, so it answered that for *all six* faces and the
       * whole anvil came out wearing the picture of its own dented top. A box
       * that has been transcribed from the real model knows better than a
       * guess, so where it speaks the guess is not consulted.
       */
      let boxFaceKeys: Record<string, string> = {};
      if (part.textures !== undefined) {
        for (const [face, name] of Object.entries(part.textures)) {
          boxFaceKeys[face] = await this.resolveBoxTexture(name, boxKey);
        }
      } else if (part.texture === undefined) {
        boxFaceKeys = faceKeys;
      }
      const all = ModelBaker.boxFaces(scaled, boxKey, boxFaceKeys, part.uv, part.uvRotation);
      for (const name of part.omit ?? []) {
        delete all[name];
      }
      /*
       * A face lying on the cell's own boundary can be covered by whatever is
       * next door, and says so. A tilted box gets nothing: a wall torch leans
       * 22.5 degrees off the wall, so none of its faces is on any plane, and
       * asking whether it is *nearly* there is a question with no right answer.
       */
      if (part.rotation === undefined) {
        for (const [name, face] of Object.entries(all)) {
          const at = CULL_BOUNDARY[name as CellFace];
          if (at !== undefined && scaled[at[0]] === at[1]) {
            all[name] = { ...face, cullFace: name as CellFace };
          }
        }
      }
      const built = Object.values(all);
      extraFaces.push(
        ...(part.rotation ? built.map((face) => tiltFace(face, part.rotation!)) : built),
      );
    }
    return { faces: {}, extraFaces, textureKey: primaryKey, isFullCube: false };
  }

  /**
   * Two diagonal planes, vanilla's shape for flowers, grass and saplings --
   * and **four** quads, because each plane is drawn from both sides.
   *
   * It used to be two, on the strength of the material being double-sided.
   * That is not what vanilla says: `cross.json` states each element with a
   * `north` face *and* a `south` face, which is two quads per plane, and it is
   * the only spelling that survives the block material becoming single-sided.
   * Written the other way a flower is invisible from half the compass, which
   * is exactly what the old comment was afraid of.
   *
   * The back is the front with its vertices reversed, so the picture comes out
   * mirrored -- which is again vanilla's answer, since its `north` and `south`
   * faces of one element wear the same window read from opposite corners.
   */
  private static crossFaces(textureKey: string): BakedFace[] {
    const s = Math.SQRT1_2;
    const uvs = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]);
    /*
     * The normals are the ones the winding actually produces, not their
     * opposites, and they were their opposites for as long as nothing looked.
     * A double-sided material flips the normal per side in the shader, so the
     * sign never showed; single-sided, a quad whose declared normal points
     * away from its visible face is lit by the sun that is behind it.
     */
    const front: BakedFace[] = [
      {
        positions: new Float32Array([0, 0, 0, 1, 0, 1, 1, 1, 1, 0, 1, 0]),
        uvs: uvs.slice(),
        normal: [s, 0, -s],
        textureKey,
      },
      {
        positions: new Float32Array([1, 0, 0, 0, 0, 1, 0, 1, 1, 1, 1, 0]),
        uvs: uvs.slice(),
        normal: [s, 0, s],
        textureKey,
      },
    ];
    return [...front, ...front.map(reversedFace)];
  }

  private async hashedColorCube(entry: PaletteEntry, shape: BlockShape): Promise<BakedBlock> {
    const textureKey = paletteEntryCacheKey(entry);
    if (!(textureKey in this.textureCache)) {
      const color = ModelBaker.colorFromKey(textureKey);
      const tile = new Uint8Array(16 * 16 * 4);
      for (let i = 0; i < tile.length; i += 4) {
        tile[i] = color[0];
        tile[i + 1] = color[1];
        tile[i + 2] = color[2];
        tile[i + 3] = color[3];
      }
      this.textureCache[textureKey] = { width: 16, height: 16, data: tile };
    }

    // The colour stands in for a texture, but the *shape* is still known, so a
    // fence whose texture could not be resolved is at least fence-shaped.
    return await this.bakeShape(shape, textureKey, {});
  }

  private static colorFromKey(key: string): [number, number, number, number] {
    const digest = createHash("sha1").update(key, "utf8").digest();
    // Mix with a lighter base so even dark blocks remain visible.
    const r = (digest[0] + 64) % 256;
    const g = (digest[1] + 64) % 256;
    const b = (digest[2] + 64) % 256;
    return [r, g, b, 255];
  }

  /**
   * Ported from `_unit_cube_faces` (model_baker.py:277-302).
   * inventory.tsv row: `face_overrides: Optional[Mapping[str,str]] = None`
   * — TS optional param, `undefined` means "omitted" (use `textureKey` for
   * every face), matching the default-parameter site at
   * model_baker.py:264 (`_unit_cube_faces(texture_key)`, no override).
   * TODO(port): the inventory row also asks whether the port should accept
   * an explicit `null` as equivalent to omitted (Python callers can pass
   * `None` explicitly, same as omitting) — no rulebook row settles this.
   * Current signature only accepts `undefined`/omission; an explicit
   * `null` argument is a type error, not silently treated as "no override".
   */
  private static boxFaces(
    box: readonly [number, number, number, number, number, number],
    textureKey: string,
    faceOverrides?: Record<string, string>,
    uvOverrides?: Readonly<Record<string, UvWindow>>,
    uvRotations?: Readonly<Record<string, number>>,
  ): Record<string, BakedFace> {
    const faces: Record<string, BakedFace> = {};
    /*
     * A face with no area is not drawn.
     *
     * Vanilla expresses a *plane* as an element whose `from` and `to` agree on
     * one axis -- a chain is two of them, and so is the cross a flower is drawn
     * with. Four of that element's six faces then collapse to a line, and
     * emitting them costs eight degenerate triangles that z-fight with the two
     * real ones along their shared edge.
     *
     * Decided from the box rather than listed per shape on purpose: an `omit`
     * written by hand is a list to keep in step with coordinates that already
     * say the same thing, and the first plane added without one would look like
     * a rendering bug rather than a missing entry.
     */
    const [bx0, by0, bz0, bx1, by1, bz1] = box;
    const flat = { x: bx0 === bx1, y: by0 === by1, z: bz0 === bz1 };
    const spans: Record<string, readonly ["x" | "y" | "z", "x" | "y" | "z"]> = {
      north: ["x", "y"],
      south: ["x", "y"],
      east: ["y", "z"],
      west: ["y", "z"],
      up: ["x", "z"],
      down: ["x", "z"],
    };
    for (const [name, definition] of Object.entries(boxFaceGeometry(box))) {
      const span = spans[name];
      if (span !== undefined && (flat[span[0]] || flat[span[1]])) {
        continue;
      }
      // inventory.tsv row `_unit_cube_faces` nested-default-chain: written
      // as explicit statements (per-face override, else the generic "side"
      // override, else the plain texture key), NOT a nested ternary, so the
      // fallback order stays reviewable at a glance (confirmed correct in
      // stress-test round 1's pilot).
      let key: string;
      if (faceOverrides !== undefined && faceOverrides[name] !== undefined) {
        key = faceOverrides[name];
      } else if (faceOverrides !== undefined && faceOverrides.side !== undefined) {
        key = faceOverrides.side;
      } else {
        key = textureKey;
      }
      const window = uvOverrides?.[name];
      const turn = uvRotations?.[name];
      faces[name] = {
        positions: definition.positions.slice(),
        // An explicit window replaces the coordinate-derived UVs entirely: it
        // is given in the tile's own 0..16 space, in glTF's V-down convention,
        // exactly as a vanilla model states it. A `rotation` beside it turns
        // the picture within the face, which is a different thing from turning
        // the box and is why both are carried.
        uvs: window
          ? rotateWindowUvs(windowUvsFrom(name, window), turn ?? 0)
          : rotateWindowUvs(definition.uvs.slice(), turn ?? 0),
        normal: definition.normal,
        textureKey: key,
      };
    }
    return faces;
  }

  /**
   * Ported from `_cube_face_textures` (model_baker.py:307-348).
   * inventory.tsv row: returns `null` when zero candidate textures resolved
   * for any face — a distinct "nothing at all found" sentinel from the
   * two-cause sentinels on `readBytes`/`loadTexture` above. Caller
   * (`bakeFallback`) already treats null identically to "no textured
   * faces", matching the source.
   */
  private async cubeFaceTextures(entry: PaletteEntry): Promise<Record<string, string> | null> {
    if (!this.textureSource.hasSources) {
      return null;
    }

    const baseName = entry.namespacedName.split(":").pop() ?? entry.namespacedName;
    const faces: Record<string, string> = {};

    for (const face of FACE_ORDER) {
      const candidates = ModelBaker.faceCandidates(entry, baseName, face);
      for (const candidate of candidates) {
        const textureKey = ModelBaker.normalizeTextureKey(candidate);
        if (await this.ensureTextureCached(textureKey)) {
          faces[face] = textureKey;
          break;
        }
      }
    }

    if (Object.keys(faces).length === 0) {
      return null;
    }

    const fallback = FACE_ORDER.map((face) => faces[face]).find((key) => key !== undefined);
    for (const face of FACE_ORDER) {
      if (faces[face] === undefined && fallback !== undefined) {
        faces[face] = fallback;
      }
    }

    // inventory.tsv row `PaletteEntry.properties consumer`: "axis" is a
    // known key read out of the generic property bag (values "x"/"y"/"z").
    const axis = entry.properties.axis;
    if (axis === "x" || axis === "y" || axis === "z") {
      const topKey = faces.up;
      const bottomKey = faces.down;
      const sideKey = faces.north;
      if (axis === "x") {
        faces.east = topKey;
        faces.west = topKey;
        faces.up = sideKey;
        faces.down = sideKey;
      } else if (axis === "z") {
        faces.north = topKey;
        faces.south = topKey;
        faces.up = sideKey;
        faces.down = sideKey;
      } else {
        // axis === "y"
        faces.up = topKey;
        faces.down = bottomKey;
      }
    }

    return faces;
  }

  /**
   * Blocks whose texture is not derivable from their name at all, because
   * Minecraft draws them as block *entities* rather than from a baked model:
   * their art lives under `textures/entity/`, in a layout and with colours
   * this code has no way to compose. The stand-ins below are the closest
   * plain block texture — a red bed reads as red wool. Without them these
   * blocks fell through to the hashed-colour cube, which is what put the
   * magenta and cyan patches on the render.
   */
  private static entityTextureAlias(entry: PaletteEntry, name: string): string | null {
    /*
     * Beds are **not** here any more, for the same reason signs are not: 1.21.9
     * moved them off `entity/bed/<colour>` and onto per-face block textures.
     * This rule outliving that change is what sent all sixteen back to the
     * hashed-colour cube the moment the pack was updated -- it matched first
     * and returned a path the pack no longer contains. `bedCandidates` has it.
     */
    if (name === "chest" || name === "trapped_chest" || name === "ender_chest") {
      const sheet =
        name === "ender_chest" ? "ender" : name === "trapped_chest" ? "trapped" : "normal";
      // A double chest is two blocks, each wearing one half of a wider sheet.
      const type = entry.properties.type;
      const suffix = type === "left" ? "_left" : type === "right" ? "_right" : "";
      return `entity/chest/${sheet}${suffix}`;
    }
    /*
     * Signs are **not** here any more, and that is a change in the game rather
     * than in this code. 1.21.9 moved beds and signs off their block-entity
     * sheets and onto ordinary block textures -- `block/oak_sign`,
     * `block/oak_hanging_sign` -- so the generic candidates find them with no
     * rule at all, and the `entity/signs/` directory this used to point at no
     * longer exists in the pack. Reintroducing an alias here would send every
     * sign back to the hashed-colour cube.
     */

    // Copper chests came with the copper golem, and their sheets spell the
    // oxidation stage *after* the material: `copper_exposed`, not
    // `exposed_copper`.
    const copperChest = /^(?:waxed_)?(exposed_|weathered_|oxidized_)?copper_chest$/.exec(name);
    if (copperChest) {
      const stage = copperChest[1] === undefined ? "" : `_${copperChest[1].slice(0, -1)}`;
      const type = entry.properties.type;
      const half = type === "left" ? "_left" : type === "right" ? "_right" : "";
      return `entity/chest/copper${stage}${half}`;
    }
    const golem = /^(?:waxed_)?(exposed_|weathered_|oxidized_)?copper_golem_statue$/.exec(name);
    if (golem) {
      const stage = golem[1] === undefined ? "" : `_${golem[1].slice(0, -1)}`;
      return `entity/copper_golem/copper_golem${stage}`;
    }

    // Heads and skulls are drawn from the mob's own texture, which is what
    // vanilla does. `_wall_` has already been stripped by the alias chain.
    const HEADS: Readonly<Record<string, string>> = {
      creeper_head: "entity/creeper/creeper",
      dragon_head: "entity/enderdragon/dragon",
      piglin_head: "entity/piglin/piglin",
      player_head: "entity/player/wide/steve",
      zombie_head: "entity/zombie/zombie",
      skeleton_skull: "entity/skeleton/skeleton",
      wither_skeleton_skull: "entity/skeleton/wither_skeleton",
    };
    if (HEADS[name] !== undefined) return HEADS[name];

    /*
     * A banner's pole and crossbar are on `entity/banner/banner_base`, and
     * they are the only two parts of it that are not dyed -- so that sheet is
     * the block's texture and `block_shapes.ts` names the cloth's separately,
     * tinted. What is still not done is the **patterns**: they are a stack of
     * layers in the block entity's NBT, and composing them is a different
     * job. A plain banner of the right colour is not a stand-in for one.
     */
    if (/_(?:wall_)?banner$/.test(name)) return "entity/banner/banner_base";
    /*
     * A shulker box's sheet is laid out for an animated lid, so the dyed wool
     * stays the honest stand-in there.
     */
    const shulker = /^([a-z_]+)_shulker_box$/.exec(name);
    if (shulker) return `${shulker[1]}_wool`;
    return null;
  }

  /**
   * The names to try, in order: this block's, then each name it is a variant
   * of.
   *
   * Runs `NAME_ALIASES` to a fixed point so the rules compose without knowing
   * about each other -- `waxed_exposed_cut_copper_slab` needs the `waxed_`
   * strip and the `_slab` strip in either order, and gets both. Bounded and
   * de-duplicated because an alias table is one careless rule away from a cycle.
   */
  private static aliasChain(name: string): string[] {
    const chain = [name];
    const seen = new Set(chain);
    for (let i = 0; i < chain.length && chain.length < 8; i += 1) {
      for (const alias of NAME_ALIASES) {
        const next = alias(chain[i]);
        if (next !== null && next !== "" && !seen.has(next)) {
          seen.add(next);
          chain.push(next);
        }
      }
    }
    return chain;
  }

  private static faceCandidates(entry: PaletteEntry, baseName: string, face: string): string[] {
    const normalized = baseName.replace("minecraft:", "");
    return ModelBaker.aliasChain(normalized).flatMap((name) =>
      ModelBaker.candidatesForName(entry, name, face),
    );
  }

  /** What one name in the chain offers for one face. */
  private static candidatesForName(
    entry: PaletteEntry,
    normalized: string,
    face: string,
  ): string[] {
    const alias = ModelBaker.entityTextureAlias(entry, normalized);
    if (alias) {
      return [alias];
    }

    // A crop's texture is its growth stage, and `age` is not the stage number.
    const stages = stageCandidates(entry, normalized);
    if (stages.length > 0) {
      return stages;
    }

    if (normalized.endsWith("_bed")) {
      return bedCandidates(entry, normalized, face);
    }

    /*
     * A light block wears the level it was set to.
     *
     * Vanilla ships `item/light_00` through `item/light_15`, each with its
     * number drawn on it, because that is what the game puts in your hand. So
     * "write the intensity on every face" needs no glyphs and no compositing --
     * only the right one of sixteen files.
     *
     * Zero-padded, and 15 when the state says nothing, which is the level a
     * light block is placed at.
     */
    if (normalized === "light") {
      const raw = Number(entry.properties.level ?? "15");
      const level = Number.isFinite(raw) ? Math.min(15, Math.max(0, Math.trunc(raw))) : 15;
      return [`item/light_${String(level).padStart(2, "0")}`, "item/light"];
    }

    /*
     * The mature pitcher plant wears its crop's *final* stage.
     *
     * Not expressible as an alias, which is why it is written out: the file is
     * `pitcher_crop_top_stage_4`, so the growth stage comes *after* the half,
     * and the `half` branch below would build `pitcher_crop_stage_4_top`. Left
     * to the plain alias it drew `pitcher_crop_top` -- the seedling -- so a
     * full-grown plant wore a sprout.
     */
    if (normalized === "pitcher_plant") {
      const half = entry.properties.half === "upper" ? "top" : "bottom";
      return [`pitcher_crop_${half}_stage_4`, `pitcher_crop_${half}`];
    }

    /*
     * `lit` before `facing`, and **the order changes nothing today** -- which
     * is worth writing down rather than leaving to be rediscovered, because
     * the argument for putting it here is a good one and is not load-bearing.
     *
     * A `redstone_wall_torch` reaches here twice, once under its own name and
     * once as `redstone_torch` through the `_wall_` alias, and it carries a
     * `facing` -- so on the second pass the branch below answers `${normalized}`
     * for the face the block points at, and for a torch the bare name is the
     * **lit** texture. That collision is real and unreachable: a wall torch is
     * a `boxes` shape, so every one of its faces takes the block's primary key
     * and the per-face map is never consulted. Verified by moving this below
     * the branch and watching nothing fail.
     *
     * It stays above because the day a block in this table is a cube with a
     * `facing`, the collision stops being unreachable and nothing would say so.
     */
    const swap = LIT_TEXTURES[normalized];
    if (swap !== undefined) {
      return [swap[flagOf(entry, "lit") ? 1 : 0], normalized];
    }
    if (COPPER_BULBS.has(normalized)) {
      const lit = flagOf(entry, "lit") ? `${normalized}_lit` : normalized;
      const powered = flagOf(entry, "powered") ? `${lit}_powered` : lit;
      return [powered, lit, normalized];
    }

    /*
     * The face a block *points* is drawn from its own texture, and there was no
     * rule for it at all -- so every furnace, dispenser and dropper in the game
     * wore `furnace_side` on all four sides, including the one with the fire in
     * it. The generic list offers `_front` only after `_side`, which always
     * wins.
     *
     * Derived rather than tabulated: a block has a front if it has a `facing`
     * and the pack ships a `<name>_front`. That covers the furnaces, the
     * smoker, the dispenser and dropper, the loom, the barrel, the carved
     * pumpkin and every workstation at once, and needs no maintenance when the
     * game adds another. `_back` rides along for the observer and the dropper.
     *
     * `_front_on` first when the block is lit, which is the difference between
     * a lit furnace and a cold one -- and `lighting.ts` already treats them as
     * different blocks.
     */
    const facing = entry.properties.facing;
    if (facing !== undefined) {
      const lit = entry.properties.lit === "true";
      if (face === facing) {
        return [
          ...(lit ? [`${normalized}_front_on`] : []),
          `${normalized}_front`,
          `${normalized}_side`,
          normalized,
        ];
      }
      if (face === OPPOSITE_FACE[facing]) {
        return [`${normalized}_back`, `${normalized}_side`, normalized];
      }
    }

    // Two-block-tall plants and doors carry their half in a property and split
    // their texture accordingly. Without this a peony draws its flowering top
    // on both halves, because the generic `_top` candidate wins for every face.
    const half = entry.properties.half;
    if (half === "upper") {
      return [`${normalized}_top`, `${normalized}_upper`, normalized];
    }
    if (half === "lower") {
      return [`${normalized}_bottom`, `${normalized}_lower`, normalized];
    }

    const rules = SPECIAL_FACE_RULES[normalized];
    if (rules) {
      if (face === "up" && rules.top) {
        return [...rules.top];
      }
      if (face === "down" && rules.bottom) {
        return [...rules.bottom];
      }
      if ((HORIZONTAL_FACES as readonly string[]).includes(face) && rules.side) {
        return [...rules.side];
      }
    }

    let candidates: string[];
    if (face === "up") {
      candidates = [
        `${normalized}_top`,
        `${normalized}_up`,
        `${normalized}_upper`,
        `${normalized}_end`,
        `${normalized}_face`,
        normalized,
      ];
    } else if (face === "down") {
      candidates = [
        `${normalized}_bottom`,
        `${normalized}_down`,
        `${normalized}_lower`,
        `${normalized}_end`,
        `${normalized}_face`,
        normalized,
      ];
    } else {
      // Horizontal faces.
      candidates = [
        `${normalized}_side`,
        `${normalized}_side0`,
        `${normalized}_side1`,
        `${normalized}_front`,
        normalized,
      ];
    }
    return [...candidates, ...ModelBaker.materialCandidates(normalized)];
  }

  /**
   * Shaped blocks borrow the texture of the material they are cut from: there
   * is no `oak_stairs.png`, only `oak_planks.png`, and no `cobblestone_wall.png`,
   * only `cobblestone.png`. Every candidate above fails for those, which sent
   * the 85 stairs, 33 fences, 12 slabs and 8 walls of a village schematic to
   * the hashed-colour fallback — the coloured patches on an otherwise
   * plausible-looking render.
   *
   * The suffix is stripped and several spellings of the base material are
   * offered; which one exists is decided by the resource pack rather than by a
   * hardcoded table of wood types, so a modded or updated pack needs no change
   * here.
   */
  private static materialCandidates(name: string): string[] {
    const stripped = SHAPE_SUFFIXES.reduce(
      (current, suffix) => (current.endsWith(suffix) ? current.slice(0, -suffix.length) : current),
      name.startsWith("wall_") ? name.slice("wall_".length) : name,
    );
    if (stripped === name) {
      return [];
    }
    return [
      stripped,
      `${stripped}_planks`,
      `${stripped}s`,
      `${stripped}_block`,
      // A carpet is cut from wool, and there is no `white_carpet.png`. All
      // sixteen drew as coloured cubes, which for a *carpet* is very nearly
      // convincing -- it is a flat coloured square either way.
      `${stripped}_wool`,
      // Quartz is the block whose faces are named after the block and not the
      // material: `quartz_slab` strips to `quartz`, and the tile is
      // `quartz_block_side`.
      `${stripped}_block_side`,
      `${stripped}_block_top`,
    ];
  }

  private static normalizeTextureKey(name: string): string {
    let trimmed = name.trim();
    if (!trimmed) {
      return "minecraft:block/missingno";
    }
    if (trimmed.startsWith("#")) {
      trimmed = trimmed.slice(1);
    }
    let namespace = "minecraft";
    let texturePath = trimmed;
    if (trimmed.includes(":")) {
      const idx = trimmed.indexOf(":");
      namespace = trimmed.slice(0, idx);
      texturePath = trimmed.slice(idx + 1);
    }
    texturePath = texturePath.trim().replace(/^\/+/, "").replace(/\\/g, "/");
    if (texturePath.endsWith(".png")) {
      texturePath = texturePath.slice(0, -4);
    }
    if (texturePath.startsWith("textures/")) {
      texturePath = texturePath.slice("textures/".length);
    }
    if (
      !texturePath.startsWith("block/") &&
      !texturePath.startsWith("item/") &&
      // Block entities (beds, chests, signs) live outside `block/`.
      !texturePath.startsWith("entity/") &&
      /*
       * ...and so does a particle. `particle/flame` is the candle's, which
       * vanilla draws as a particle rather than as geometry -- so this app
       * approximates it and has to be able to name the sprite.
       *
       * Without this the path would be rewritten to `block/particle/flame`,
       * resolve nothing, and `resolveBoxTexture` would fall back to the
       * block's own texture: a flame made of candle wax, silently.
       */
      !texturePath.startsWith("particle/")
    ) {
      texturePath = `block/${texturePath}`;
    }
    return `${namespace}:${texturePath}`;
  }

  private async ensureTextureCached(textureKey: string): Promise<boolean> {
    if (textureKey in this.textureCache) {
      return true;
    }
    const texture = await this.textureSource.loadTexture(textureKey);
    if (texture === null) {
      return false;
    }
    // Tinting here rather than at draw time keeps the atlas the single source
    // of colour: the mesh carries no per-vertex tint and the glTF material has
    // no second colour input.
    const kind = tintKindFor(textureKey);
    const tint = kind === null ? null : kind === "water" ? this.waterTint : this.biomeTint;
    this.textureCache[textureKey] = tint === null ? texture : applyTint(texture, tint);
    /*
     * ...and every frame of it, if it moves.
     *
     * Water is the block that needs both: it is tinted by the biome *and* it is
     * 32 frames. The tint is applied here rather than at draw time so the atlas
     * is the single source of colour — which means the frames the viewer blits
     * into it have to arrive already tinted, or the water would come out the
     * biome's colour for one instant and grey for every frame after.
     */
    const animation = this.textureSource.animationCache[textureKey];
    if (tint !== null && animation !== undefined && !this.tintedAnimations.has(textureKey)) {
      this.tintedAnimations.add(textureKey);
      this.animationCache[textureKey] = {
        frameTime: animation.frameTime,
        frames: animation.frames.map((frame) => applyTint(frame, tint)),
      };
    }
    return true;
  }
}

// PORT STATUS: confidence=medium todos=2
