---
name: mc-block-models
description: Find a Minecraft block's real vanilla geometry and texture names on the web, and transcribe them into this app's hand-written shape and texture tables. Use when a block renders as a flat coloured cube, when a texture looks smeared or samples the wrong part of a sheet, when a block draws as a full cube that is not one, or when adding a block that has no block model at all (chest, double chest, bed, sign, decorated pot).
---

# Drawing a block the way the game draws it

This app does not read Minecraft's models. It cannot: the vanilla models live in
the client jar, which is not redistributable, and the bundled Faithful pack is a
*texture* pack that ships three model files, one of them an item. So
`src/main/pipeline/block_shapes.ts` describes the geometry by hand, in vanilla's
own 0..16 units, transcribed from the real thing.

Transcribed, not invented — and that is what this skill is for.

## Two failures with one appearance

Both are silent. Neither raises, logs, or looks like an error.

**No derivable texture -> the hashed-colour cube.** `ModelBaker` tries a list of
candidate texture names; when every one misses it falls back to a cube coloured
by hashing the block name. The result is a plausible solid block in an
arbitrary colour. `minecraft:water[level=0]` hashed to a vivid green for
months. As of the audit that produced this skill, **140 of the 920 ids in
`block_id_list.txt` resolved no texture at all** — and every one of their
correct textures was already in the shipped pack. Not one asset was missing;
they were all naming rules.

**No shape entry -> a full opaque cube.** `shapeFor` returns `CUBE` for anything
unlisted, and `occludesNeighbours` then lets that cube **delete the faces of its
six neighbours**. A carpet drawn as a cube does not merely look wrong, it puts a
hole in the floor underneath it.

## The line that must not be crossed

**Read and transcribe. Never vendor, never fetch at runtime.**

`block_shapes.ts` exists *because* the vanilla assets cannot be shipped.
Coordinates copied into hand-written TypeScript are what that file already is
and what it must remain. Do not add a model JSON to `resources/`. Do not make
the app download one. The mirrors below are for reading during development, the
same way the wiki is.

## The sources

| source | what it gives |
|---|---|
| `raw.githubusercontent.com/InventivetalentDev/minecraft-assets/<tag>/assets/minecraft/blockstates/<block>.json` | which model each block state selects, and its rotation |
| `raw.githubusercontent.com/InventivetalentDev/minecraft-assets/<tag>/assets/minecraft/models/block/<model>.json` | the boxes, the UVs, the texture keys |
| `minecraft.wiki/w/<Block>` | the blocks that have **no model at all**, and what their entity sheet holds |

`<tag>` is a released version, e.g. `1.21.4`. One small file per request, so
nothing truncates — which is the reason to prefer per-block URLs over any
aggregated dump.

Always read the **blockstate** file first. It is what tells you a fence is
`multipart` — a post plus one side model per connection — rather than one model
per state, and that is a fact about the *shape function you need to write*, not
just about the geometry.

## Reading a model into this codebase

A vanilla element maps onto `ShapeBox` almost one to one.

```json
{ "from": [ 6.5, 0, 8 ], "to": [ 9.5, 16, 8 ],
  "rotation": { "origin": [ 8, 8, 8 ], "axis": "y", "angle": 45 },
  "faces": { "north": { "uv": [ 3, 0, 0, 16 ], "texture": "#all" } } }
```

- **`from`/`to` are already `Box`.** Same 0..16 space, same axis order.
- **`rotation` is `BoxRotation`.** Only ±22.5 and ±45 occur; both are supported.
- **`parent` must be followed.** `block/cube_all` means the texture is `#all`;
  `block/orientable` splits front/side/top. Chase the chain until you reach the
  `textures` block that actually names a file.
- **`faces.<dir>.uv` is `ShapeBox.uv`**, in the tile's own 0..16 space, and it is
  **required whenever the texture is a sheet rather than a full-block tile.**
  Lantern, chain and bell are the ones already known. UVs derived from box
  coordinates are correct for a slab cut out of `oak_planks` and address
  completely the wrong pixels on a sheet.
- **A reversed window is a mirror, and it works.** `[3, 0, 0, 16]` has `u0 > u1`;
  `windowUvsFrom` divides by 16 and assumes no ordering, so the face comes out
  mirrored, which is exactly what vanilla means by it.
- **A face vanilla omits should be omitted here too**, via `ShapeBox.omit` —
  and so should a face that another box of the same block covers. Two coincident
  faces z-fight; that flickering seam is what a chest lid resting on its body
  looks like.
- **A zero-thickness element is a plane, not a box.** `from`/`to` equal on one
  axis means four of the six faces have no area. They must not be emitted.

### Which way is the model authored

This is the single easiest thing to get a quarter-turn wrong, and it is not
uniform across vanilla:

- stairs and torches are authored **facing east** (`facingSteps`)
- trapdoors and most `facing` templates are authored **facing north**
  (`northFacingSteps`)
- fence gates are authored **facing south** (`southFacingSteps`)

Do not guess. The blockstate file settles it: find the variant with `y` absent
or `y: 0` and read which `facing` it belongs to.

## Blocks with no model at all

