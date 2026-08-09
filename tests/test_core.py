"""Tests for core.py.

quickjs cannot be installed in this sandbox (its native extension needs a C
compiler toolchain that isn't available here), so tests that exercise
`_execute_js_build`'s block-placement logic drive it through a fake quickjs
context whose `eval` invokes the registered Python callables directly instead
of running real JS. This tests the Python-side bridge logic (block
normalization, fill modes, coordinate handling) exactly as quickjs would
invoke it — only the JS parsing itself is out of scope here, since that's
provided entirely by the (unavailable) native engine, not by this codebase.
"""
import json
import os

import pytest

import core


class FakeQuickJSContext:
    """Stand-in for quickjs.Context that drives registered callables directly."""

    def __init__(self, driver):
        self.callables = {}
        self._driver = driver

    def add_callable(self, name, fn):
        self.callables[name] = fn

    def eval(self, code):
        if "buildCreation" in code:
            self._driver(self.callables)


# --- _load_allowed_blocks ---------------------------------------------------

def test_load_allowed_blocks_reads_real_block_list():
    allowed = core._load_allowed_blocks()
    assert "minecraft:stone" in allowed
    assert len(allowed) > 0


def test_load_allowed_blocks_missing_file_returns_empty_set(monkeypatch):
    monkeypatch.setattr(core.os.path, "dirname", lambda _: "/nonexistent/path")
    assert core._load_allowed_blocks() == set()


# --- _normalize_block --------------------------------------------------------

def test_normalize_block_adds_minecraft_namespace():
    allowed = {"minecraft:stone"}
    assert core._normalize_block("stone", None, allowed) == "minecraft:stone"


def test_normalize_block_rejects_unsupported_block():
    allowed = {"minecraft:stone"}
    assert core._normalize_block("bedrock", None, allowed) is None


def test_normalize_block_empty_type_returns_none():
    assert core._normalize_block("", None, {"minecraft:stone"}) is None


def test_normalize_block_appends_sorted_states():
    allowed = {"minecraft:oak_stairs"}
    result = core._normalize_block(
        "minecraft:oak_stairs", {"half": "top", "facing": "north"}, allowed
    )
    assert result == "minecraft:oak_stairs[facing=north,half=top]"


def test_normalize_block_ignores_empty_states_dict():
    allowed = {"minecraft:stone"}
    assert core._normalize_block("minecraft:stone", {}, allowed) == "minecraft:stone"


def test_normalize_block_strips_existing_state_suffix_for_membership_check():
    allowed = {"minecraft:oak_stairs"}
    result = core._normalize_block("minecraft:oak_stairs[facing=north]", None, allowed)
    assert result == "minecraft:oak_stairs"


# --- _extract_js_code --------------------------------------------------------

def test_extract_js_code_finds_code_block():
    text = "some preamble <code>function buildCreation(){}</code> trailing"
    assert core._extract_js_code(text) == "function buildCreation(){}"


def test_extract_js_code_returns_none_when_absent():
    assert core._extract_js_code("no code tags here") is None


def test_extract_js_code_returns_none_for_empty_text():
    assert core._extract_js_code("") is None


def test_extract_js_code_case_insensitive_and_multiline():
    text = "<CODE>\nfunction buildCreation(){\n  doStuff();\n}\n</CODE>"
    result = core._extract_js_code(text)
    assert "doStuff" in result


# --- _ensure_quickjs (real, quickjs genuinely unavailable in this sandbox) --

def test_ensure_quickjs_returns_none_when_engine_unavailable():
    assert core._ensure_quickjs() is None


def test_execute_js_build_raises_when_engine_unavailable():
    with pytest.raises(RuntimeError):
        core._execute_js_build("function buildCreation(x,y,z){}")


# --- _execute_js_build via fake quickjs context -----------------------------

def test_execute_js_build_set_block_places_normalized_block(monkeypatch):
    def driver(callables):
        callables["pySetBlock"](1, 2, 3, "stone", None)

    monkeypatch.setattr(core, "_ensure_quickjs", lambda: FakeQuickJSContext(driver))
    result = core._execute_js_build("/* driven by fake ctx */")
    assert result == [(1, 2, 3, "minecraft:stone")]


def test_execute_js_build_set_block_rejects_unsupported_block(monkeypatch):
    def driver(callables):
        callables["pySetBlock"](0, 0, 0, "totally_not_a_block", None)

    monkeypatch.setattr(core, "_ensure_quickjs", lambda: FakeQuickJSContext(driver))
    result = core._execute_js_build("/* driven */")
    assert result == []


def test_execute_js_build_set_block_keep_mode_does_not_overwrite(monkeypatch):
    def driver(callables):
        callables["pySetBlock"](0, 0, 0, "stone", None)
        callables["pySetBlock"](0, 0, 0, "dirt", {"mode": "keep"})

    monkeypatch.setattr(core, "_ensure_quickjs", lambda: FakeQuickJSContext(driver))
    result = core._execute_js_build("/* driven */")
    assert result == [(0, 0, 0, "minecraft:stone")]


def test_execute_js_build_fill_region_fills_cuboid(monkeypatch):
    def driver(callables):
        callables["pyFill"](0, 0, 0, 1, 0, 0, "stone", None)

    monkeypatch.setattr(core, "_ensure_quickjs", lambda: FakeQuickJSContext(driver))
    result = core._execute_js_build("/* driven */")
    assert sorted(result) == [(0, 0, 0, "minecraft:stone"), (1, 0, 0, "minecraft:stone")]


