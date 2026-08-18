<script lang="ts">
  /**
   * A small panel that floats over the viewport and can be dragged around it.
   *
   * The alternative was docking the editing tools to an edge, which is what the
   * sidebar already does and what put them across the window from the thing
   * they act on. Floating keeps them next to the work; being movable is what
   * stops them being in the way of it.
   *
   * Position is owned by the caller and persisted, so the panel is where you
   * left it after a restart. It is clamped twice for the same reason the
   * sidebar width is: the stored value can come from a wider window or a second
   * monitor, and a panel parked off-screen is one nobody can reach.
   */
  import type { Snippet } from "svelte";
  import { clampToBounds, isWithinBounds, type Bounds } from "./floating.js";

  interface Props {
    title: string;
    /** Pixels from the top-left of the containing viewport area. */
    x: number;
    y: number;
    /** Fired continuously while dragging — cheap, renderer-local. */
    onmove: (x: number, y: number) => void;
    /** Fired once when the gesture ends; this is what gets persisted. */
    oncommit: (x: number, y: number) => void;
    onclose: () => void;
    closeLabel: string;
    children: Snippet;
  }

  const { title, x, y, onmove, oncommit, onclose, closeLabel, children }: Props = $props();

  let panel = $state<HTMLDivElement | undefined>(undefined);
  let dragging = $state(false);
  /** Pointer offset within the title bar, so the panel does not jump on grab. */
  let grabX = 0;
  let grabY = 0;

  /** Keeps at least this much of the panel reachable at every edge. */
  const MARGIN = 24;

  /** The pane and panel sizes `floating.ts` needs, read from the DOM. */
  function bounds(): Bounds | null {
    const parent = panel?.offsetParent as HTMLElement | null;
    if (!panel || !parent) return null;
    return {
      paneWidth: parent.clientWidth,
      paneHeight: parent.clientHeight,
      panelWidth: panel.offsetWidth,
      margin: MARGIN,
    };
  }

  function clamp(nextX: number, nextY: number): { x: number; y: number } {
    const box = bounds();
    if (box === null) return { x: Math.max(0, nextX), y: Math.max(0, nextY) };
    return clampToBounds({ x: nextX, y: nextY }, box);
  }

  /**
   * Pointer capture keeps the gesture alive over the canvas, which would
   * otherwise swallow the moves for its own orbit controls. Best-effort:
   * `setPointerCapture` throws `NotFoundError` for a pointer id that is not
   * active, and losing capture should degrade the drag, not abort it.
   */
  function capture(target: EventTarget | null, pointerId: number, take: boolean): void {
    if (!(target instanceof Element)) return;
    try {
      if (take) target.setPointerCapture(pointerId);
      else if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
    } catch {
      // No capture: the drag still tracks the pointer while it stays in bounds.
    }
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || !panel) return;
    const rect = panel.getBoundingClientRect();
    grabX = event.clientX - rect.left;
    grabY = event.clientY - rect.top;
    dragging = true;
    capture(event.currentTarget, event.pointerId, true);
    event.preventDefault();
  }

  function onPointerMove(event: PointerEvent): void {
    if (!dragging || !panel) return;
    const parent = panel.offsetParent as HTMLElement | null;
    if (!parent) return;
    const origin = parent.getBoundingClientRect();
    const next = clamp(event.clientX - origin.left - grabX, event.clientY - origin.top - grabY);
    onmove(next.x, next.y);
  }

  function endDrag(event: PointerEvent): void {
    if (!dragging) return;
    dragging = false;
    capture(event.currentTarget, event.pointerId, false);
    const next = clamp(x, y);
    oncommit(next.x, next.y);
  }

  const STEP = 16;

  function onKeyDown(event: KeyboardEvent): void {
    let next: { x: number; y: number } | null = null;
    if (event.key === "ArrowLeft") next = clamp(x - STEP, y);
    else if (event.key === "ArrowRight") next = clamp(x + STEP, y);
    else if (event.key === "ArrowUp") next = clamp(x, y - STEP);
    else if (event.key === "ArrowDown") next = clamp(x, y + STEP);
    if (next === null) return;
    event.preventDefault();
    onmove(next.x, next.y);
    oncommit(next.x, next.y);
  }

  /**
   * Pulls the panel back into view when the window shrinks under it.
   *
   * Without this, narrowing the window (or widening the sidebar) leaves the
   * panel outside the viewport area with no way to drag it back.
   */
  $effect(() => {
    const parent = panel?.offsetParent as HTMLElement | null;
    if (!parent) return;
    const observer = new ResizeObserver(() => {
      /*
       * Read the position off the element, not off `x`/`y`.
       *
       * This callback is created once, when the effect runs, and the props are
       * only read *inside* it -- so Svelte never tracked them and the closure
       * kept whatever they were at mount. Clamping those would have meant
       * clamping the *starting* position for ever, and narrowing the window
       * would walk the panel off the edge with nothing left to drag it back by.
       * The DOM holds the current truth and cannot go stale.
       */
      if (!panel) return;
      const box = bounds();
      if (box === null) return;
      const here = { x: panel.offsetLeft, y: panel.offsetTop };
      if (isWithinBounds(here, box)) return;
      const next = clampToBounds(here, box);
      onmove(next.x, next.y);
      oncommit(next.x, next.y);
    });
    observer.observe(parent);
    return () => observer.disconnect();
  });
</script>

<div
  class="tool-window"
  class:dragging
  bind:this={panel}
  style={`left: ${x}px; top: ${y}px`}
  role="dialog"
  aria-label={title}
>
  <!--
    Svelte's a11y linter classes a bare div with pointer handlers as
    non-interactive, but a draggable title bar is exactly that: ARIA's own
    window pattern gives it a tabindex and the arrow keys, which is what the
    keyboard path below is for.
  -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <header
    tabindex="0"
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={endDrag}
    onpointercancel={endDrag}
    onkeydown={onKeyDown}
  >
    <span class="grip" aria-hidden="true">⠿</span>
    <span class="title">{title}</span>
    <button class="icon" onclick={onclose} aria-label={closeLabel} title={closeLabel}>
      &#x00d7;
    </button>
  </header>

  <div class="body">
    {@render children()}
  </div>
</div>

<style>
  .tool-window {
    position: absolute;
    z-index: 5;
    width: 232px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--bg-panel);
    box-shadow: 0 8px 28px var(--shadow);
    overflow: hidden;
  }

  .tool-window.dragging {
    /* The canvas underneath must not start a selection or an orbit mid-drag. */
    user-select: none;
  }

  header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 6px 5px 8px;
    border-bottom: 1px solid var(--border);
    background: var(--bg);
    cursor: grab;
    touch-action: none;
  }

  .tool-window.dragging header {
    cursor: grabbing;
  }

  header:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: -1px;
  }

  .grip {
    color: var(--text-dim);
    font-size: 11px;
    letter-spacing: -1px;
  }

  .title {
    flex: 1;
    min-width: 0;
    font-size: 11px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  header .icon {
    width: 20px;
    height: 20px;
    font-size: 14px;
  }

  .body {
    padding: 10px;
    max-height: min(560px, calc(100vh - 180px));
    overflow-y: auto;
  }
</style>
