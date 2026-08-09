import numpy as np

from app.pipeline import translate as translate_module
from app.pipeline.translate import normalize_palette
from app.pipeline.types import PaletteEntry, StructureBounds, StructureData


def _struct(palette):
    bounds = StructureBounds(0, 0, 0, 0, 0, 0)
    voxels = np.zeros((1, 1, 1), dtype=np.int32)
    return StructureData(bounds, palette, voxels)


def test_normalize_palette_returns_unchanged_when_pymctranslate_unavailable():
    # pymctranslate is not installed in this test environment, so the
    # TranslationManager import guard in translate.py is exercised naturally.
    struct = _struct([PaletteEntry("minecraft:stone", {})])

    result = normalize_palette(struct)

    assert result is struct


class _FakeBlockApi:
    def __init__(self, to_universal_result):
        self._to_universal_result = to_universal_result

    def from_universal(self, name, properties):
        return ("universal-block", name, properties)

    def to_universal(self, block):
        return self._to_universal_result


class _FakeTranslator:
    def __init__(self, to_universal_result):
        self.block = _FakeBlockApi(to_universal_result)


class _FakeTranslationManager:
    def __init__(self, target_platform, resource_pack):
        self.target_platform = target_platform
        self.resource_pack = resource_pack

    def get_version(self, target):
        return self._translator

    _translator = None  # patched per-test via class attribute below


def test_normalize_palette_applies_translation_when_manager_available(monkeypatch):
    translator = _FakeTranslator(to_universal_result=("minecraft:polished_stone", {"foo": "bar"}))

    class Manager(_FakeTranslationManager):
        def get_version(self, target):
            return translator

    monkeypatch.setattr(translate_module, "TranslationManager", Manager)
    struct = _struct([PaletteEntry("minecraft:stone", {})])

    result = normalize_palette(struct)

    assert result is not struct
    assert result.palette[0].namespaced_name == "minecraft:polished_stone"
    assert result.palette[0].properties == {"foo": "bar"}


def test_normalize_palette_merges_list_of_property_dicts(monkeypatch):
    translator = _FakeTranslator(
        to_universal_result=("minecraft:stairs", [{"facing": "north"}, {"half": "top"}])
    )

    class Manager(_FakeTranslationManager):
        def get_version(self, target):
            return translator

    monkeypatch.setattr(translate_module, "TranslationManager", Manager)
    struct = _struct([PaletteEntry("minecraft:oak_stairs", {})])

    result = normalize_palette(struct)

    assert result.palette[0].properties == {"facing": "north", "half": "top"}


def test_normalize_palette_keeps_entry_when_to_universal_returns_none(monkeypatch):
    translator = _FakeTranslator(to_universal_result=None)

    class Manager(_FakeTranslationManager):
        def get_version(self, target):
            return translator

    monkeypatch.setattr(translate_module, "TranslationManager", Manager)
    entry = PaletteEntry("minecraft:stone", {})
    struct = _struct([entry])

    result = normalize_palette(struct)

    assert result.palette[0] is entry


def test_normalize_palette_keeps_entry_when_from_universal_raises(monkeypatch):
    class ExplodingBlockApi:
        def from_universal(self, name, properties):
            raise RuntimeError("boom")

    class Translator:
        block = ExplodingBlockApi()

    class Manager(_FakeTranslationManager):
        def get_version(self, target):
            return Translator()

    monkeypatch.setattr(translate_module, "TranslationManager", Manager)
    entry = PaletteEntry("minecraft:stone", {})
    struct = _struct([entry])

    result = normalize_palette(struct)

    assert result.palette[0] is entry


def test_normalize_palette_falls_back_when_manager_construction_raises(monkeypatch):
    class ExplodingManager:
        def __init__(self, target_platform, resource_pack):
            raise RuntimeError("no translation data")

    monkeypatch.setattr(translate_module, "TranslationManager", ExplodingManager)
    struct = _struct([PaletteEntry("minecraft:stone", {})])

    result = normalize_palette(struct)

    assert result is struct


def test_normalize_palette_falls_back_when_get_version_raises(monkeypatch):
    class Manager(_FakeTranslationManager):
        def get_version(self, target):
            raise RuntimeError("unsupported target version")

    monkeypatch.setattr(translate_module, "TranslationManager", Manager)
    struct = _struct([PaletteEntry("minecraft:stone", {})])

    result = normalize_palette(struct)

    assert result is struct
