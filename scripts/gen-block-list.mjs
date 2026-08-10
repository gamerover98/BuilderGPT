// Regenerates `block_id_list.txt`, the set of block ids the generator and the
// AI tools are allowed to place.
//
// It is built from data already vendored in the repo -- the legacy flattening
// table covers everything up to 1.12 -- plus explicit tables for the families
// added afterwards, which that table by construction cannot know about.
//
// Usage, from the repo root:
//
//   node scripts/gen-block-list.mjs > block_id_list.txt
//
// stderr carries a report, including every id whose existence could not be
// corroborated against the shipped resource pack. That list is expected to be
// non-empty -- see the check at the bottom for why -- so read it, don't just
// count it.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import AdmZip from "adm-zip";

const P = "minecraft:";

// --- source 1: the vendored pre-1.13 flattening table -----------------------
const legacyJson = JSON.parse(readFileSync("resources/legacy_blocks.json", "utf8"));
const legacy = new Set();
for (const v of Object.values(legacyJson.blocks)) {
  if (typeof v === "string") legacy.add(v.split("[")[0]);
}

// --- source 2: the existing curated list ------------------------------------
const curated = new Set(
  readFileSync("block_id_list.txt", "utf8")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#")),
);

// --- source 3: families added after 1.12 ------------------------------------
const out = new Set([...legacy, ...curated]);
const add = (name) => out.add(P + name);

// Wood. Every family gets the same derived forms; the exceptions are real
// (crimson/warped are fungus, bamboo is a grass) and are handled per family.
const OVERWORLD_WOODS = [
  "oak", "spruce", "birch", "jungle", "acacia", "dark_oak", "mangrove", "cherry",
];
const NETHER_WOODS = ["crimson", "warped"];

const WOOD_FORMS = [
  "planks", "stairs", "slab", "fence", "fence_gate", "door", "trapdoor",
  "button", "pressure_plate", "sign", "wall_sign", "hanging_sign",
  "wall_hanging_sign",
];

for (const w of OVERWORLD_WOODS) {
  for (const f of WOOD_FORMS) add(`${w}_${f}`);
  add(`${w}_log`);
  add(`${w}_wood`);
  add(`stripped_${w}_log`);
  add(`stripped_${w}_wood`);
  add(`${w}_leaves`);
  // Mangrove grows from a propagule, not a sapling.
  add(w === "mangrove" ? "mangrove_propagule" : `${w}_sapling`);
}

for (const w of NETHER_WOODS) {
  for (const f of WOOD_FORMS) add(`${w}_${f}`);
  add(`${w}_stem`);
  add(`${w}_hyphae`);
  add(`stripped_${w}_stem`);
  add(`stripped_${w}_hyphae`);
  add(`${w}_fungus`);
  add(`${w}_roots`);
  add(`${w}_nylium`);
}

// Bamboo: planks-like forms, but the "log" is a block and there are no leaves.
for (const f of WOOD_FORMS) add(`bamboo_${f}`);
add("bamboo");
add("bamboo_block");
add("stripped_bamboo_block");
add("bamboo_mosaic");
add("bamboo_mosaic_stairs");
add("bamboo_mosaic_slab");

// Stone-like families, with the derived forms each actually has.
const STONE_FAMILIES = {
  stairs_slab_wall: [
    "cobbled_deepslate", "polished_deepslate", "deepslate_brick", "deepslate_tile",
    "blackstone", "polished_blackstone", "polished_blackstone_brick",
    "mud_brick", "tuff", "polished_tuff", "tuff_brick",
  ],
  stairs_slab: [
    "cut_copper", "exposed_cut_copper", "weathered_cut_copper", "oxidized_cut_copper",
    "waxed_cut_copper", "waxed_exposed_cut_copper", "waxed_weathered_cut_copper",
    "waxed_oxidized_cut_copper",
  ],
};
for (const base of STONE_FAMILIES.stairs_slab_wall) {
  add(`${base}_stairs`);
  add(`${base}_slab`);
  add(`${base}_wall`);
}
for (const base of STONE_FAMILIES.stairs_slab) {
  add(`${base}_stairs`);
  add(`${base}_slab`);
}

