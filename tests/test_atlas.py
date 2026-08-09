import numpy as np
from PIL import Image

from app.pipeline.atlas import build_atlas


def test_build_atlas_empty_returns_blank_default():
    result = build_atlas({})
    assert result.image.size == (32, 32)
    assert result.uv_rects == {"default": (0.0, 0.0, 1.0, 1.0)}


def test_build_atlas_single_image_layout():
    tile = np.full((32, 32, 4), (255, 0, 0, 255), dtype=np.uint8)
    result = build_atlas({"minecraft:stone": tile}, tile_size=32, padding=6)

    assert result.image.size == (44, 44)  # 1 column * (32 + 6*2)
    assert set(result.uv_rects.keys()) == {"minecraft:stone"}
    u0, v0, u1, v1 = result.uv_rects["minecraft:stone"]
    assert 0.0 < u0 < u1 < 1.0
    assert 0.0 < v0 < v1 < 1.0


def test_build_atlas_multiple_images_grid_layout():
    keys = [f"minecraft:block_{i}" for i in range(5)]
    images = {k: np.full((32, 32, 4), (i * 10, i * 10, i * 10, 255), dtype=np.uint8) for i, k in enumerate(keys)}

    result = build_atlas(images, tile_size=32, padding=2)

    # ceil(sqrt(5)) = 3 columns, ceil(5/3) = 2 rows
    stride = 32 + 2 * 2
    assert result.image.size == (3 * stride, 2 * stride)
    assert set(result.uv_rects.keys()) == set(keys)
    for rect in result.uv_rects.values():
        u0, v0, u1, v1 = rect
        assert 0.0 <= u0 < u1 <= 1.0
        assert 0.0 <= v0 < v1 <= 1.0


def test_build_atlas_accepts_pil_image_directly():
    img = Image.new("RGBA", (32, 32), (0, 255, 0, 255))
    result = build_atlas({"minecraft:grass": img}, tile_size=32, padding=0)
    assert "minecraft:grass" in result.uv_rects


def test_build_atlas_zero_padding():
    tile = np.zeros((32, 32, 4), dtype=np.uint8)
    result = build_atlas({"k": tile}, tile_size=32, padding=0)
    assert result.image.size == (32, 32)
