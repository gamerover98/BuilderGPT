import base64

import nbtlib
import pytest
from nbtlib import tag

from app.preview import PreviewOptions, PreviewPayload, build_preview


def _default_options(**overrides):
    defaults = dict(
        sun_azimuth=45.0,
        sun_elevation=60.0,
        max_dpr=2.0,
        render_scale=1.0,
        max_draw_distance=256.0,
        show_grid=True,
        wireframe=False,
        ambient_occlusion=True,
    )
    defaults.update(overrides)
    return PreviewOptions(**defaults)


def test_preview_options_to_serializable_roundtrips_all_fields():
    options = _default_options()
    data = options.to_serializable()
    assert data["sun_azimuth"] == 45.0
    assert data["show_grid"] is True
    assert set(data.keys()) == {
        "sun_azimuth", "sun_elevation", "max_dpr", "render_scale",
        "max_draw_distance", "show_grid", "wireframe", "ambient_occlusion",
    }


def test_preview_payload_to_viewer_params_embeds_data_uri():
    payload = PreviewPayload(base64_glb="AAAA", center=(1.0, 2.0, 3.0), size=(4.0, 5.0, 6.0))
    params = payload.to_viewer_params(_default_options())

    assert params["base64_glb"] == "data:model/gltf-binary;base64,AAAA"
    assert params["bounds"]["center"] == (1.0, 2.0, 3.0)
    assert params["bounds"]["size"] == (4.0, 5.0, 6.0)
    assert params["sunAz"] == 45.0
    assert params["showGrid"] is True


def _write_fixture_schem(path):
    payload = {
        "Width": tag.Short(1),
        "Height": tag.Short(1),
        "Length": tag.Short(1),
        "Palette": tag.Compound({"minecraft:stone": tag.Int(0)}),
        "BlockData": tag.ByteArray([0]),
    }
    nbtlib.File(payload, gzipped=True).save(str(path))


def test_build_preview_end_to_end_produces_valid_glb(tmp_path):
    schem_path = tmp_path / "fixture.schem"
    _write_fixture_schem(schem_path)
    schem_bytes = schem_path.read_bytes()

    result = build_preview(schem_bytes, resource_pack_bytes=None, options=_default_options())

    assert isinstance(result, PreviewPayload)
    glb_bytes = base64.b64decode(result.base64_glb)
    assert glb_bytes[:4] == b"glTF"
    assert result.size != (0, 0, 0)  # a single opaque block produces visible geometry


def test_build_preview_rejects_oversized_schem():
    oversized = b"0" * (50 * 1024 * 1024 + 1)
    with pytest.raises(ValueError):
        build_preview(oversized, resource_pack_bytes=None, options=_default_options())
