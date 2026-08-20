/**
 * Blocks drawn as blocks, once, for whoever needs the picture.
 *
 * The hotbar and the inventory both show blocks, and they used to show them
 * differently: the inventory rendered geometry from main, the hotbar drew a
 * hashed colour swatch. Two answers to "what does gravel look like", and only
 * one of them was the truth.
 *
 * ## One renderer for the whole window
 *
 * A `WebGLRenderer` per tile exhausts the browser's context limit at around
 * sixteen and then silently loses the oldest, so there is exactly one, drawn
 * off-screen, and each block is rendered into it once and kept as a `data:`
 * URL — which the CSP permits (`img-src 'self' data:`) and `blob:` it does not.
 * `preserveDrawingBuffer` is on for that read: without it the buffer may be
 * cleared before `toDataURL` sees it, and icons come out transparent on some
 * drivers and not others.
 *
 * It is a module rather than a component because two components need it at once
 * and the context limit is per window, not per component.
 *
 * ## Why they came out dull, and why they came out wrong
 *
 * Two separate faults, both fixed here and both worth naming.
 *
 * **Dull:** the atlas texture was uploaded without `SRGBColorSpace`, which the
 * viewport sets. The same pixels therefore drew darker and flatter in the
 * inventory than in the scene they were previews of.
 *
 * **Wrong on first open, right after scrolling:** requests overlapped. Each one
 * built its result from the `painted` map as it found it and then replaced the
 * whole map, so a slower response overwrote a faster one's work; scrolling away
 * and back re-requested and usually won the race. Requests are serialised now,
 * one queue, and the texture is uploaded with `initTexture` before the first
 * render rather than lazily on it.
 *
 * ## Shading, because an unlit cube is a coloured square
 *
 * Lambert lighting left every face of a stairs block reading as one flat shape.
 * The game does not light its inventory either — it shades each face by which
 * way it points, and that is what makes a cube look like a cube. The factors
 * below are the vanilla ones, baked into a vertex-colour attribute and
 * multiplied into an unlit material, so the texture's own colours survive
 * exactly.
 */

import * as THREE from "three";

import type { BlockIcon, MeshAtlas } from "../../../shared/ipc.js";
import { api, bridgeAvailable } from "./bridge.svelte.js";

/** The rendered size. Tiles are drawn smaller; the extra is for crispness. */
const ICON_SIZE = 72;

/**
 * Vanilla's face shading, by the sign and axis of the normal.
 *
 * Top full, bottom darkest, and the two horizontal axes different from each
 * other — which is the part that matters: with east/west and north/south equal,
 * a cube seen from the classic angle shows two identically lit faces and reads
 * as flat.
 */
const FACE_SHADE = { top: 1, bottom: 0.5, northSouth: 0.8, eastWest: 0.6 } as const;

function shadeFor(nx: number, ny: number, nz: number): number {
  if (Math.abs(ny) >= Math.abs(nx) && Math.abs(ny) >= Math.abs(nz)) {
    return ny >= 0 ? FACE_SHADE.top : FACE_SHADE.bottom;
  }
  return Math.abs(nx) >= Math.abs(nz) ? FACE_SHADE.eastWest : FACE_SHADE.northSouth;
}

/**
 * Rendered icons, by block id.
 *
 * Reassigned rather than mutated on every change: `$state` on a `Map` tracks
 * the reference, so writing into the old one draws nothing until something
 * else happens to change.
 */
let painted = $state<Map<string, string>>(new Map());

/** Blocks already asked for, so a scroll does not ask twice. */
let requested = new Set<string>();

let gl: THREE.WebGLRenderer | undefined;
let scene: THREE.Scene | undefined;
let camera: THREE.OrthographicCamera | undefined;
let atlasTexture: THREE.DataTexture | undefined;
let atlasVersion: number | null = null;

/**
 * The tail of the request chain.
 *
 * One at a time, and this is not caution: two overlapping requests each built
 * their result from `painted` as they found it and then replaced it wholesale,
 * so the slower one erased the faster one's icons. That is the "half the blocks
 * are wrong until you scroll" report, exactly.
 */
let queue: Promise<void> = Promise.resolve();

export function blockIconUrl(block: string): string | undefined {
  return painted.get(block);
}

/** Every icon built so far. Read this to make a component depend on the map. */
export function blockIcons(): ReadonlyMap<string, string> {
  return painted;
}

