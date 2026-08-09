import numpy as np
import nbtlib
import pytest
from nbtlib import tag

from app.pipeline.loader import (
    _decode_packed_block_states,
    _decode_varint_block_data,
    _parse_palette_entry,
    load_structure,
)


def test_parse_palette_entry_no_properties():
    entry = _parse_palette_entry("minecraft:stone")
    assert entry.namespaced_name == "minecraft:stone"
    assert entry.properties == {}


def test_parse_palette_entry_with_properties():
    entry = _parse_palette_entry("minecraft:oak_stairs[facing=north,half=top]")
    assert entry.namespaced_name == "minecraft:oak_stairs"
    assert entry.properties == {"facing": "north", "half": "top"}


def test_parse_palette_entry_boolean_flag_property():
    entry = _parse_palette_entry("minecraft:oak_leaves[persistent]")
    assert entry.properties == {"persistent": "true"}


def test_decode_varint_block_data_single_byte_values():
    # Values below 128 fit in a single byte with no continuation bit.
    data = [0, 1, 5]
    result = _decode_varint_block_data(data, total_blocks=3)
    assert result.tolist() == [0, 1, 5]


def test_decode_varint_block_data_multibyte_value():
    # 300 in varint: 0b100101100 -> low7=0101100|0x80=0xAC, high=0b10=2
    data = [0xAC, 0x02]
    result = _decode_varint_block_data(data, total_blocks=1)
    assert result.tolist() == [300]


def test_decode_varint_block_data_pads_missing_with_zero():
    result = _decode_varint_block_data([0], total_blocks=3)
    assert result.tolist() == [0, 0, 0]


def test_decode_packed_block_states_minimum_bits_per_block():
    # palette_size=2 -> bits_per_block = max(4, (1).bit_length()) = 4
    # pack values [1, 0, 1] into nibbles of a byte stream (LSB first within byte).
    # byte 0: nibble0=1, nibble1=0 -> 0x01 ; byte1: nibble0=1 -> 0x01
    raw_bytes = bytes([0x01, 0x01])
    result = _decode_packed_block_states(raw_bytes, palette_size=2, total_blocks=3)
    assert result.tolist() == [1, 0, 1]


def test_decode_packed_block_states_pads_remaining_with_zero():
    result = _decode_packed_block_states(bytes([0x00]), palette_size=2, total_blocks=5)
    assert result.tolist()[-1] == 0


def _write_fixture_schem(path, width=1, height=1, length=2, use_block_data=True):
    palette = tag.Compound({"minecraft:air": tag.Int(0), "minecraft:stone": tag.Int(1)})
    payload = {
        "Width": tag.Short(width),
        "Height": tag.Short(height),
        "Length": tag.Short(length),
        "Palette": palette,
    }
    if use_block_data:
        payload["BlockData"] = tag.ByteArray([0, 1])
    root = nbtlib.File(payload, gzipped=True)
    root.save(str(path))


def test_load_structure_missing_file_raises(tmp_path):
    with pytest.raises(FileNotFoundError):
        load_structure(str(tmp_path / "does_not_exist.schem"))


def test_load_structure_reads_dimensions_and_palette(tmp_path):
    schem_path = tmp_path / "fixture.schem"
    _write_fixture_schem(schem_path)

    structure = load_structure(str(schem_path))

    assert structure.bounds.size == (1, 1, 2)
    names = {entry.namespaced_name for entry in structure.palette}
    assert names == {"minecraft:air", "minecraft:stone"}
    assert structure.voxels.shape == (1, 1, 2)
    # index 0 -> air at (0,0,0), index 1 -> stone at (0,0,1) per the varint layout
    assert structure.voxels[0, 0, 0] == 0
    assert structure.voxels[0, 0, 1] == 1


def test_load_structure_raises_without_block_data_or_states(tmp_path):
    schem_path = tmp_path / "no_blocks.schem"
    _write_fixture_schem(schem_path, use_block_data=False)

    with pytest.raises(ValueError):
        load_structure(str(schem_path))
