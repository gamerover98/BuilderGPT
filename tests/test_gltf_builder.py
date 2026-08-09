import struct as struct_module

import numpy as np
from PIL import Image

from app.pipeline.gltf_builder import GLTF_HEADER_MAGIC, GLTF_VERSION, mesh_to_glb
from app.pipeline.types import AtlasResult, MeshBuffers


def _empty_mesh():
    return MeshBuffers(
        positions=np.zeros((0, 3), dtype=np.float32),
        normals=np.zeros((0, 3), dtype=np.float32),
        uvs=np.zeros((0, 2), dtype=np.float32),
        indices=np.zeros((0,), dtype=np.uint32),
    )


def _triangle_mesh():
    return MeshBuffers(
        positions=np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0]], dtype=np.float32),
        normals=np.array([[0, 0, 1]] * 3, dtype=np.float32),
        uvs=np.array([[0, 0], [1, 0], [0, 1]], dtype=np.float32),
        indices=np.array([0, 1, 2], dtype=np.uint32),
    )


def _blank_atlas():
    image = Image.new("RGBA", (4, 4), (255, 0, 0, 255))
    return AtlasResult(image=image, uv_rects={"default": (0.0, 0.0, 1.0, 1.0)})


def test_mesh_to_glb_empty_mesh_produces_valid_header():
    result = mesh_to_glb(_empty_mesh(), _blank_atlas())

    magic, version, length = struct_module.unpack("<III", result.glb_bytes[:12])
    assert magic == GLTF_HEADER_MAGIC
    assert version == GLTF_VERSION
    assert length == len(result.glb_bytes)
    assert result.center == (0, 0, 0)
    assert result.size == (0, 0, 0)


def test_mesh_to_glb_nonempty_mesh_computes_center_and_size():
    result = mesh_to_glb(_triangle_mesh(), _blank_atlas())

    assert result.center == (0.5, 0.5, 0.0)
    assert result.size == (1.0, 1.0, 0.0)

    magic, version, length = struct_module.unpack("<III", result.glb_bytes[:12])
    assert magic == GLTF_HEADER_MAGIC
    assert version == GLTF_VERSION
    assert length == len(result.glb_bytes)


def test_mesh_to_glb_output_is_word_aligned():
    result = mesh_to_glb(_triangle_mesh(), _blank_atlas())
    # Every chunk length declared in the GLB header must be a multiple of 4.
    json_chunk_len = struct_module.unpack("<I", result.glb_bytes[12:16])[0]
    assert json_chunk_len % 4 == 0
