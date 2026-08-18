<script lang="ts">
  /**
   * Drag handle between the control column and the 3D viewport.
   *
   * No Streamlit counterpart -- Streamlit owned the page layout and the viewer
   * lived in an iframe. Now that both share one window they compete for width,
   * so the split is the user's to set.
   *
   * The viewer needs no wiring for this: `Viewer.svelte` sizes its canvas from
   * a `ResizeObserver` on its own container, not from `window.resize`, so a
   * grid-track change is already a resize as far as it is concerned.
   */
  import { SIDEBAR_WIDTH } from "../../../shared/settings.js";
  import { t } from "./i18n.svelte.js";

  interface Props {
    width: number;
    /** Fired continuously while dragging -- cheap, renderer-local. */
    onresize: (width: number) => void;
    /** Fired once when the gesture ends; this is what gets persisted. */
    oncommit: (width: number) => void;
  }

  const { width, onresize, oncommit }: Props = $props();

  let dragging = $state(false);

  /**
   * The persisted upper bound is not enough on its own: a 720px sidebar in a
   * 960px window (the app's `minWidth`) leaves the viewport unusable. The live
   * window width is the second clamp, applied on every move.
   */
  function clamp(value: number): number {
    const max = Math.min(SIDEBAR_WIDTH.max, window.innerWidth - SIDEBAR_WIDTH.minViewport);
    return Math.round(Math.min(Math.max(value, SIDEBAR_WIDTH.min), Math.max(max, SIDEBAR_WIDTH.min)));
  }

  /**
   * Pointer capture keeps the gesture alive over the canvas, which would
   * otherwise swallow the moves for its own orbit controls. It is best-effort:
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
    if (event.button !== 0) return;
    dragging = true;
    capture(event.currentTarget, event.pointerId, true);
    event.preventDefault();
  }

  function onPointerMove(event: PointerEvent): void {
    if (!dragging) return;
    onresize(clamp(event.clientX));
  }

  function endDrag(event: PointerEvent): void {
    if (!dragging) return;
    dragging = false;
    capture(event.currentTarget, event.pointerId, false);
    oncommit(clamp(width));
  }

  const STEP = 16;

  function onKeyDown(event: KeyboardEvent): void {
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = width - STEP;
    else if (event.key === "ArrowRight") next = width + STEP;
    else if (event.key === "Home") next = SIDEBAR_WIDTH.min;
    else if (event.key === "End") next = SIDEBAR_WIDTH.max;
    if (next === null) return;
    event.preventDefault();
    const clamped = clamp(next);
    onresize(clamped);
    oncommit(clamped);
  }
</script>

<!--
  Svelte's a11y linter classes `separator` as non-interactive, but a *focusable*
  separator is precisely what the ARIA authoring practices prescribe for a
  window splitter: role=separator + tabindex + aria-valuenow/min/max, driven by
  the arrow keys. Suppressed knowingly rather than by dropping the keyboard
  path, which would make the split mouse-only.
-->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="splitter"
  class:dragging
  role="separator"
  tabindex="0"
  aria-orientation="vertical"
  aria-label={t("sidebar.resize")}
  aria-valuenow={Math.round(width)}
  aria-valuemin={SIDEBAR_WIDTH.min}
  aria-valuemax={SIDEBAR_WIDTH.max}
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={endDrag}
  onpointercancel={endDrag}
  onkeydown={onKeyDown}
>
  <span class="grip" aria-hidden="true"></span>
</div>

<style>
  .splitter {
    position: relative;
    width: 7px;
    cursor: col-resize;
    background: var(--bg);
    border-right: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: center;
    /* The hit area is wider than the visual line without moving the layout. */
    touch-action: none;
  }

  .splitter::before {
    content: "";
    position: absolute;
    inset: 0 -4px;
  }

  .splitter:hover,
  .splitter:focus-visible,
  .splitter.dragging {
    background: var(--accent-dim);
    outline: none;
  }

  .grip {
    width: 1px;
    height: 28px;
    border-radius: 1px;
    background: var(--border);
  }

  .splitter:hover .grip,
  .splitter:focus-visible .grip,
  .splitter.dragging .grip {
    background: var(--text);
  }
</style>
