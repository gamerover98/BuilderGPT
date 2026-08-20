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
 * **Wrong on first open, right after scrolling:** the atlas was growing under
 * the icons. The baker decodes a texture the first time a block asks for it and
 * the atlas version *is* the texture count, so a batch of sixty came back as
 * sixty geometries each addressing a different layout, with one atlas to draw
 * them all. Fifty-nine were wrong, and scrolling looked like a cure only
 * because by then everything had been decoded and the count had stopped moving.
 *
 * Main settles the atlas per batch now, which fixes any one batch. The rest is
 * here: nothing is drawn until `warmBlockIcons` has meshed the whole block list
 * once, because an atlas that is still growing invalidates every icon already
 * drawn — visible as the grid blanking and refilling as it is scrolled. After
 * the warm-up main holds every block's geometry and a request is a cache hit.
 *
 * Requests are also serialised, one queue: overlapping ones each built their
 * result from the `painted` map as they found it and then replaced the whole
 * map, so a slower response erased a faster one's work.
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

/** How many icons are drawn before the frame is let through. */
const PAINT_SLICE = 12;

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

/**
 * The one-time warm-up, held as a promise so everyone joins the same one.
 *
 * `null` until something needs an icon: there is no reason to spend a few
 * seconds of the main process on someone who never opens the block list.
 */
let warmed: Promise<void> | null = null;

/**
 * Starts the warm-up, once, and repaints everything when it lands.
 *
 * Not awaited before the first paint, deliberately. Meshing nine hundred
 * blocks takes seconds, and holding every tile blank for them would trade one
 * visible fault for a worse one. So icons are drawn straight away against
 * whatever the atlas is, and when it settles the drawn ones are thrown away and
 * asked for again — main has them cached by then, so the second pass is a
 * round trip and a repaint rather than any real work.
 *
 * Flipping `ready` is what re-triggers the callers' effects: they read it, so
 * the request goes out again on its own rather than waiting for a scroll. That
 * scroll was the old workaround, and it was the report.
 */
function warm(): void {
  if (warmed !== null) return;
  warmed = (async () => {
    if (!bridgeAvailable) return;
    try {
      await api().warmBlockIcons();
    } catch {
      // Icons still work without it, they just churn as the atlas grows.
      // Not worth a banner: nothing the user asked for has failed.
    }
  })().then(() => {
    painted = new Map();
    requested = new Set();
    ready = true;
  });
}

/**
 * Whether the atlas has settled.
 *
 * Read it from an effect that requests icons: that is what makes the repaint
 * happen by itself when the warm-up lands.
 */
let ready = $state(false);

export function iconsReady(): boolean {
  return ready;
}

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

  warm();

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

    /*
     * Painted in slices, yielding between them.
     *
     * Each icon is a render and a `toDataURL`, and a hundred of them back to
     * back is a hundred milliseconds in which the window does not repaint --
     * felt as the scroll sticking. Yielding lets the frame through, and the map
     * is published each time so tiles appear as they are drawn rather than all
     * at the end.
     */
    let next = new Map(painted);
    for (let at = 0; at < response.icons.length; at += PAINT_SLICE) {
      for (const icon of response.icons.slice(at, at + PAINT_SLICE)) {
        const url = paint(icon);
        if (url !== null) next.set(icon.block, url);
      }
      painted = next;
      next = new Map(next);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}
