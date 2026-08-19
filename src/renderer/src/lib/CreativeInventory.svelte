<script lang="ts">
  /**
   * Every block the app can place, as they look, on `E`.
   *
   * ## One renderer, not nine hundred canvases
   *
   * A `WebGLRenderer` per tile exhausts the browser's context limit at around
   * sixteen and then starts silently losing the oldest. So there is one, drawn
   * off-screen, and each block is rendered into it once and kept as a `data:`
   * URL — which the CSP permits (`img-src 'self' data:`) and `blob:` it does
   * not, so this is the one encoding available here and it happens to be the
   * simplest.
   *
   * `preserveDrawingBuffer` is on for exactly this: without it the drawing
   * buffer may be cleared before `toDataURL` reads it, and the icons come out
   * transparent on some drivers and not others.
   *
   * ## The geometry comes from main
   *
   * `pipeline/block_shapes.ts` describes what a stairs block is, and it lives in
   * main. So a block's icon is a one-block document meshed by the same pipeline
   * the viewport uses (`services/block_icons.ts`) and handed over as geometry —
   * which means an icon cannot disagree with what appears when the block is
   * placed. A stand-in drawn here would drift the moment a shape was added, and
   * drift silently.
   *
   * ## Virtualised, and the arithmetic is not here
   *
   * `inventory.ts` decides which slice needs drawing, because a scroll offset is
   * not something this project's test harness can produce — the same split
   * `build_grid.ts` and `selection_drag.ts` use.
   */
  import * as THREE from "three";

  import type { BlockIcon, MeshAtlas } from "../../../shared/ipc.js";
  import { mcVersion } from "../../../shared/mc_versions.js";
  import { api, bridgeAvailable } from "./bridge.svelte.js";
  import { blockLabel, gridWindow, inventoryBlocks } from "./inventory.js";
  import { t } from "./i18n.svelte.js";

  interface Props {
    open: boolean;
    /** Every placeable block id, as main lists them. */
    blocks: readonly string[];
    /** Shown beside the search, so the target is never a mystery. */
    version: string;
    onclose: () => void;
    onpick: (block: string) => void;
  }

  const { open, blocks, version, onclose, onpick }: Props = $props();

  const TILE = 68;
  const COLUMNS = 8;

  let query = $state("");
  let scrollTop = $state(0);
  let viewportHeight = $state(420);
  let scroller = $state<HTMLDivElement | undefined>(undefined);
  let search = $state<HTMLInputElement | undefined>(undefined);

  /** Rendered icons per block, so a tile redraws without another round trip. */
  let painted = $state(new Map<string, string>());
  /** Which blocks have been asked for, so a scroll does not ask twice. */
  const requested = new Set<string>();
  let atlasVersion: number | null = null;
  let atlasTexture: THREE.DataTexture | undefined;

  const filtered = $derived(inventoryBlocks(blocks, query));
  const view = $derived(
    gridWindow({
      count: filtered.length,
      columns: COLUMNS,
      rowHeight: TILE,
      viewportHeight,
      scrollTop,
    }),
  );
  const visible = $derived(filtered.slice(view.firstIndex, view.lastIndex));

  /* --- the one renderer ---------------------------------------------------- */

  let gl: THREE.WebGLRenderer | undefined;
  let scene: THREE.Scene | undefined;
  let camera: THREE.OrthographicCamera | undefined;

  function ensureRenderer(): void {
    if (gl) return;
    gl = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
    gl.setSize(TILE, TILE, false);
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

    scene.add(new THREE.AmbientLight(0xffffff, 0.72));
    const key = new THREE.DirectionalLight(0xffffff, 0.85);
    key.position.set(1, 2, 1.5);
    scene.add(key);
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
    atlasTexture.needsUpdate = true;
    atlasVersion = nextVersion;
    // Anything drawn against the old atlas is now wrong.
    painted = new Map();
    requested.clear();
  }

  /** Renders one block and keeps the result as a `data:` URL. */
  function paint(icon: BlockIcon): string | null {
    if (!gl || !scene || !camera || icon.geometry === null || !atlasTexture) return null;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(icon.geometry.positions, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(icon.geometry.normals, 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(icon.geometry.uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(icon.geometry.indices, 1));
    // The block sits at 0..1; centring it is what puts it in the frame.
    geometry.translate(-0.5, -0.5, -0.5);

    const material = new THREE.MeshLambertMaterial({
      map: atlasTexture,
      transparent: true,
      alphaTest: 0.5,
    });
    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);
    gl.render(scene, camera);
    const url = gl.domElement.toDataURL("image/png");

    // Disposed straight away: one geometry and one material per block held for
    // the life of the panel is nine hundred of each on the GPU, and the picture
    // is all that was wanted.
    scene.remove(mesh);
    geometry.dispose();
    material.dispose();
    return url;
  }

  /**
   * Asks main for the icons this window needs and paints them.
   *
   * Only what has not been asked for: a scroll re-runs this constantly, and
   * re-requesting a block already in flight would multiply the work by however
   * fast the wheel is turning.
   */
  async function fetchVisible(): Promise<void> {
    const wanted = visible.filter((block) => !requested.has(block));
    if (wanted.length === 0) return;
    for (const block of wanted) requested.add(block);

    if (!bridgeAvailable) return;
    const response = await api().getBlockIcons({ blocks: wanted, atlasVersion });
    if (!response.ok) {
      // Let them be asked for again: a failure here is usually a document that
      // was not open yet, and the next scroll should retry rather than leave
      // permanently blank tiles.
      for (const block of wanted) requested.delete(block);
      return;
    }

    ensureRenderer();
    adoptAtlas(response.atlas, response.atlasVersion);
    // One new Map rather than mutating: `$state` on a Map tracks the reference,
    // so writing into the old one draws nothing until something else changes.
    const next = new Map(painted);
    for (const icon of response.icons) {
      const url = paint(icon);
      if (url !== null) next.set(icon.block, url);
    }
    painted = next;
  }

  $effect(() => {
    if (!open) return;
    void visible;
    void fetchVisible();
  });

  $effect(() => {
    if (open) search?.focus();
  });

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onclose();
    }
  }
