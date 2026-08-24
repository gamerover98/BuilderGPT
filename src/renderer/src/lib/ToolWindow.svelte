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
  import { PANEL_SIZE } from "../../../shared/settings.js";
  import { clampPanelSize, clampToBounds, isWithinBounds, type Bounds } from "./floating.js";
  import { t } from "./i18n.svelte.js";

  interface Props {
    title: string;
    /** Pixels from the top-left of the containing viewport area. */
    x: number;
    y: number;
    /**
     * The panel's own size, in CSS pixels.
     *
     * It was a hard-coded 232px, which is why the version history had to leave:
     * a list of what a schematic has been does not fit in it, and neither does
     * the inspector's `Items[0].tag.display.Name`. The width is a setting now,
     * and the same two-stage clamp the sidebar uses keeps it reachable.
     */
    width: number;
    height: number;
    /** Fired continuously while dragging — cheap, renderer-local. */
    onmove: (x: number, y: number) => void;
    /** Fired once when the gesture ends; this is what gets persisted. */
    oncommit: (x: number, y: number) => void;
    /** The same split for the resize gesture: live, then once at the end. */
    onresize: (width: number, height: number) => void;
    onresizecommit: (width: number, height: number) => void;
    onclose: () => void;
    closeLabel: string;
    children: Snippet;
  }

  const {
    title,
    x,
    y,
    width,
    height,
    onmove,
    oncommit,
    onresize,
    onresizecommit,
    onclose,
    closeLabel,
    children,
  }: Props = $props();

  let panel = $state<HTMLDivElement | undefined>(undefined);
  let dragging = $state(false);
  let resizing = $state(false);
  /** Where the corner was grabbed, so the panel does not jump to the pointer. */
  let grabW = 0;
  let grabH = 0;
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
      panelHeight: panel.offsetHeight,
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
    /*
     * A press on the close button is not a press on the title bar.
     *
     * This handler is on the whole header, so it fired for the button too --
     * and then took pointer capture, which is what actually broke it: while a
     * capture is active the browser dispatches the following `click` to the
     * *capturing* element, so it landed on the header and `onclose` never ran.
     * The panel could not be closed at all, and nothing about it looked wrong.
     */
    if (event.target instanceof Element && event.target.closest("button") !== null) {
      return;
    }
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

  /**
   * The resize gesture, in the shape `SidebarSplitter` established: a live
   * callback per move and one commit at the end, so a drag costs no writes to
   * disk and the result survives a restart.
   */
  function onResizeDown(event: PointerEvent): void {
    if (event.button !== 0 || !panel) return;
    const rect = panel.getBoundingClientRect();
    grabW = rect.width - (event.clientX - rect.left);
    grabH = rect.height - (event.clientY - rect.top);
    resizing = true;
    capture(event.currentTarget, event.pointerId, true);
    event.preventDefault();
  }

  /** The size to use, clamped against the live pane as well as the minimum. */
  function sized(nextW: number, nextH: number): { width: number; height: number } {
    const parent = panel?.offsetParent as HTMLElement | null;
    const pane = parent
      ? { width: parent.clientWidth, height: parent.clientHeight }
      : { width: Number.MAX_SAFE_INTEGER, height: Number.MAX_SAFE_INTEGER };
    return clampPanelSize({ width: nextW, height: nextH }, pane);
  }

  function onResizeMove(event: PointerEvent): void {
    if (!resizing || !panel) return;
    const rect = panel.getBoundingClientRect();
    const next = sized(event.clientX - rect.left + grabW, event.clientY - rect.top + grabH);
    onresize(next.width, next.height);
  }

  function endResize(event: PointerEvent): void {
    if (!resizing) return;
    resizing = false;
    capture(event.currentTarget, event.pointerId, false);
    const next = sized(width, height);
    onresizecommit(next.width, next.height);
  }

  const STEP = 16;

  function onResizeKey(event: KeyboardEvent): void {
    let next: { width: number; height: number } | null = null;
    if (event.key === "ArrowLeft") next = sized(width - STEP, height);
    else if (event.key === "ArrowRight") next = sized(width + STEP, height);
    else if (event.key === "ArrowUp") next = sized(width, height - STEP);
    else if (event.key === "ArrowDown") next = sized(width, height + STEP);
    if (next === null) return;
    event.preventDefault();
    onresize(next.width, next.height);
    onresizecommit(next.width, next.height);
  }

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
  style={`left: ${x}px; top: ${y}px; width: ${width}px; height: ${height}px`}
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

  <!--
    A separator, with the ARIA value contract `SidebarSplitter` spells out: the
    keyboard path is not decoration, it is the only way to resize this without
    a pointer.
  -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="resize"
    class:resizing
    role="separator"
    tabindex="0"
    aria-label={t("toolwindow.resize")}
    aria-valuenow={Math.round(width)}
    aria-valuemin={PANEL_SIZE.minWidth}
    onpointerdown={onResizeDown}
    onpointermove={onResizeMove}
    onpointerup={endResize}
    onpointercancel={endResize}
    onkeydown={onResizeKey}
  ></div>
</div>

<style>
  /*
   * `width` and `height` come from the inline style now, not from here: the
   * 232px that used to be law is a default in `DEFAULT_UI_SETTINGS`. Rows so
   * the body takes whatever the header leaves, and `minmax(0, 1fr)` so it
   * scrolls inside instead of growing the panel past the size that was asked
   * for.
   */
  .tool-window {
    position: absolute;
    z-index: 5;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
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

  /* No `max-height`: the panel's own height is the limit now, and it is the
     user's to set. */
  .body {
    min-height: 0;
    padding: 10px;
    overflow-y: auto;
  }

  /*
   * The corner. Drawn as two short strokes rather than a solid block, which is
   * the convention everywhere else and reads as "grab me" without taking up
   * room the panel's content wants.
   */
  .resize {
    position: absolute;
    right: 0;
    bottom: 0;
    width: 16px;
    height: 16px;
    cursor: nwse-resize;
    touch-action: none;
    background:
      linear-gradient(135deg, transparent 0 44%, var(--border) 44% 56%, transparent 56% 100%),
      linear-gradient(135deg, transparent 0 68%, var(--border) 68% 80%, transparent 80% 100%);
  }

  .resize:hover,
  .resize:focus-visible,
  .resize.resizing {
    background:
      linear-gradient(135deg, transparent 0 44%, var(--accent) 44% 56%, transparent 56% 100%),
      linear-gradient(135deg, transparent 0 68%, var(--accent) 68% 80%, transparent 80% 100%);
    outline: none;
  }
</style>
