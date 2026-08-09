import numpy as np

from app.pipeline.mesher import build_mesh, culled_faces
from app.pipeline.model_baker import ModelBaker
from app.pipeline.types import PaletteEntry, StructureBounds, StructureData


def _single_block_structure(name="minecraft:stone"):
    bounds = StructureBounds(0, 0, 0, 0, 0, 0)
    palette = [PaletteEntry("minecraft:air", {}), PaletteEntry(name, {})]
    voxels = np.array([[[1]]], dtype=np.int32)  # 1x1x1 grid, index 1 = stone
    return StructureData(bounds, palette, voxels)


def test_culled_faces_single_block_emits_six_faces():
    struct = _single_block_structure()
    baker = ModelBaker()

    faces = culled_faces(struct, baker)

    assert len(faces) == 6
    face_normals = {face.normal for face in faces}
    assert len(face_normals) == 6


def test_culled_faces_skips_air_voxels():
    bounds = StructureBounds(0, 0, 0, 0, 0, 0)
    palette = [PaletteEntry("minecraft:air", {})]
    voxels = np.array([[[0]]], dtype=np.int32)
    struct = StructureData(bounds, palette, voxels)
    baker = ModelBaker()

    assert culled_faces(struct, baker) == []


def test_culled_faces_culls_face_between_two_opaque_blocks():
    # Two adjacent stone blocks along x: shared internal face must not be emitted.
    bounds = StructureBounds(0, 0, 0, 1, 0, 0)
    palette = [PaletteEntry("minecraft:air", {}), PaletteEntry("minecraft:stone", {})]
    voxels = np.array([[[1]], [[1]]], dtype=np.int32)  # shape (2,1,1)
    struct = StructureData(bounds, palette, voxels)
    baker = ModelBaker()

    faces = culled_faces(struct, baker)

    # Each block would normally contribute 6 faces (12 total); the two touching
    # faces (east of block0, west of block1) are culled, leaving 10.
    assert len(faces) == 10


def test_build_mesh_empty_faces_returns_empty_buffers():
    result = build_mesh([], {})
    assert result.positions.shape == (0, 3)
    assert result.indices.shape == (0,)


def test_build_mesh_single_block_produces_indexed_buffers():
    struct = _single_block_structure()
    baker = ModelBaker()
    faces = culled_faces(struct, baker)
    atlas_uv = {face.texture_key: (0.0, 0.0, 1.0, 1.0) for face in faces}

    mesh = build_mesh(faces, atlas_uv)

    assert mesh.positions.shape == (24, 3)  # 6 faces * 4 verts
    assert mesh.indices.shape == (36,)  # 6 faces * 6 indices (2 triangles)
    assert mesh.normals.shape == (24, 3)
    assert mesh.uvs.shape == (24, 2)


def test_build_mesh_skips_faces_without_atlas_entry():
    struct = _single_block_structure()
    baker = ModelBaker()
    faces = culled_faces(struct, baker)

    mesh = build_mesh(faces, {})  # no atlas entries at all

    assert mesh.positions.shape == (0, 3)
