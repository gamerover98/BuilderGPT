<!--
  The transform gizmo's own controls, over the canvas.

  Anchored to the viewport rather than to the gizmo, which is the one decision
  in here worth explaining. Following the gizmo would mean projecting a world
  point to screen space every frame and handing that to the DOM -- and the
  result would sit under the pointer exactly when the pointer is busy dragging a
  handle. Pinned, it is always in the same place and never in the way.

  Mode is a *tool*, not an operation: the operations are the drags, which is why
  they left the SELECTION panel. Mirroring is here rather than as a handle
  because a reflection has no continuous gesture -- there is nothing to drag,
  only an axis to name.
-->
<script lang="ts">
  import { t } from "./i18n.svelte.js";
  import type { Axis, GizmoMode } from "./gizmo.js";

  interface Props {
    mode: GizmoMode;
    onmode: (mode: GizmoMode) => void;
    /** Whether a pivot has been placed, so it can be offered back. */
    moved: boolean;
    onresetpivot: () => void;
    onmirror: (axis: Axis) => void;
    busy: boolean;
  }

  const { mode, onmode, moved, onresetpivot, onmirror, busy }: Props = $props();

  /*
   * The keys are shown rather than only bound. A gizmo whose modes are reachable
   * only by pressing something you have to be told about is a gizmo most people
   * use in one mode -- which is what the SELECTION panel's Move button was.
   */
  const MODES: readonly { mode: GizmoMode; label: string; key: string }[] = [
    { mode: "move", label: "gizmo.move", key: "G" },
    { mode: "rotate", label: "gizmo.rotate", key: "T" },
    { mode: "scale", label: "gizmo.scale", key: "Y" },
    { mode: "pivot", label: "gizmo.pivot", key: "P" },
  ];

  const AXES: readonly Axis[] = ["x", "y", "z"];
</script>

<div class="gizmo-bar" role="toolbar" aria-label={t("gizmo.legend")}>
  <div class="group">
    {#each MODES as entry (entry.mode)}
      <button
        class:active={mode === entry.mode}
        onclick={() => onmode(entry.mode)}
        disabled={busy}
        title={`${t(entry.label)} (${entry.key})`}
      >
        {t(entry.label)}
      </button>
    {/each}
  </div>

  <!--
    Three axes, not two verbs. "Mirror" and "flip" are the same operation --
    a reflection through a plane -- and calling the horizontal one mirroring and
    the vertical one flipping would be two names for one thing and a missing
    third. The plane passes through the pivot, which is what makes moving the
    pivot worth doing.
  -->
  <div class="group">
    {#each AXES as axis (axis)}
      <button onclick={() => onmirror(axis)} disabled={busy} title={t(`gizmo.mirror.${axis}`)}>
        {t("gizmo.mirrorShort", { axis: axis.toUpperCase() })}
      </button>
    {/each}
  </div>

  {#if moved}
    <button class="reset" onclick={onresetpivot} disabled={busy} title={t("gizmo.resetPivotHint")}>
      {t("gizmo.resetPivot")}
    </button>
  {/if}
</div>

<style>
  .gizmo-bar {
    position: absolute;
    top: 12px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 4;
    display: flex;
    gap: 10px;
    align-items: center;
    padding: 5px 7px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: color-mix(in srgb, var(--panel) 88%, transparent);
    backdrop-filter: blur(6px);
  }

  .group {
    display: flex;
    gap: 3px;
  }

  button {
    padding: 3px 9px;
    border: 1px solid transparent;
    border-radius: 5px;
    background: none;
    color: var(--text-dim);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  button:hover:not(:disabled) {
    color: var(--text);
  }

  button:disabled {
    opacity: 0.45;
    cursor: default;
  }

  button.active {
    border-color: var(--accent);
    color: var(--accent);
  }

  .reset {
    border-color: var(--border);
  }
</style>