// Copper oxidation ladder, and the waxed mirror of it.
for (const prefix of ["", "waxed_"]) {
  for (const stage of ["", "exposed_", "weathered_", "oxidized_"]) {
    add(`${prefix}${stage}copper_block`.replace("copper_block", stage === "" ? "copper_block" : "copper"));
    add(`${prefix}${stage}cut_copper`);
    add(`${prefix}${stage}chiseled_copper`);
    add(`${prefix}${stage}copper_grate`);
    add(`${prefix}${stage}copper_bulb`);
    add(`${prefix}${stage}copper_door`);
    add(`${prefix}${stage}copper_trapdoor`);
  }
}

// Everything else added after 1.12, by the version that introduced it.
const STANDALONE = `
  blue_ice conduit dried_kelp_block kelp kelp_plant sea_pickle turtle_egg
  tube_coral_block brain_coral_block bubble_coral_block fire_coral_block horn_coral_block
  dead_tube_coral_block dead_brain_coral_block dead_bubble_coral_block
  dead_fire_coral_block dead_horn_coral_block
  seagrass tall_seagrass smooth_stone smooth_sandstone smooth_red_sandstone smooth_quartz
  stone_stairs granite_stairs polished_granite_stairs diorite_stairs polished_diorite_stairs
  andesite_stairs polished_andesite_stairs mossy_stone_brick_stairs mossy_cobblestone_stairs
  end_stone_brick_stairs prismarine_stairs prismarine_brick_stairs dark_prismarine_stairs
  red_nether_brick_stairs smooth_quartz_stairs smooth_red_sandstone_stairs smooth_sandstone_stairs
  granite_wall diorite_wall andesite_wall sandstone_wall red_sandstone_wall
  stone_brick_wall mossy_stone_brick_wall brick_wall prismarine_wall
  nether_brick_wall red_nether_brick_wall end_stone_brick_wall
  barrel blast_furnace smoker cartography_table fletching_table grindstone lectern loom
  smithing_table stonecutter bell campfire lantern scaffolding jigsaw composter
  sweet_berry_bush bamboo_sapling
  honey_block honeycomb_block beehive bee_nest
  basalt polished_basalt soul_soil soul_torch soul_wall_torch soul_lantern soul_campfire
  soul_fire shroomlight nether_sprouts twisting_vines twisting_vines_plant
  weeping_vines weeping_vines_plant netherite_block ancient_debris crying_obsidian
  respawn_anchor lodestone target chain nether_gold_ore quartz_bricks
  gilded_blackstone chiseled_polished_blackstone cracked_polished_blackstone_bricks
  cracked_nether_bricks chiseled_nether_bricks warped_wart_block nether_wart_block
  deepslate cobbled_deepslate polished_deepslate deepslate_bricks deepslate_tiles
  chiseled_deepslate cracked_deepslate_bricks cracked_deepslate_tiles reinforced_deepslate
  deepslate_coal_ore deepslate_iron_ore deepslate_gold_ore deepslate_copper_ore
  deepslate_lapis_ore deepslate_redstone_ore deepslate_emerald_ore deepslate_diamond_ore
  copper_ore raw_copper_block raw_iron_block raw_gold_block
  amethyst_block budding_amethyst amethyst_cluster small_amethyst_bud
  medium_amethyst_bud large_amethyst_bud calcite tuff smooth_basalt
  dripstone_block pointed_dripstone moss_block moss_carpet azalea flowering_azalea
  azalea_leaves flowering_azalea_leaves big_dripleaf small_dripleaf hanging_roots
  rooted_dirt glow_lichen sculk_sensor tinted_glass powder_snow lightning_rod
  spore_blossom cave_vines cave_vines_plant dirt_path
  candle white_candle orange_candle magenta_candle light_blue_candle yellow_candle
  lime_candle pink_candle gray_candle light_gray_candle cyan_candle purple_candle
  blue_candle brown_candle green_candle red_candle black_candle
  sculk sculk_catalyst sculk_shrieker sculk_vein
  mud packed_mud mud_bricks mangrove_roots muddy_mangrove_roots frogspawn
  ochre_froglight verdant_froglight pearlescent_froglight
  pink_petals torchflower torchflower_crop pitcher_plant pitcher_crop
  suspicious_sand suspicious_gravel calibrated_sculk_sensor decorated_pot sniffer_egg
  chiseled_bookshelf
  crafter trial_spawner vault heavy_core chiseled_tuff chiseled_tuff_bricks
  cornflower lily_of_the_valley wither_rose
`;
for (const name of STANDALONE.split(/\s+/).filter(Boolean)) add(name);

