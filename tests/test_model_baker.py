import numpy as np

from app.pipeline.model_baker import ModelBaker, ResourcePackTextures
from app.pipeline.types import PaletteEntry


def _isolated_baker(monkeypatch):
    """A ModelBaker guaranteed to have no texture sources.

    The repo ships a bundled resource pack under public/*.zip that
    ResourcePackTextures auto-discovers as a fallback even when no explicit
    path is given (see ResourcePackTextures._discover_fallback) — real,
    intended behavior, but it means ModelBaker() alone isn't sufficient to
    reach the hashed-color-cube fallback path deterministically in tests.
    """
    from app.pipeline import model_baker as model_baker_module

    monkeypatch.setattr(
        model_baker_module.ResourcePackTextures, "_discover_fallback", staticmethod(lambda skip: None)
    )
    return ModelBaker()


def test_bake_blockstate_fallback_produces_six_faces(monkeypatch):
    baker = _isolated_baker(monkeypatch)  # no texture sources -> hashed color cube
    entry = PaletteEntry("minecraft:stone", {})

    baked = baker.bake_blockstate(entry)

    assert set(baked.faces.keys()) == {"north", "south", "east", "west", "up", "down"}
    assert baked.texture_key == entry.cache_key


def test_bake_blockstate_is_cached_by_entry_key(monkeypatch):
    baker = _isolated_baker(monkeypatch)
    entry = PaletteEntry("minecraft:stone", {})

    first = baker.bake_blockstate(entry)
    second = baker.bake_blockstate(entry)

    assert first is second


def test_bake_blockstate_different_entries_get_different_colors(monkeypatch):
    baker = _isolated_baker(monkeypatch)
    stone = baker.bake_blockstate(PaletteEntry("minecraft:stone", {}))
    dirt = baker.bake_blockstate(PaletteEntry("minecraft:dirt", {}))

    stone_tex = baker.textures[stone.texture_key]
    dirt_tex = baker.textures[dirt.texture_key]
    assert not np.array_equal(stone_tex, dirt_tex)


def test_bake_blockstate_uses_bundled_resource_pack_when_present():
    # Real end-to-end behavior: ModelBaker() with no explicit path still
    # picks up the repo's bundled public/*.zip resource pack.
    baker = ModelBaker()
    assert baker._texture_source.has_sources is True


def test_color_from_key_is_deterministic():
    color1 = ModelBaker._color_from_key("minecraft:stone")
    color2 = ModelBaker._color_from_key("minecraft:stone")
    assert np.array_equal(color1, color2)
    assert color1.shape == (4,)
    assert color1[3] == 255


def test_normalize_texture_key_adds_minecraft_namespace_and_block_path():
    assert ModelBaker._normalize_texture_key("stone") == "minecraft:block/stone"


def test_normalize_texture_key_preserves_existing_namespace_and_item_path():
    assert ModelBaker._normalize_texture_key("mymod:item/gem") == "mymod:item/gem"


def test_normalize_texture_key_strips_hash_and_png_extension():
    assert ModelBaker._normalize_texture_key("#block/stone.png") == "minecraft:block/stone"


def test_normalize_texture_key_empty_name_returns_missingno():
    assert ModelBaker._normalize_texture_key("") == "minecraft:block/missingno"


def test_face_candidates_uses_special_rules_for_grass_block():
    baker = ModelBaker()
    assert baker._face_candidates("grass_block", "up") == ["grass_block_top"]
    assert baker._face_candidates("grass_block", "down") == ["dirt"]
    assert baker._face_candidates("grass_block", "north") == ["grass_block_side"]


def test_face_candidates_default_naming_for_unknown_block():
    baker = ModelBaker()
    up_candidates = baker._face_candidates("cobblestone", "up")
    assert "cobblestone_top" in up_candidates
    down_candidates = baker._face_candidates("cobblestone", "down")
    assert "cobblestone_bottom" in down_candidates
    side_candidates = baker._face_candidates("cobblestone", "north")
    assert "cobblestone_side" in side_candidates


def test_resource_pack_textures_without_sources_returns_none(monkeypatch):
    monkeypatch.setattr(ResourcePackTextures, "_discover_fallback", staticmethod(lambda skip: None))
    textures = ResourcePackTextures(None)
    assert textures.has_sources is False
    assert textures.load_texture("minecraft:block/stone") is None


def test_resource_pack_textures_missing_primary_path_is_skipped(monkeypatch):
    monkeypatch.setattr(ResourcePackTextures, "_discover_fallback", staticmethod(lambda skip: None))
    textures = ResourcePackTextures("/definitely/does/not/exist.zip")
    assert textures.has_sources is False


def test_resource_pack_textures_missing_texture_from_bundled_pack_returns_none():
    # Real bundled pack, but a texture key that can't plausibly exist.
    textures = ResourcePackTextures(None)
    assert textures.has_sources is True
    assert textures.load_texture("minecraft:block/definitely_not_a_real_block") is None


def test_resource_pack_textures_split_key_default_namespace():
    namespace, path = ResourcePackTextures._split_key("stone")
    assert namespace == "minecraft"
    assert path == "stone"


def test_resource_pack_textures_split_key_strips_textures_prefix_and_extension():
    namespace, path = ResourcePackTextures._split_key("minecraft:textures/block/stone.png")
    assert namespace == "minecraft"
    assert path == "block/stone"


def test_resource_pack_textures_candidate_paths():
    candidates = ResourcePackTextures._candidate_paths("minecraft", "block/stone")
    assert candidates == [
        "assets/minecraft/textures/block/stone.png",
        "assets/minecraft/block/stone.png",
    ]