def test_execute_js_build_fill_region_normalizes_reversed_coordinates(monkeypatch):
    def driver(callables):
        callables["pyFill"](1, 0, 0, 0, 0, 0, "stone", None)  # x1 > x2

    monkeypatch.setattr(core, "_ensure_quickjs", lambda: FakeQuickJSContext(driver))
    result = core._execute_js_build("/* driven */")
    assert len(result) == 2


def test_execute_js_build_fill_region_outline_mode_skips_interior(monkeypatch):
    def driver(callables):
        # A genuinely 3D 3x3x3 region: with a flat (zero-thickness) axis every
        # cell trivially satisfies "at the y1/y2 surface", so this needs all
        # three axes to have a real interior cell to exclude.
        callables["pyFill"](0, 0, 0, 2, 2, 2, "stone", {"mode": "outline"})

    monkeypatch.setattr(core, "_ensure_quickjs", lambda: FakeQuickJSContext(driver))
    result = core._execute_js_build("/* driven */")

    # 3x3x3 cube, outline mode -> all but the single center cell (26 of 27).
    assert len(result) == 26
    assert (1, 1, 1, "minecraft:stone") not in result


def test_execute_js_build_fill_region_replace_mode_only_replaces_matching_block(monkeypatch):
    def driver(callables):
        callables["pySetBlock"](0, 0, 0, "dirt", None)
        callables["pySetBlock"](1, 0, 0, "stone", None)
        callables["pyFill"](
            0, 0, 0, 1, 0, 0, "oak_planks", {"mode": "replace", "replaceFilter": "dirt"}
        )

    monkeypatch.setattr(core, "_ensure_quickjs", lambda: FakeQuickJSContext(driver))
    result = core._execute_js_build("/* driven */")
    result_map = {(x, y, z): block for (x, y, z, block) in result}
    assert result_map[(0, 0, 0)] == "minecraft:oak_planks"  # was dirt, replaced
    assert result_map[(1, 0, 0)] == "minecraft:stone"  # was stone, not replaced


def test_execute_js_build_result_is_sorted(monkeypatch):
    def driver(callables):
        callables["pySetBlock"](2, 0, 0, "stone", None)
        callables["pySetBlock"](0, 0, 0, "stone", None)
        callables["pySetBlock"](1, 0, 0, "stone", None)

    monkeypatch.setattr(core, "_ensure_quickjs", lambda: FakeQuickJSContext(driver))
    result = core._execute_js_build("/* driven */")

    assert [r[0] for r in result] == [0, 1, 2]


# --- text_to_schem: JSON fallback path (no quickjs required) ---------------

def test_text_to_schem_json_fallback_schem(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    payload = json.dumps(
        {
            "structures": [
                {"type": "single", "block": "minecraft:stone", "x": 0, "y": 0, "z": 0},
            ]
        }
    )
    result = core.text_to_schem(payload, export_type="schem")
    assert result is not None  # mcschematic.MCSchematic instance


def test_text_to_schem_json_fallback_mcfunction(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    payload = json.dumps(
        {
            "structures": [
                {"type": "single", "block": "minecraft:stone", "x": 0, "y": 0, "z": 0},
            ]
        }
    )
    path = core.text_to_schem(payload, export_type="mcfunction")
    assert os.path.isfile(path)
    with open(path) as fh:
        content = fh.read()
    assert "setblock 0 0 0 minecraft:stone" in content


def test_text_to_schem_json_fallback_fill_range(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    payload = json.dumps(
        {
            "structures": [
                {
                    "type": "fill",
                    "block": "minecraft:stone",
                    "x": 0,
                    "y": 0,
                    "z": 0,
                    "toX": 1,
                    "toY": 0,
                    "toZ": 0,
                },
            ]
        }
    )
    path = core.text_to_schem(payload, export_type="mcfunction")
    with open(path) as fh:
        content = fh.read()
    assert content.count("setblock") == 2


def test_text_to_schem_invalid_input_returns_none():
    assert core.text_to_schem("not json and no <code> tags", export_type="schem") is None


def test_text_to_schem_js_path_failure_does_not_fall_back_to_json(monkeypatch):
    # Even though the text also happens to be invalid JSON, presence of <code>
    # commits to the JS path per the function's documented contract.
    monkeypatch.setattr(core, "_ensure_quickjs", lambda: None)
    text = "<code>function buildCreation(x,y,z){}</code>"
    assert core.text_to_schem(text, export_type="schem") is None


# --- version helpers ----------------------------------------------------------

def test_input_version_to_mcs_tag_valid():
    import mcschematic

    result = core.input_version_to_mcs_tag("JE_1_20_1")
    assert result == mcschematic.Version.JE_1_20_1


def test_input_version_to_mcs_tag_invalid_returns_none():
    assert core.input_version_to_mcs_tag("NOT_A_REAL_VERSION") is None


def test_format_version_for_prompt_typical():
    assert core.format_version_for_prompt("JE_1_20_4") == "1.20.4"


def test_format_version_for_prompt_no_digits_returns_original():
    assert core.format_version_for_prompt("LATEST") == "LATEST"