Beds, chests, signs, banners, shulker boxes, decorated pots, bells and conduits
are drawn by dedicated **block entity** renderers from `textures/entity/`, not
from any model file. There is nothing to fetch from `models/block/`.

`unwrapCube` in `block_shapes.ts` already reproduces Minecraft's `ModelPart`
sheet layout — for a box `dx x dy x dz` at sheet offset `(u, v)`:

```
down  (u+dz,     v,    dx, dz)     west  (u,        v+dz, dz, dy)
up    (u+dz+dx,  v,    dx, dz)     north (u+dz,     v+dz, dx, dy)
                                   east  (u+dz+dx,  v+dz, dz, dy)
                                   south (u+2dz+dx, v+dz, dx, dy)
```

What has to be looked up is the **box sizes and their offsets on the sheet** —
a chest body is 14x10x14 at (0,19) and its lid 14x5x14 at (0,0); a bed head is
at (0,0) and its foot at (0,22), with four 3x3x3 legs at x=50. The wiki and the
sheet itself are the sources. Getting a leg's offset wrong does not look like a
UV bug, it looks like a pale rectangle under the bed.

**A double chest is two blocks**, each wearing half of a wider sheet, selected by
`type=left`/`type=right` in `entityTextureAlias`. Which block gets which half is
a fact about the *pairing*, and pairing is `shared/block_connections.ts`'s job,
not this one.

Some sheets cannot be used and the honest answer is a stand-in: a banner is a
base plus a stack of pattern layers this code cannot compose, and a shulker
box's sheet is laid out for an animated lid. Both fall back to dyed wool,
deliberately.

## Where a texture name is decided

`src/main/pipeline/model_baker.ts`:

- `faceCandidates` — the ordered guesses per face (`_top`, `_side`, `_front`,
  the bare name). It receives the whole `PaletteEntry`, so a candidate may depend
  on a property; the crops do exactly that (`wheat[age=7]` -> `wheat_stage7`).
- `materialCandidates` — for a **shape cut from a material**. There is no
  `oak_stairs.png`, only `oak_planks.png`. The suffix is stripped and several
  spellings offered.
- `SPECIAL_FACE_RULES` — explicit per-face overrides for anything the pattern
  cannot reach.
- `entityTextureAlias` — the block-entity sheets above.

The trap that produced most of the 140: **stripping a suffix gives a base name
that must itself exist.** `white_carpet` strips to `white`, and `white` is not a
texture — `white_wool` is. `oak_wood` needs `oak_log`; `warped_hyphae` needs
`warped_stem`; `waxed_cut_copper` needs `cut_copper`. Every rule added here must
be checked against the pack, not reasoned about.

## What reads this downstream

**Not the MCP wire**, which is worth saying because every other dataset in
`.claude/skills/` is on it. Geometry does not leave this process: `describe_block`
answers with states and versions, never with a shape, so a box transcribed
wrongly here cannot mislead a model directly.

It can still mislead one indirectly, through `capture_viewport` -- the one tool
that answers with a picture. A block drawn as the wrong shape is photographed
as the wrong shape, and a model checking its own work by looking will believe
it. That is an argument for the tripwires in `tests/blocks.ts` rather than for
anything here.

## Doing it

1. **Name the block and reproduce the fault.** Coloured cube (texture) or wrong
   solid shape (geometry)? They have different fixes and different files.

2. **Fetch the blockstate file**, then every model it names. Follow `parent`.

3. **Transcribe** into `block_shapes.ts` (geometry, UV windows, `omit`) and/or
   `model_baker.ts` (candidates, special rules). Keep vanilla's numbers; do not
   round them. `6.5` is `6.5`.

4. **Verify every texture name against the shipped pack.** This is not optional
   and not a matter of confidence:

   ```bash
   npx tsx tests/blocks.ts
   ```

   The suite walks every id in `block_id_list.txt` and fails on any that reaches
   the hashed-colour fallback, by name. A fix that is right in prose and wrong by
   one underscore is caught here and nowhere else.

5. **Check the culling.** If the block is not a full opaque cube, confirm
   `occludesNeighbours` says so. A shaped block that still occludes punches holes
   in whatever it stands against.

6. **Show the user the model you transcribed from**, with its URL and version
   tag. Geometry with no provenance is indistinguishable from geometry somebody
   eyeballed.

## Notes worth having

- **An animated texture is its frames stacked vertically in one PNG.**
  `lantern.png` is three frames tall. `firstAnimationFrame` crops to frame 0 on
  load; without it the atlas squashes the strip and every UV window on that
  texture addresses the wrong pixels. Detected by shape, not by reading the
  `.mcmeta`.
- **Only a full opaque cube may cull.** Culling against a slab or a fence
  removes faces nothing covers.
- **A block that is invisible in game may still need drawing.** Barriers and
  structure voids are placed on purpose and a build full of them would look
  empty, so they are drawn from their `item/` icon — the only texture they have.
  `light` stays invisible, because it has no appearance to reproduce.
- **Fluids are not named after their block.** `minecraft:water` draws from
  `water_still`. None of the generic candidates produces that.
- **Unlisted stays a cube.** That is the same answer as before the block was
  looked at, so an omission costs nothing — while a confidently wrong shape is
  worse than none, because it looks deliberate.