// --- plausibility check against the shipped resource pack -------------------
//
// This catches typos and invented ids, and nothing more. It cannot be a census:
// the pack ships textures only (no blockstates, verified), so it can only vouch
// for blocks that own a texture file named after them.
//
// Derived forms are skipped outright rather than checked through their
// material, because there is no `oak_stairs.png` to find -- a staircase is cut
// from the plank texture. The same goes for the whole tail this reports:
// entity-drawn blocks (beds, chests, banners), blocks that borrow another's
// texture (carpets, waxed copper, infested stone), crops whose texture is
// per-stage, and technical blocks with no texture at all. A non-empty report is
// the expected outcome; it is there to be read, not to be driven to zero.
const packDir = "resources";
const packName = readdirSync(packDir)
  .filter((n) => n.toLowerCase().endsWith(".zip"))
  .sort()[0];
if (!packName) throw new Error(`no resource pack .zip found in ${packDir}/`);

const textures = new Set(
  new AdmZip(path.join(packDir, packName))
    .getEntries()
    .map((e) => e.entryName)
    .filter((n) => /assets\/minecraft\/textures\/block\/[^/]+\.png$/.test(n))
    .map((n) => n.split("/").pop().replace(/\.png$/, "")),
);

const DERIVED =
  /_(stairs|slab|wall|fence|fence_gate|door|trapdoor|button|pressure_plate|sign|wall_sign|hanging_sign|wall_hanging_sign)$/;
const unverified = [];
for (const id of out) {
  const bare = id.slice(P.length);
  if (DERIVED.test(bare)) continue;
  const candidates = [bare, `${bare}_top`, `${bare}_side`, `${bare}_front`, `${bare}_0`, `${bare}_still`];
  if (!candidates.some((c) => textures.has(c))) unverified.push(id);
}

const sorted = [...out].sort();
const header = [
  "# Block ids the generated build script and the AI tools are allowed to place.",
  "#",
  "# GENERATED FILE -- edit scripts/gen-block-list.mjs and re-run it instead:",
  "#",
  "#   node scripts/gen-block-list.mjs > block_id_list.txt",
  "#",
  "# Sources: resources/legacy_blocks.json (PrismarineJS/minecraft-data, MIT)",
  "# for everything up to 1.12, plus explicit family tables in the generator",
  "# for 1.13 and later. Lines starting with '#' are comments; blank lines are",
  "# ignored. Both the loader and the prompt strip them.",
  "#",
  `# ${sorted.length} blocks.`,
  "",
];
process.stdout.write(header.concat(sorted).join("\n") + "\n");

console.error(`legacy:   ${legacy.size}`);
console.error(`curated:  ${curated.size}`);
console.error(`total:    ${sorted.length}`);
console.error(`textures: ${textures.size}`);
console.error(`\nno texture of their own (${unverified.length}, expected -- see comment):`);
console.error(unverified.join(" "));
