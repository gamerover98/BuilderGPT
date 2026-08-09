import numpy as np

from app.pipeline.types import BakedFace, PaletteEntry, StructureBounds


def test_structure_bounds_size():
    bounds = StructureBounds(min_x=0, min_y=0, min_z=0, max_x=4, max_y=9, max_z=2)
    assert bounds.size == (5, 10, 3)


def test_structure_bounds_size_single_block():
    bounds = StructureBounds(0, 0, 0, 0, 0, 0)
    assert bounds.size == (1, 1, 1)


def test_palette_entry_cache_key_no_properties():
    entry = PaletteEntry("minecraft:stone", {})
    assert entry.cache_key == "minecraft:stone"


def test_palette_entry_cache_key_sorted_properties():
    entry = PaletteEntry("minecraft:oak_stairs", {"facing": "north", "half": "top"})
    assert entry.cache_key == "minecraft:oak_stairs[facing=north,half=top]"


def test_palette_entry_cache_key_is_deterministic_regardless_of_dict_order():
    a = PaletteEntry("minecraft:oak_stairs", {"half": "top", "facing": "north"})
    b = PaletteEntry("minecraft:oak_stairs", {"facing": "north", "half": "top"})
    assert a.cache_key == b.cache_key


def test_palette_entry_is_air_variants():
    assert PaletteEntry("minecraft:air", {}).is_air
    assert PaletteEntry("air", {}).is_air
    assert PaletteEntry("minecraft:cave_air", {}).is_air is False  # not in :air suffix/exact set check below
    assert not PaletteEntry("minecraft:stone", {}).is_air


def test_palette_entry_is_transparent_air_is_transparent():
    assert PaletteEntry("minecraft:air", {}).is_transparent


def test_palette_entry_is_transparent_prefix_matches():
    assert PaletteEntry("minecraft:glass_pane", {}).is_transparent
    assert PaletteEntry("minecraft:ice", {}).is_transparent
    assert PaletteEntry("minecraft:water", {}).is_transparent
    assert PaletteEntry("minecraft:kelp_plant", {}).is_transparent
    assert PaletteEntry("minecraft:torch", {}).is_transparent


def test_palette_entry_is_transparent_exact_set():
    assert PaletteEntry("minecraft:barrier", {}).is_transparent
    assert PaletteEntry("minecraft:light", {}).is_transparent
    assert PaletteEntry("minecraft:cave_air", {}).is_transparent
    assert PaletteEntry("minecraft:void_air", {}).is_transparent


def test_palette_entry_is_transparent_false_for_opaque():
    assert not PaletteEntry("minecraft:stone", {}).is_transparent


def test_baked_face_offset_translates_positions_only():
    positions = np.array([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], dtype=np.float32)
    uvs = np.array([[0, 0], [1, 0], [1, 1], [0, 1]], dtype=np.float32)
    face = BakedFace(positions=positions, uvs=uvs, normal=(0.0, 0.0, -1.0), texture_key="minecraft:stone")

    offset_face = face.offset(2, 3, 4)

    expected = positions + np.array([2, 3, 4], dtype=np.float32)
    assert np.array_equal(offset_face.positions, expected)
    assert np.array_equal(offset_face.uvs, uvs)
    assert offset_face.normal == (0.0, 0.0, -1.0)
    assert offset_face.texture_key == "minecraft:stone"
    # original untouched
    assert np.array_equal(face.positions, positions)