function ensureRenderer(): void {
  if (gl) return;
  gl = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
  gl.setSize(ICON_SIZE, ICON_SIZE, false);
  gl.setClearColor(0x000000, 0);

  scene = new THREE.Scene();
  /*
   * The classic inventory angle, and orthographic because it is the one that
   * makes a cube read as a cube. A perspective camera this close to a
   * one-block subject gives it visible vanishing lines, which look like a
   * modelling error rather than like an icon.
   */
  camera = new THREE.OrthographicCamera(-0.95, 0.95, 0.95, -0.95, 0.01, 10);
  camera.position.set(1.4, 1.15, 1.4);
  camera.lookAt(0, 0, 0);
  // No lights: the material is unlit and the shading is in the geometry.
}

function adoptAtlas(atlas: MeshAtlas | null, nextVersion: number): void {
  if (atlas === null || atlasVersion === nextVersion) return;
  atlasTexture?.dispose();
  atlasTexture = new THREE.DataTexture(
    new Uint8Array(atlas.pixels),
    atlas.width,
    atlas.height,
    THREE.RGBAFormat,
  );
  // Nearest, always: Minecraft textures are 16px and any filtering turns a
  // block face into mush at this size.
  atlasTexture.magFilter = THREE.NearestFilter;
  atlasTexture.minFilter = THREE.NearestFilter;
  /*
   * The same colour space the viewport uses. Without it the identical pixels
   * drew darker and flatter here than in the scene these are previews of —
   * which is what "the items look switched off" was.
   */
  atlasTexture.colorSpace = THREE.SRGBColorSpace;
  atlasTexture.needsUpdate = true;
  // Uploaded now rather than on the first draw that happens to need it. Lazily,
  // the first few icons of a batch rendered before the upload completed.
  gl?.initTexture(atlasTexture);

  atlasVersion = nextVersion;
  // Anything drawn against the old atlas is now wrong.
  painted = new Map();
  requested = new Set();
}

/** Shade every vertex by the way its face points, as the game does. */
function shadeGeometry(geometry: THREE.BufferGeometry, normals: Float32Array): void {
  const colors = new Float32Array(normals.length);
  for (let i = 0; i < normals.length; i += 3) {
    const shade = shadeFor(normals[i], normals[i + 1], normals[i + 2]);
    colors[i] = shade;
    colors[i + 1] = shade;
    colors[i + 2] = shade;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}

/** Renders one block and returns its `data:` URL, or `null` if it drew nothing. */
function paint(icon: BlockIcon): string | null {
  if (!gl || !scene || !camera || icon.geometry === null || !atlasTexture) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(icon.geometry.positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(icon.geometry.normals, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(icon.geometry.uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(icon.geometry.indices, 1));
  shadeGeometry(geometry, icon.geometry.normals);
  // The block sits at 0..1; centring it is what puts it in the frame.
  geometry.translate(-0.5, -0.5, -0.5);

  const material = new THREE.MeshBasicMaterial({
    map: atlasTexture,
    vertexColors: true,
    transparent: true,
    alphaTest: 0.5,
    side: THREE.DoubleSide,
  });
  const object = new THREE.Mesh(geometry, material);
  scene.add(object);
  gl.render(scene, camera);
  const url = gl.domElement.toDataURL("image/png");

  // Disposed straight away: one geometry and one material per block held for
  // the life of the window is nine hundred of each on the GPU, and the picture
  // is all that was wanted.
  scene.remove(object);
  geometry.dispose();
  material.dispose();
  return url;
}

/**
 * Asks main for the icons these blocks need, and draws them.
 *
 * Only what has not been asked for, and one request at a time — see `queue`.
 */
export function requestBlockIcons(blocks: readonly string[]): void {
  const wanted = blocks.filter((block) => !requested.has(block));
  if (wanted.length === 0 || !bridgeAvailable) return;
  for (const block of wanted) requested.add(block);

  queue = queue.then(async () => {
    let response;
    try {
      response = await api().getBlockIcons({ blocks: wanted, atlasVersion });
    } catch {
      for (const block of wanted) requested.delete(block);
      return;
    }
    if (!response.ok) {
      // Let them be asked for again: a failure here is usually a document that
      // was not open yet, and the next scroll should retry rather than leave
      // permanently blank tiles.
      for (const block of wanted) requested.delete(block);
      return;
    }

    ensureRenderer();
    adoptAtlas(response.atlas, response.atlasVersion);
    const next = new Map(painted);
    for (const icon of response.icons) {
      const url = paint(icon);
      if (url !== null) next.set(icon.block, url);
    }
    painted = next;
  });
}
