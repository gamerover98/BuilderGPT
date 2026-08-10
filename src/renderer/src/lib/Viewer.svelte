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
  import { onMount } from "svelte";
  import * as THREE from "three";
  import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
  import { PointerLockControls } from "three/examples/jsm/controls/PointerLockControls.js";
  import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

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

  interface Region {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
  }

  interface Props {
    glb: Uint8Array | null;
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
    onpick?: (block: PickedBlock) => void;
    cameraMode?: CameraMode;
    /** Blocks per second in fly mode. */
    flySpeed?: number;
    /** Building from the crosshair, in flight. */
    onbuild?: (action: BuildAction, at: { x: number; y: number; z: number }) => void;
  }

  const {
    glb,
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
  }: Props = $props();

  let canvas: HTMLCanvasElement;
  let container: HTMLDivElement;
  let error = $state<string | null>(null);

  /**
   * `scene` is reactive while its siblings are not, because the GLB effect
   * below reads it. As a plain `let` that effect captured `undefined` if it
   * ever ran before `onMount` and, having no reactive dependency to re-trigger
   * on, would drop that GLB permanently. It works today only because `onMount`
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

  /** The block under the crosshair, which in flight is the screen's centre. */
  function pickAtCrosshair(): PickedBlock | null {
    if (!container) return null;
    const rect = container.getBoundingClientRect();
    return pickBlockAt(rect.left + rect.width / 2, rect.top + rect.height / 2);
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
    const material = new THREE.LineBasicMaterial({ color: 0x6ea8fe, depthTest: false });
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

  function disposeObject(object: THREE.Object3D): void {
    object.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry?.dispose();
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
      scene.background = new THREE.Color(0x0b0f14);

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

      grid = new THREE.GridHelper(256, 32, 0x516079, 0x202937);
      grid.position.y = -0.01;
      const gridMaterials = Array.isArray(grid.material) ? grid.material : [grid.material];
      for (const material of gridMaterials) {
        material.depthWrite = false;
        material.transparent = true;
        material.opacity = 0.5;
      }
      grid.renderOrder = -1;
      scene.add(grid);

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
      };
      const onPointerUp = (event: PointerEvent) => {
        const start = downAt;
        downAt = null;
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
        if (picked) {
          onpick({ ...picked, extend: event.shiftKey });
        }
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
      renderer.domElement.addEventListener("pointerup", onPointerUp);
      renderer.domElement.addEventListener("contextmenu", onContextMenu);

      return () => {
        cancelAnimationFrame(frame);
        observer.disconnect();
        window.removeEventListener("keydown", onKey);
        window.removeEventListener("keydown", onKeyDown);
        window.removeEventListener("keyup", onKeyUp);
        renderer?.domElement.removeEventListener("pointerdown", onPointerDown);
        renderer?.domElement.removeEventListener("pointerup", onPointerUp);
        renderer?.domElement.removeEventListener("contextmenu", onContextMenu);
        if (loaded) disposeObject(loaded);
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
    // Reads `selection` and `scene` so it reruns when either changes.
    void selection;
    void scene;
    updateSelectionBox();
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
   * Catches the one failure mode GLTFLoader refuses to report.
   *
   * `loadTextureImage` ends in `.catch(() => null)`: if the embedded PNG cannot
   * be decoded, the texture silently becomes null, `material.map` is never
   * assigned, and the model draws in default white with `onLoad` reporting
   * success. That is indistinguishable from a resource pack that resolved
   * nothing -- which is why it went unnoticed until someone asked why their
   * schematic was a white block. The pipeline always emits a baseColorTexture,
   * so a map-less standard material here means the decode failed.
   */
  function untexturedReason(root: THREE.Object3D): string | null {
    let meshes = 0;
    let mapless = 0;
    root.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        meshes += 1;
        if ((material as THREE.MeshStandardMaterial).map == null) mapless += 1;
      }
    });
    if (meshes === 0 || mapless < meshes) return null;
    return (
      "The model loaded but its textures did not decode, so it is drawn untextured. " +
      "This is usually the renderer's Content-Security-Policy blocking the blob: URL " +
      "three.js reads the embedded texture from — check connect-src in index.html."
    );
  }

  $effect(() => {
    const bytes = glb;
    if (!scene || !bytes || bytes.length === 0) return;
    const target = scene;

    if (loaded) {
      target.remove(loaded);
      disposeObject(loaded);
      loaded = null;
    }

    // `slice()` guarantees a standalone ArrayBuffer: the payload arrives from
    // structured clone as a Uint8Array that may be a view into a larger buffer,
    // and GLTFLoader.parse reads the whole buffer it is handed.
    const buffer = bytes.slice().buffer;
    const loader = new GLTFLoader();
    loader.parse(
      buffer,
      "",
      (gltf) => {
        loaded = gltf.scene;
        target.add(loaded);
        applyWireframe(loaded, wireframe);
        fitCameraToObject(loaded);
        error = untexturedReason(loaded);
      },
      (err) => {
        error = err instanceof Error ? err.message : String(err);
      },
    );
  });
</script>

<div class="viewer" bind:this={container}>
  <canvas bind:this={canvas}></canvas>
  {#if error}
    <div class="error">
      Preview unavailable.<br />
      <small>{error}</small>
    </div>
  {:else if glb}
    <!--
      No placeholder for the empty state: an empty viewport is self-evidently
      empty, and a card in the middle of it was noise rather than information.
    -->
    <div class="overlay">
      {#if cameraMode === "fly"}
        {#if flying}
          WASD: move · Space/Shift: up, down · Ctrl: faster · Left: break · Right: place · Esc:
          release
        {:else}
          Click the viewport to fly
        {/if}
      {:else}
        Left: pan · Right: rotate · Wheel: zoom · Click: select · R: reset
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
    background: #0b0f14;
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
    background: rgba(10, 14, 20, 0.65);
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
      linear-gradient(var(--text, #e6edf3), var(--text, #e6edf3)) center / 100% 1px no-repeat,
      linear-gradient(var(--text, #e6edf3), var(--text, #e6edf3)) center / 1px 100% no-repeat;
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
    background: rgba(10, 14, 20, 0.8);
    border: 1px solid var(--border);
    border-radius: 8px;
    pointer-events: none;
  }
</style>