</script>

{#if open}
  <div
    class="scrim"
    role="presentation"
    onkeydown={onKeydown}
    onclick={(event) => {
      if (event.target === event.currentTarget) onclose();
    }}
  >
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div class="modal" role="dialog" aria-modal="true" aria-label={t("inventory.title")} tabindex="-1">
      <header>
        <input
          bind:this={search}
          bind:value={query}
          type="search"
          placeholder={t("inventory.search")}
          aria-label={t("inventory.search")}
        />
        <span class="hint">
          {t("inventory.count", { count: filtered.length.toLocaleString() })}
          · {mcVersion(version)?.label ?? version}
        </span>
        <button class="icon" onclick={onclose} aria-label={t("common.close")}>&#x00d7;</button>
      </header>

      <div
        class="grid"
        bind:this={scroller}
        bind:clientHeight={viewportHeight}
        onscroll={() => (scrollTop = scroller?.scrollTop ?? 0)}
      >
        <!-- One tall spacer, with only the visible rows positioned inside it.
             The spacer is what gives the scrollbar the right length without
             nine hundred elements existing. -->
        <div class="spacer" style={`height: ${view.totalRows * TILE}px`}>
          {#each visible as block, offset (block)}
            {@const index = view.firstIndex + offset}
            <button
              class="tile"
              style={`
                top: ${Math.floor(index / COLUMNS) * TILE}px;
                left: ${(index % COLUMNS) * TILE}px;
              `}
              onclick={() => {
                onpick(block);
                onclose();
              }}
              title={block}
            >
              {#if painted.get(block)}
                <img src={painted.get(block)} alt="" width="40" height="40" />
              {:else}
                <!-- Not empty while it is being built: a blank tile that later
                     fills in reads as a broken image until it does. -->
                <span class="pending" aria-hidden="true"></span>
              {/if}
              <span class="name">{blockLabel(block)}</span>
            </button>
          {/each}
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--scrim);
    backdrop-filter: blur(2px);
  }

  .modal {
    display: flex;
    flex-direction: column;
    width: min(620px, calc(100vw - 48px));
    height: min(560px, calc(100vh - 64px));
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--bg-panel);
    box-shadow: 0 16px 48px var(--shadow);
    outline: none;
    overflow: hidden;
  }

  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
  }

  input {
    flex: 1 1 auto;
    min-width: 0;
    padding: 5px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-input);
    color: var(--text);
    font: inherit;
  }

  .hint {
    flex: none;
    font-size: 11px;
    color: var(--text-dim);
  }

  .grid {
    flex: 1 1 auto;
    overflow-y: auto;
    padding: 8px;
  }

  .spacer {
    position: relative;
    width: 100%;
  }

  .tile {
    position: absolute;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1px;
    width: 68px;
    height: 68px;
    padding: 2px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: none;
    color: var(--text-dim);
    cursor: pointer;
    overflow: hidden;
  }

  .tile:hover {
    border-color: var(--accent);
    background: var(--bg-input);
    color: var(--text);
  }

  img {
    width: 40px;
    height: 40px;
    /* The atlas is 16px art; anything but nearest turns a face into mush. */
    image-rendering: pixelated;
  }

  .pending {
    width: 40px;
    height: 40px;
    border-radius: 4px;
    background: var(--bg-input);
  }

  .name {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 9px;
    line-height: 1.1;
  }
</style>
