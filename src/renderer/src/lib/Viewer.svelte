<script lang="ts">
  /**
   * Port of `app/viewer/index.html`'s module script.
   *
   * The base64-blob module loader that file opens with (createModuleUrl,
   * revokeModuleUrls, the `from 'three'` string rewriting) is gone entirely:
   * it existed only because Streamlit's `components.v1.html` dropped the
   * viewer into a sandboxed iframe with no module resolution and no way to
   * serve `app/viewer/lib/*`. Here `three` is a normal dependency and a normal
   * import, so the vendored copies under `app/viewer/lib/` are dropped too
   * (ARCHITECTURE.md §3 "Renderer Three.js").
   *
   * Everything below the imports is the original's behavior: same camera
   * (60° FOV, near 0.1), same OrbitControls damping and mouse mapping
   * (left=pan, middle=dolly, right=rotate), same hemisphere+directional
   * lighting with the AO-dependent intensities, same 256/32 grid at y=-0.01
   * with depthWrite off, same 1.6·maxDim framing, same R-to-reset.
   */
  import { onMount, untrack } from "svelte";
  import type { MeshAtlas, MeshPayload } from "../../../shared/ipc.js";
  import type { ResolvedTheme } from "../../../shared/settings.js";
  import { t } from "./i18n.svelte.js";
  import { dragFace, plateScale, type Axis, type Side } from "./selection_drag.js";
  import * as THREE from "three";
  import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
  import { PointerLockControls } from "three/examples/jsm/controls/PointerLockControls.js";

  /**
   * How the camera is driven.
   *
   * Kept as a named union with one controller object per mode rather than a
   * branch inside the render loop, because the plan calls for more of them
   * later (a top-down mode, a walk mode) and the loop is the one place that
   * must not accumulate special cases.
   */
  export type CameraMode = "orbit" | "fly";

  /** A block coordinate in the schematic's own grid. */
  export interface PickedBlock {
    x: number;
    y: number;
    z: number;
    /** True when the click carried Shift — the gesture that extends a selection. */
    extend: boolean;
    /**
     * The empty cell on the outside of the face that was hit — where a new
     * block goes. `null` when that cell falls outside the schematic, which is
     * the only honest answer: the grid does not grow by being built against.
     */
    place: { x: number; y: number; z: number } | null;
  }

  /** Placing or removing one block, from the crosshair in flight. */
  export type BuildAction = "place" | "break";

  /** One of the six faces of the selection box, as a drag handle. */
  interface FaceHandle {
    axis: Axis;
    side: Side;
  }

  /**
   * The six, in a fixed order.
   *
   * Built once at module scope so each plate's `userData.face` is a stable
   * object: hover comparisons then have an identity to fall back on, and the
   * table cannot drift out of step with the meshes built from it.
   */
  const FACES: readonly FaceHandle[] = [
    { axis: "x", side: "min" },
    { axis: "x", side: "max" },
    { axis: "y", side: "min" },
    { axis: "y", side: "max" },
    { axis: "z", side: "min" },
    { axis: "z", side: "max" },
  ];

  /** The cursor a face suggests: faces move along their own axis. */
  function cursorFor(face: FaceHandle | null): string {
    if (face === null) return "";
    return face.axis === "y" ? "ns-resize" : "ew-resize";
  }

  interface Region {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
  }

  interface Props {
    /** Geometry and pixels. `null` until the first mesh arrives. */
    mesh: MeshPayload | null;
    sunAzimuth: number;
    sunElevation: number;
    maxDpr: number;
    renderScale: number;
    maxDrawDistance: number;
    showGrid: boolean;
    wireframe: boolean;
    ambientOcclusion: boolean;
    /** Drawn as a wire box; `null` hides it. */
    selection?: Region | null;
    /**
     * A click in orbit mode. `null` means the ray hit nothing — clicking empty
     * space, which clears the selection rather than doing nothing.
     */
    onpick?: (block: PickedBlock | null) => void;
    cameraMode?: CameraMode;
    /** Blocks per second in fly mode. */
    flySpeed?: number;
    /**
     * Identifies *which* structure is being shown, as opposed to which version
     * of it.
     *
     * Every edit produces new geometry, and framing the camera on each one threw
     * the user back to the establishing shot after every block they placed.
     * The camera is now re-framed only when this changes — a different file, a
     * different generation — so editing leaves the view exactly where they put
     * it.
     */
    framingKey?: string | number;
    /** Building from the crosshair, in flight. */
    onbuild?: (action: BuildAction, at: { x: number; y: number; z: number }) => void;
    /** A face was dragged; the region is already snapped and clamped. */
    onselectionchange?: (region: Region) => void;
    /**
     * The palette in force, already resolved against the OS preference.
     *
     * The viewer never reads this value -- the colours come from the same CSS
     * custom properties the rest of the window uses. The prop exists so an
     * effect has something to depend on: a `THREE.Color` cannot inherit, so the
     * scene has to be told when to go and look again.
     */
    theme?: ResolvedTheme;
  }

  const {
    mesh,
    sunAzimuth,
    sunElevation,
    maxDpr,
    renderScale,
    maxDrawDistance,
    showGrid,
    wireframe,
    ambientOcclusion,
    selection = null,
    onpick,
    cameraMode = "orbit",
    flySpeed = 12,
    onbuild,
    framingKey = 0,
    theme = "dark",
    onselectionchange,
  }: Props = $props();

  /**
   * The `framingKey` the camera was last framed for.
   *
   * `null` until the first structure arrives, so the very first one is framed.
   * Not `$state`: nothing renders from it, and making it reactive would put it
   * in the dependency graph of the effect that writes it.
   */
  let framedFor: string | number | null = null;

  /**
   * The atlas texture and the material sharing it, kept across rebuilds.
   *
   * An edit produces new geometry but the same atlas, and re-uploading a
   * megabyte of pixels per placed block would be the most expensive thing in
   * the loop. `textureVersion` is what main last said the atlas was.
   */
  let texture: THREE.DataTexture | undefined;
  let textureVersion = -1;
  let material: THREE.MeshStandardMaterial | undefined;

  /** The block outline under the crosshair; see `updateCrosshairHighlight`. */
  let highlight: THREE.LineSegments | undefined;
  let lastHighlightAt = 0;
  const HIGHLIGHT_INTERVAL_MS = 50;

  /**
   * Is this event coming out of somewhere the user is entering text?
   *
   * Single-key shortcuts here listen on `window`, which sees every keypress in
   * the app including the ones meant for a text field. Without this the
   * viewport's shortcuts fire while the user types in the sidebar.
   */
  function isTyping(target: EventTarget | null): boolean {
    const element = target as HTMLElement | null;
    if (!element || typeof element.tagName !== "string") {
      return false;
    }
    const tag = element.tagName.toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || element.isContentEditable;
  }

  /**
   * A palette token as a three.js colour.
   *
   * The scene's background, its grid and the selection box are `THREE.Color`s
   * rather than CSS, so they inherit nothing and a theme change leaves them
   * where they were -- a light window with a black viewport. Reading the same
   * custom properties the DOM uses keeps one source of truth; copying the hex
   * values in here would give two, and they would drift.
   *
   * The fallback is the pre-theme value, so a token that fails to resolve
   * renders as the app always did rather than as black.
   */
  function themeColor(token: string, fallback: number): THREE.Color {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
    return raw === "" ? new THREE.Color(fallback) : new THREE.Color(raw);
  }

  /**
   * (Re)builds the ground grid in the current theme's colours.
   *
   * `GridHelper` bakes its two colours into a vertex-colour attribute when it
   * is constructed, so recolouring is not a property assignment -- the helper
   * has to be replaced. It is 32 divisions of flat lines; this is cheap enough
   * to do on a theme change.
   */
  function buildGrid(): void {
    if (!scene) return;
    if (grid) {
      scene.remove(grid);
      grid.geometry.dispose();
      for (const material of Array.isArray(grid.material) ? grid.material : [grid.material]) {
        material.dispose();
      }
    }
    grid = new THREE.GridHelper(
      256,
      32,
      themeColor("--grid-major", 0x516079),
      themeColor("--grid-minor", 0x202937),
    );
    grid.position.y = -0.01;
    for (const material of Array.isArray(grid.material) ? grid.material : [grid.material]) {
      material.depthWrite = false;
      material.transparent = true;
      material.opacity = 0.5;
    }
    grid.renderOrder = -1;
    // The freshly built helper needs the current visibility, but reading it
    // tracked would make the theme effect below depend on `showGrid` too, and
    // rebuild the grid every time the checkbox is toggled.
    grid.visible = untrack(() => showGrid);
    scene.add(grid);
  }

  let canvas: HTMLCanvasElement;
  let container: HTMLDivElement;
  let error = $state<string | null>(null);

  /**
   * `scene` is reactive while its siblings are not, because the mesh effect
   * below reads it. As a plain `let` that effect captured `undefined` if it
   * ever ran before `onMount` and, having no reactive dependency to re-trigger
   * on, would drop that mesh permanently. It works today only because `onMount`
   * happens to run first; this makes it true by construction instead.
   */
  let renderer: THREE.WebGLRenderer | undefined;
  let scene = $state<THREE.Scene | undefined>(undefined);
  let camera: THREE.PerspectiveCamera | undefined;
  let controls: OrbitControls | undefined;
  let sun: THREE.DirectionalLight | undefined;
  let ambient: THREE.HemisphereLight | undefined;
  let grid: THREE.GridHelper | undefined;
  let loaded: THREE.Object3D | null = null;
  let selectionBox: THREE.LineSegments | undefined;

  /**
   * The six draggable faces of the selection box.
   *
   * Kept and re-shaped rather than rebuilt, unlike the wire box beside them.
   * They are re-shaped on every frame of a drag, and allocating six geometries
   * and six materials per frame to throw them away again is the kind of litter
   * that shows up as stutter on a large schematic. The pattern is
   * `ensureHighlight`'s, for the same reason.
   */
  let handles: THREE.Group | undefined;
  /** Which face the pointer is over, or being dragged. */
  let hovered: FaceHandle | null = $state(null);
  let dragged: FaceHandle | null = null;
  /** Suppresses the click-to-select path after a handle gesture. */
  let draggedThisGesture = false;
  /** Latest pointer position, read by the hover raycast in the render loop. */
  let pointerAt: { x: number; y: number } | null = null;
  let lastHoverAt = 0;
  let fly: PointerLockControls | undefined;
  /** True while the pointer is captured; drives the "click to fly" overlay. */
  let flying = $state(false);

  const raycaster = new THREE.Raycaster();

  /**
   * Keys held down, by `event.code` — physical position, not the character
   * produced. `code` because a French AZERTY keyboard puts Z where W is: `key`
   * would give the letter and strand half the world's keyboards.
   */
  const held = new Set<string>();

  /**
   * Moves the camera for one frame of flight.
   *
   * Speed is per *second* and scaled by the frame time, so a slow machine
   * travels the same distance as a fast one rather than crawling. Ctrl doubles
   * it, matching the sprint every game binds there.
   */
  function updateFlight(delta: number): void {
    if (!fly || !camera || !fly.isLocked) return;
    const speed = flySpeed * (held.has("ControlLeft") || held.has("ControlRight") ? 2 : 1) * delta;

    let forward = 0;
    let strafe = 0;
    let lift = 0;
    if (held.has("KeyW")) forward += 1;
    if (held.has("KeyS")) forward -= 1;
    if (held.has("KeyD")) strafe += 1;
    if (held.has("KeyA")) strafe -= 1;
    if (held.has("Space")) lift += 1;
    if (held.has("ShiftLeft") || held.has("ShiftRight")) lift -= 1;

    // Diagonals are normalised, or moving forward-and-right would be 1.41x as
    // fast as either alone.
    const planar = Math.hypot(forward, strafe);
    if (planar > 0) {
      fly.moveForward((forward / planar) * speed);
      fly.moveRight((strafe / planar) * speed);
    }
    if (lift !== 0) {
      // Straight up in world space, not along the camera's up: looking at the
      // floor and pressing Space should still rise, as it does in the game.
      camera.position.y += lift * speed;
    }
  }

  /**
   * Which block a ray hit.
   *
   * The mesh is one fused geometry with no per-block identity in it, so the
   * answer has to come from the hit itself: step a hair *inwards* from the
   * surface along the face normal, and the integer cell that lands in is the
   * block that owns the face.
   *
   * The step is deliberately tiny. Half a block would be the obvious choice and
   * is wrong: a pressure plate is one sixteenth tall, so stepping 0.5 in from
   * its top face lands in the block below it. A hair is enough, because the only
   * ambiguity being resolved is which side of an exact integer boundary the
   * face belongs to — the +X face of block 2 and the -X face of block 3 are the
   * same plane at x=3.
   *
   * The alternative was baking a block index into every vertex and carrying it
   * through the GLB. This needs no pipeline change at all, and is exact for
   * every shape the mesher emits, including the diagonal quads of a cross.
   */
  function pickBlockAt(clientX: number, clientY: number): PickedBlock | null {
    if (!camera || !loaded || !container) return null;
    const rect = container.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObject(loaded, true)[0];
    if (!hit || !hit.face) return null;

    // Object space is world space here — the pipeline emits no node transform —
    // but going through the normal matrix costs nothing and survives that
    // changing.
    const normal = hit.face.normal
      .clone()
      .applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld))
      .normalize();
    const inside = hit.point.clone().addScaledVector(normal, -1e-3);
    const x = Math.floor(inside.x);
    const y = Math.floor(inside.y);
    const z = Math.floor(inside.z);

    /*
     * Where a new block goes: one *cell* along the face normal, not one hair
     * past the surface that was hit.
     *
     * Stepping past the surface is what the pick does, and it is wrong here.
     * A bottom slab's top face is at y+0.5, so a hair above it is still inside
     * the same cell, and placing on top of a slab would try to write into the
     * block that is already there. Placement is cell-based: the target is the
     * cell adjacent across the *cell* boundary, whatever the geometry inside
     * it looks like.
     *
     * The dominant axis rather than rounding each component, so a cross quad's
     * diagonal normal yields a real neighbour instead of a diagonal one that
     * shares no face.
     */
    const ax = Math.abs(normal.x);
    const ay = Math.abs(normal.y);
    const az = Math.abs(normal.z);
    let place: { x: number; y: number; z: number } | null = null;
    if (ax >= ay && ax >= az && ax > 0) {
      place = { x: x + Math.sign(normal.x), y, z };
    } else if (ay >= az && ay > 0) {
      place = { x, y: y + Math.sign(normal.y), z };
    } else if (az > 0) {
      place = { x, y, z: z + Math.sign(normal.z) };
    }

    return { x, y, z, extend: false, place };
  }

  /**
   * The outline around the block the crosshair is on, as the game draws it.
   *
   * One unit cube, moved rather than rebuilt — this runs on a timer while
   * flying, and allocating an EdgesGeometry per update would litter the heap
   * for no reason.
   *
   * It is a *cell* outline, not the block's own silhouette: the mesh is fused
   * and carries no per-block shape, so the renderer cannot know that a slab is
   * half-height. Vanilla traces the collision box; this traces the cell the
   * block occupies, which is the same thing for the great majority of blocks
   * and an honest approximation for the rest.
   */
  function ensureHighlight(): THREE.LineSegments | undefined {
    if (!scene) return undefined;
    if (!highlight) {
      // 1.002 for the same reason the game expands its own outline: a box
      // exactly coincident with the block's faces z-fights with them.
      const geometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002));
      const material = new THREE.LineBasicMaterial({
        color: 0x000000,
        transparent: true,
        opacity: 0.55,
      });
      highlight = new THREE.LineSegments(geometry, material);
      highlight.visible = false;
      scene.add(highlight);
    }
    return highlight;
  }

  /**
   * Points the outline at whatever the crosshair is on.
   *
   * Throttled: raycasting a fused mesh of a large schematic is a linear scan
   * over its triangles, and the camera moves every frame in flight, so doing
   * this per frame would spend the frame budget on it. Twenty times a second
   * is under the threshold where the outline feels like it lags the view.
   */
  function updateCrosshairHighlight(now: number): void {
    const box = ensureHighlight();
    if (!box) return;
    if (cameraMode !== "fly" || !flying || !loaded) {
      box.visible = false;
      return;
    }
    if (now - lastHighlightAt < HIGHLIGHT_INTERVAL_MS) {
      return;
    }
    lastHighlightAt = now;

    const target = pickAtCrosshair();
    if (target === null) {
      box.visible = false;
      return;
    }
    // A cell spans [x, x+1], so its centre is half a block along each axis.
    box.position.set(target.x + 0.5, target.y + 0.5, target.z + 0.5);
    box.visible = true;
  }

  /** The block under the crosshair, which in flight is the screen's centre. */
  function pickAtCrosshair(): PickedBlock | null {
    if (!container) return null;
    const rect = container.getBoundingClientRect();
    return pickBlockAt(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  /**
   * Builds the six face plates once.
   *
   * Each is a unit plane oriented along its axis; `updateSelectionBox` scales
   * and positions them to the current box. They are invisible until hovered --
   * a permanently shaded box hides the structure it is selecting -- but they
   * are always present, because an invisible mesh still raycasts and that is
   * what makes the face findable in the first place.
   */
  function ensureHandles(): THREE.Group | undefined {
    if (!scene) return undefined;
    if (handles) return handles;

    handles = new THREE.Group();
    handles.renderOrder = 998;
    for (const face of FACES) {
      const material = new THREE.MeshBasicMaterial({
        color: themeColor("--selection", 0x6ea8fe),
        transparent: true,
        opacity: 0,
        depthTest: false,
        side: THREE.DoubleSide,
      });
      const plate = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
      plate.userData.face = face;
      plate.renderOrder = 998;
      // PlaneGeometry faces +Z; turn it to face its own axis.
      if (face.axis === "x") plate.rotation.y = Math.PI / 2;
      else if (face.axis === "y") plate.rotation.x = Math.PI / 2;
      handles.add(plate);
    }
    scene.add(handles);
    return handles;
  }

  /** Positions and scales the six plates onto the current selection. */
  function updateHandles(): void {
    const group = ensureHandles();
    if (!group) return;
    group.visible = selection !== null && onselectionchange !== undefined;
    if (!group.visible || !selection) return;

    const min = [selection.minX, selection.minY, selection.minZ];
    const max = [selection.maxX + 1, selection.maxY + 1, selection.maxZ + 1];
    const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    const mid = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];

    for (const plate of group.children as THREE.Mesh[]) {
      const face = plate.userData.face as FaceHandle;
      const index = face.axis === "x" ? 0 : face.axis === "y" ? 1 : 2;
      const position = [mid[0], mid[1], mid[2]];
      position[index] = face.side === "min" ? min[index] : max[index];
      plate.position.set(position[0], position[1], position[2]);

      const { width, height } = plateScale(face.axis, { x: size[0], y: size[1], z: size[2] });
      plate.scale.set(width, height, 1);

      const material = plate.material as THREE.MeshBasicMaterial;
      const active = hovered !== null && hovered.axis === face.axis && hovered.side === face.side;
      material.opacity = active ? 0.28 : 0;
      material.color = themeColor("--selection", 0x6ea8fe);
    }
  }

  /** The face under the pointer, or null. Raycasts the plates only. */
  function faceAt(clientX: number, clientY: number): FaceHandle | null {
    if (!camera || !container || !handles || !handles.visible) return null;
    const rect = container.getBoundingClientRect();
    raycaster.setFromCamera(
      new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      ),
      camera,
    );
    const hit = raycaster.intersectObjects(handles.children, false)[0];
    return hit ? ((hit.object.userData.face as FaceHandle) ?? null) : null;
  }

  /**
   * Moves the dragged face to wherever the pointer now points.
   *
   * The arithmetic is in `selection_drag.ts`, over plain triples: it is the
   * part with edges worth testing, and a test runner has no camera.
   */
  function dragTo(clientX: number, clientY: number): void {
    if (!dragged || !camera || !container || !selection || !onselectionchange) return;
    const rect = container.getBoundingClientRect();
    raycaster.setFromCamera(
      new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      ),
      camera,
    );
    const forward = camera.getWorldDirection(new THREE.Vector3());
    const next = dragFace({
      region: selection,
      axis: dragged.axis,
      side: dragged.side,
      ray: {
        origin: {
          x: raycaster.ray.origin.x,
          y: raycaster.ray.origin.y,
          z: raycaster.ray.origin.z,
        },
        direction: {
          x: raycaster.ray.direction.x,
          y: raycaster.ray.direction.y,
          z: raycaster.ray.direction.z,
        },
      },
      view: { x: forward.x, y: forward.y, z: forward.z },
    });
    // Null means there was no usable answer -- an axis pointed at the camera,
    // or a ray that missed the plane. Leave the selection where it is rather
    // than move it somewhere the user did not indicate.
    if (next !== null) onselectionchange(next);
  }

  /** Refreshes the hovered face, throttled like the crosshair highlight. */
  function updateHover(now: number): void {
    if (dragged !== null) return;
    if (cameraMode !== "orbit" || pointerAt === null || !handles?.visible) {
      if (hovered !== null) hovered = null;
      return;
    }
    if (now - lastHoverAt < HIGHLIGHT_INTERVAL_MS) return;
    lastHoverAt = now;

    const face = faceAt(pointerAt.x, pointerAt.y);
    const same =
      face === hovered ||
      (face !== null && hovered !== null && face.axis === hovered.axis && face.side === hovered.side);
    if (!same) hovered = face;
  }

  function updateSelectionBox(): void {
    if (!scene) return;
    if (selectionBox) {
      scene.remove(selectionBox);
      selectionBox.geometry.dispose();
      (selectionBox.material as THREE.Material).dispose();
      selectionBox = undefined;
    }
    if (!selection) return;

    // maxX is inclusive and a block occupies a whole unit cell, so the far
    // corner is +1: selecting one block draws a 1x1x1 box, not a point.
    const box = new THREE.Box3(
      new THREE.Vector3(selection.minX, selection.minY, selection.minZ),
      new THREE.Vector3(selection.maxX + 1, selection.maxY + 1, selection.maxZ + 1),
    );
    const geometry = new THREE.EdgesGeometry(
      new THREE.BoxGeometry(
        box.max.x - box.min.x,
        box.max.y - box.min.y,
        box.max.z - box.min.z,
      ),
    );
    const material = new THREE.LineBasicMaterial({
      color: themeColor("--selection", 0x6ea8fe),
      depthTest: false,
    });
    selectionBox = new THREE.LineSegments(geometry, material);
    box.getCenter(selectionBox.position);
    selectionBox.renderOrder = 999;
    scene.add(selectionBox);
  }

  function setSunFromAngles(az: number, el: number): void {
    if (!sun) return;
    const radius = 2000;
    sun.position.set(
      radius * Math.cos(el) * Math.cos(az),
      radius * Math.sin(el),
      radius * Math.cos(el) * Math.sin(az),
    );
  }

  function applyWireframe(object: THREE.Object3D, on: boolean): void {
    object.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        (material as THREE.MeshStandardMaterial).wireframe = on;
      }
    });
  }

  function fitCameraToObject(object: THREE.Object3D): void {
    if (!camera || !controls) return;
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const distance = Math.max(size.x, size.y, size.z) * 1.6;
    camera.position.set(center.x + distance, center.y + distance * 0.7, center.z + distance);
    camera.lookAt(center);
    controls.target.copy(center);
    controls.update();
  }

  function resize(): void {
    if (!renderer || !camera || !container) return;
    const width = container.clientWidth || 1;
    const height = container.clientHeight || 1;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  }

  /**
   * Frees a model's GPU resources.
   *
   * `keepMaterials` because the chunks share one material and one atlas
   * texture that outlive any single model: disposing them on a swap would free
   * the texture the incoming geometry is about to be drawn with. Only teardown
   * wants them gone, and it says so.
   */
  function disposeObject(object: THREE.Object3D, options: { keepMaterials?: boolean } = {}): void {
    object.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry?.dispose();
      if (options.keepMaterials) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        const std = material as THREE.MeshStandardMaterial;
        std.map?.dispose();
        std.dispose();
      }
    });
  }

  onMount(() => {
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
      scene = new THREE.Scene();
      scene.background = themeColor("--viewport-bg", 0x0b0f14);

      camera = new THREE.PerspectiveCamera(60, 1, 0.1, maxDrawDistance || 2048);
      camera.position.set(32, 32, 32);

      controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.screenSpacePanning = true;
      controls.mouseButtons = {
        LEFT: THREE.MOUSE.PAN,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: THREE.MOUSE.ROTATE,
      };

      ambient = new THREE.HemisphereLight(0xffffff, 0x1a2230, 0.9);
      scene.add(ambient);
      sun = new THREE.DirectionalLight(0xffffff, 1.0);
      scene.add(sun);

      buildGrid();

      resize();

      fly = new PointerLockControls(camera, renderer.domElement);
      fly.addEventListener("lock", () => (flying = true));
      fly.addEventListener("unlock", () => {
        flying = false;
        // Keys held when the pointer released would otherwise stay held
        // forever: the keyup lands on whatever has focus next, not here.
        held.clear();
      });

      let frame = 0;
      const clock = new THREE.Clock();
      const animate = () => {
        frame = requestAnimationFrame(animate);
        const delta = clock.getDelta();
        if (cameraMode === "fly") {
          updateFlight(delta);
        } else {
          controls?.update();
        }
        updateCrosshairHighlight(performance.now());
        updateHover(performance.now());
        if (renderer && scene && camera) {
          renderer.render(scene, camera);
        }
      };
      animate();

      const onKeyDown = (event: KeyboardEvent) => {
        if (fly?.isLocked) {
          held.add(event.code);
        }
      };
      const onKeyUp = (event: KeyboardEvent) => held.delete(event.code);
      window.addEventListener("keydown", onKeyDown);
      window.addEventListener("keyup", onKeyUp);

      const observer = new ResizeObserver(resize);
      observer.observe(container);

      const onKey = (event: KeyboardEvent) => {
        // Not while the user is typing. This listens on `window`, so a keypress
        // in any field bubbles up to it: before this guard, typing "birch" into
        // the block picker — or any word with an r in it — threw the camera
        // back to the framing position mid-word.
        if (isTyping(event.target)) {
          return;
        }
        if ((event.key === "r" || event.key === "R") && loaded) {
          fitCameraToObject(loaded);
        }
      };
      window.addEventListener("keydown", onKey);

      // Left-drag orbits and pans, so a click cannot simply be pointerup: the
      // gesture is only a selection if the pointer barely moved. Four pixels is
      // the usual allowance for a shaky hand on a trackpad.
      let downAt: { x: number; y: number } | null = null;
      const onPointerDown = (event: PointerEvent) => {
        downAt = event.button === 0 ? { x: event.clientX, y: event.clientY } : null;

        /*
         * A press on a face handle takes over the gesture.
         *
         * Disabling OrbitControls is not optional here: the left button is
         * mapped to `THREE.MOUSE.PAN`, so without this the drag would pan the
         * camera and the face would never move. Pointer capture keeps the
         * gesture alive if the pointer leaves the canvas mid-drag.
         */
        if (event.button !== 0 || cameraMode !== "orbit") return;
        const face = faceAt(event.clientX, event.clientY);
        if (face === null) return;
        dragged = face;
        hovered = face;
        draggedThisGesture = true;
        if (controls) controls.enabled = false;
        try {
          renderer?.domElement.setPointerCapture(event.pointerId);
        } catch {
          // Best effort; the drag still tracks while the pointer is in bounds.
        }
        event.preventDefault();
      };

      const onPointerMove = (event: PointerEvent) => {
        pointerAt = { x: event.clientX, y: event.clientY };
        if (dragged !== null) dragTo(event.clientX, event.clientY);
      };

      const onPointerLeave = () => {
        pointerAt = null;
      };
      const onPointerUp = (event: PointerEvent) => {
        const start = downAt;
        downAt = null;

        if (dragged !== null) {
          dragged = null;
          if (controls) controls.enabled = true;
          try {
            renderer?.domElement.releasePointerCapture(event.pointerId);
          } catch {
            // Nothing captured; nothing to release.
          }
          return;
        }

        /*
         * A press that started on a handle but never moved still ends here.
         * Without this it would fall through to the block pick below and
         * collapse the selection the user was about to resize back to the one
         * block under the cursor -- the 4px tolerance does not help, because
         * the pointer genuinely did not move.
         */
        if (draggedThisGesture) {
          draggedThisGesture = false;
          return;
        }
        // In fly mode the first click captures the pointer — it is the only
        // thing a click can mean while the cursor is still visible. After
        // that, clicks build: left breaks, right places, from the crosshair.
        // Selection stays an orbit-mode gesture.
        if (cameraMode === "fly") {
          if (!fly?.isLocked) {
            fly?.lock();
            return;
          }
          if (!onbuild) return;
          const target = pickAtCrosshair();
          if (!target) return;
          if (event.button === 0) {
            onbuild("break", { x: target.x, y: target.y, z: target.z });
          } else if (event.button === 2 && target.place) {
            onbuild("place", target.place);
          }
          return;
        }
        if (!start || !onpick) return;
        if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;
        const picked = pickBlockAt(event.clientX, event.clientY);
        // A click that hit nothing is reported as such rather than swallowed:
        // clicking empty space is how you *stop* having a selection, and doing
        // nothing left no way to clear one but the button in the panel.
        onpick(picked === null ? null : { ...picked, extend: event.shiftKey });
      };
      // Right-click places a block in flight, so the context menu must not
      // also appear. Only suppressed while flying: in orbit mode right-drag
      // rotates and the menu never had a chance to open anyway, but leaving
      // the default alone there keeps the browser's own behaviour available.
      const onContextMenu = (event: MouseEvent) => {
        if (cameraMode === "fly") {
          event.preventDefault();
        }
      };
      renderer.domElement.addEventListener("pointerdown", onPointerDown);
      renderer.domElement.addEventListener("pointermove", onPointerMove);
      renderer.domElement.addEventListener("pointerleave", onPointerLeave);
      renderer.domElement.addEventListener("pointerup", onPointerUp);
      renderer.domElement.addEventListener("contextmenu", onContextMenu);

      return () => {
        cancelAnimationFrame(frame);
        observer.disconnect();
        window.removeEventListener("keydown", onKey);
        window.removeEventListener("keydown", onKeyDown);
        window.removeEventListener("keyup", onKeyUp);
        renderer?.domElement.removeEventListener("pointerdown", onPointerDown);
        renderer?.domElement.removeEventListener("pointermove", onPointerMove);
        renderer?.domElement.removeEventListener("pointerleave", onPointerLeave);
        renderer?.domElement.removeEventListener("pointerup", onPointerUp);
        renderer?.domElement.removeEventListener("contextmenu", onContextMenu);
        if (loaded) disposeObject(loaded);
        // Shared, so nothing above frees them.
        material?.dispose();
        texture?.dispose();
        if (highlight) {
          highlight.geometry.dispose();
          (highlight.material as THREE.Material).dispose();
        }
        if (handles) {
          for (const plate of handles.children as THREE.Mesh[]) {
            plate.geometry.dispose();
            (plate.material as THREE.Material).dispose();
          }
        }
        fly?.dispose();
        controls?.dispose();
        renderer?.dispose();
      };
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      return () => {};
    }
  });

  // --- reactive prop application -------------------------------------------

  $effect(() => {
    if (!renderer) return;
    // The original clamped `devicePixelRatio` by `maxDPR` only; `renderScale`
    // was passed into the payload but never consumed, so its slider did
    // nothing. Both now apply, which is what the label "Clamp renderer pixel
    // ratio for performance" (component.py:323) always claimed.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxDpr) * renderScale);
    resize();
  });

  $effect(() => {
    if (!camera) return;
    camera.far = maxDrawDistance || 2048;
    camera.updateProjectionMatrix();
  });

  $effect(() => {
    setSunFromAngles(sunAzimuth, sunElevation);
  });

  $effect(() => {
    if (ambient) ambient.intensity = ambientOcclusion ? 0.9 : 0.5;
    if (sun) sun.intensity = ambientOcclusion ? 1.0 : 0.7;
  });

  $effect(() => {
    if (grid) grid.visible = showGrid;
  });

  $effect(() => {
    // Reads `selection`, `scene` and `theme` so it reruns when any changes.
    // The box's material is built fresh each time, so a theme change is
    // simply a rebuild with a different colour.
    void selection;
    void scene;
    void theme;
    updateSelectionBox();
  });

  /**
   * Re-shapes the six drag handles onto the current box.
   *
   * Separate from the wire box above because it does not rebuild anything:
   * `hovered` changes twenty times a second while the pointer moves over the
   * selection, and rebuilding geometry at that rate is exactly the churn these
   * plates are kept around to avoid.
   */
  $effect(() => {
    void selection;
    void scene;
    void theme;
    void hovered;
    updateHandles();
  });

  /**
   * The cursor says which way a face will move before it is grabbed.
   *
   * Set on the container rather than the canvas so it survives the canvas
   * being replaced, and cleared to "" rather than "default" so the CSS `cursor`
   * on `.viewer` still applies when nothing is hovered.
   */
  $effect(() => {
    if (container) container.style.cursor = cursorFor(hovered);
  });

  /**
   * Repaints what CSS cannot reach.
   *
   * `theme` is read only to make this rerun; the values themselves come from
   * the custom properties, which `App.svelte` has already switched over by
   * writing `data-theme` in an `$effect.pre` -- and *that* is why it is `pre`:
   * pre-effects all flush before regular ones, so by the time this reads the
   * computed style the attribute is on `<html>`. As a plain effect it would be
   * a race, and the viewport would lag the window by one theme change.
   */
  $effect(() => {
    void theme;
    if (!scene) return;
    scene.background = themeColor("--viewport-bg", 0x0b0f14);
    buildGrid();
  });

  /**
   * Exactly one controller drives the camera at a time.
   *
   * OrbitControls is disabled rather than disposed in fly mode: it keeps its
   * target, so switching back resumes orbiting around the same point instead of
   * snapping to the origin.
   */
  $effect(() => {
    if (!controls) return;
    if (cameraMode === "fly") {
      controls.enabled = false;
    } else {
      controls.enabled = true;
      if (fly?.isLocked) {
        fly.unlock();
      }
      // Orbiting rotates about the target, so it has to be somewhere sensible
      // after a flight — otherwise the camera swings around wherever it was
      // pointing before takeoff.
      if (camera) {
        const ahead = new THREE.Vector3(0, 0, -1)
          .applyQuaternion(camera.quaternion)
          .multiplyScalar(24)
          .add(camera.position);
        controls.target.copy(ahead);
        controls.update();
      }
    }
  });

  $effect(() => {
    if (loaded) applyWireframe(loaded, wireframe);
  });

  /**
   * The material every chunk shares.
   *
   * One instance rather than one per chunk: they are identical, and three.js
   * compiles a shader program per material.
   *
   * `MASK`/0.5 and double-sided, matching what the glTF this replaced declared
   * — cross-quads (flowers, grass) are single planes that must be lit and drawn
   * from both faces, and cutout foliage needs a hard alpha test rather than
   * blending, or leaves sort against each other.
   */
  function ensureMaterial(texture: THREE.Texture): THREE.MeshStandardMaterial {
    if (!material) {
      material = new THREE.MeshStandardMaterial({
        map: texture,
        metalness: 0,
        roughness: 1,
        alphaTest: 0.5,
        side: THREE.DoubleSide,
      });
    } else if (material.map !== texture) {
      material.map = texture;
      material.needsUpdate = true;
    }
    return material;
  }

  /**
   * The atlas as a texture, rebuilt only when the atlas itself was.
   *
   * `DataTexture`, not an image: the pixels arrive as raw RGBA, so there is
   * nothing to decode. That is what removed `blob:` from the renderer's CSP —
   * and with it the failure this used to have to guard against, where a texture
   * that would not decode left the model drawing white while reporting success.
   * A decode that never happens cannot fail silently.
   */
  function ensureTexture(atlas: MeshAtlas): THREE.Texture {
    if (texture && textureVersion === atlas.version) {
      return texture;
    }
    texture?.dispose();
    // A fresh array rather than the one that arrived: structured clone can
    // hand back a view onto a larger buffer, and three.js uploads the whole
    // buffer it is given.
    const pixels = new Uint8Array(atlas.pixels);
    const next = new THREE.DataTexture(pixels, atlas.width, atlas.height, THREE.RGBAFormat);
    // NEAREST both ways, and no mipmaps: Minecraft textures are pixel art, and
    // mipmapping an atlas bleeds neighbouring tiles into each other.
    next.magFilter = THREE.NearestFilter;
    next.minFilter = THREE.NearestFilter;
    next.generateMipmaps = false;
    next.colorSpace = THREE.SRGBColorSpace;
    next.needsUpdate = true;
    texture = next;
    textureVersion = atlas.version;
    return next;
  }

  /** One mesh per chunk, under a group the rest of the viewer treats as before. */
  function buildModel(payload: MeshPayload, texture: THREE.Texture): THREE.Group {
    const group = new THREE.Group();
    const shared = ensureMaterial(texture);
    for (const chunk of payload.chunks) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(chunk.positions, 3));
      geometry.setAttribute("normal", new THREE.BufferAttribute(chunk.normals, 3));
      geometry.setAttribute("uv", new THREE.BufferAttribute(chunk.uvs, 2));
      geometry.setIndex(new THREE.BufferAttribute(chunk.indices, 1));
      // Per chunk, so three.js can frustum-cull them individually — the reason
      // for keeping the chunks apart rather than fusing them back together.
      geometry.computeBoundingSphere();
      geometry.computeBoundingBox();
      group.add(new THREE.Mesh(geometry, shared));
    }
    return group;
  }

  $effect(() => {
    const payload = mesh;
    if (!scene || !payload || payload.chunks.length === 0) return;
    const target = scene;
    /*
     * Read without subscribing. If this effect depended on `framingKey` it
     * would run again the moment a new document is opened — before that
     * document's mesh has arrived — rebuilding the *previous* geometry and
     * framing the camera on the structure being replaced.
     */
    const key = untrack(() => framingKey);

    /*
     * No token guard and no flash of an empty viewport, both of which the GLB
     * path needed: building buffer geometry is synchronous, so there is no
     * window in which a slow earlier parse can land after a fast later one, and
     * the swap happens inside a single frame.
     */
    const previous = loaded;
    try {
      if (payload.atlas === null && texture === undefined) {
        // Main only omits the atlas when the renderer is known to hold it.
        throw new Error(t("viewport.noAtlas"));
      }
      const built = buildModel(payload, payload.atlas ? ensureTexture(payload.atlas) : texture!);
      if (previous) {
        target.remove(previous);
        disposeObject(previous, { keepMaterials: true });
      }
      loaded = built;
      target.add(built);
      applyWireframe(built, wireframe);
      // Only for a structure the camera has not been framed on before.
      // Re-framing on every mesh meant every placed block, and every undo,
      // snapped the view back to the establishing shot.
      if (key !== framedFor) {
        fitCameraToObject(built);
        framedFor = key;
      }
      error = null;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  });

</script>

<div class="viewer" bind:this={container}>
  <canvas bind:this={canvas}></canvas>
  {#if error}
    <div class="error">
      {t("viewport.unavailable")}<br />
      <small>{error}</small>
    </div>
  {:else if mesh}
    <!--
      No placeholder for the empty state: an empty viewport is self-evidently
      empty, and a card in the middle of it was noise rather than information.
    -->
    <div class="overlay">
      {#if cameraMode === "fly"}
        {flying ? t("viewport.hudFlying") : t("viewport.hudClickToFly")}
      {:else}
        {t("viewport.hudOrbit")}
      {/if}
    </div>
    {#if cameraMode === "fly" && flying}
      <!-- A crosshair, because in flight there is no cursor to aim with. -->
      <div class="crosshair" aria-hidden="true"></div>
    {/if}
  {/if}
</div>

<style>
  .viewer {
    position: relative;
    width: 100%;
    height: 100%;
    min-height: 320px;
    background: var(--viewport-bg);
    overflow: hidden;
  }

  canvas {
    display: block;
    width: 100%;
    height: 100%;
  }

  .overlay {
    position: absolute;
    top: 16px;
    left: 16px;
    padding: 8px 12px;
    background: var(--overlay-bg);
    border-radius: 6px;
    backdrop-filter: blur(6px);
    font-size: 13px;
    line-height: 1.4;
    pointer-events: none;
  }

  .crosshair {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 14px;
    height: 14px;
    margin: -7px 0 0 -7px;
    pointer-events: none;
    /* Two hairlines rather than a glyph: a text crosshair sits on the baseline
       and is never quite centred on the point being aimed at. */
    background:
      linear-gradient(var(--text), var(--text)) center / 100% 1px no-repeat,
      linear-gradient(var(--text), var(--text)) center / 1px 100% no-repeat;
    opacity: 0.7;
    mix-blend-mode: difference;
  }

  .error {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    padding: 12px 16px;
    max-width: 720px;
    text-align: center;
    background: var(--overlay-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    pointer-events: none;
  }
</style>
