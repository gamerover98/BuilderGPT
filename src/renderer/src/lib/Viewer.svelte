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
  import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

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

      let frame = 0;
      const animate = () => {
        frame = requestAnimationFrame(animate);
        controls?.update();
        if (renderer && scene && camera) {
          renderer.render(scene, camera);
        }
      };
      animate();

      const observer = new ResizeObserver(resize);
      observer.observe(container);

      const onKey = (event: KeyboardEvent) => {
        if ((event.key === "r" || event.key === "R") && loaded) {
          fitCameraToObject(loaded);
        }
      };
      window.addEventListener("keydown", onKey);

      return () => {
        cancelAnimationFrame(frame);
        observer.disconnect();
        window.removeEventListener("keydown", onKey);
        if (loaded) disposeObject(loaded);
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
    <div class="overlay">Left: pan · Right: rotate · Wheel: zoom · R: reset</div>
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
