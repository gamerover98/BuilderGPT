<!--
  The transform gizmo's own controls, over the canvas.

  Along the bottom, just clear of the hotbar. It opened at the top centre, which
  is the same place `.status` puts a notification -- not near it, the identical
  declaration -- so every message the app raised landed on top of the toolbar
  the user was reaching for.

  Anchored to the viewport rather than to the gizmo, which is the one placement
  decision worth explaining. Following the gizmo would mean projecting a world
  point to screen space every frame and handing that to the DOM, and the result
  would sit under the pointer exactly when the pointer is busy dragging a
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
    /** Take the selection to the clipboard, and leave a ghost of it behind. */
    oncopy: () => void;
    /** Write the clipboard in at the selection's corner. */
    onpaste: () => void;
    /** Whether anything has been copied yet. */
    canPaste: boolean;
    /** Whether a paste leaves the empty-space block where it falls. */
    skipEmpty: boolean;
    onskipempty: (next: boolean) => void;
    /**
     * What this document's empty space is made of, or `""` for air.
     *
     * The toggle above can only do something when it is *not* air: air is never
     * stored in a clipboard, so a paste never writes it and there is nothing to
     * leave alone. Shown disabled and pressed rather than hidden -- the app
     * shows an impossible version disabled rather than filtering it out, for the
     * same reason. It is true (a paste really does keep what is under it here)
     * and it is still there to be found, which a control that came and went
     * with a setting two panels away would not be.
     */
    emptyBlock: string;
  }

  const {
    mode,
    onmode,
    moved,
    onresetpivot,
    onmirror,
    busy,
    oncopy,
    onpaste,
    canPaste,
    skipEmpty,
    onskipempty,
    emptyBlock,
  }: Props = $props();

  const emptyIsAir = $derived(emptyBlock === "");

  /*
   * Glyphs rather than words, and the name on hover.
   *
   * Four words plus three axes plus a reset is a strip wide enough to be part
   * of the layout rather than part of the viewport, and none of those words is
   * one you read twice. What is worth reading is what the mode *does*, which is
   * a sentence, and a sentence does not belong on a button at all.
   *
   * `aria-label` is not optional here: with no text content there is nothing
   * else for a screen reader to announce. `title` carries the name, the
   * sentence and the key, because the key is otherwise undiscoverable.
   */
  const MODES: readonly {
    mode: GizmoMode;
    label: string;
    hint: string;
    glyph: string;
    key: string;
  }[] = [
    { mode: "move", label: "gizmo.move", hint: "gizmo.move.hint", glyph: "✥", key: "G" },
    { mode: "rotate", label: "gizmo.rotate", hint: "gizmo.rotate.hint", glyph: "↻", key: "T" },
    { mode: "scale", label: "gizmo.scale", hint: "gizmo.scale.hint", glyph: "⤢", key: "Y" },
    { mode: "pivot", label: "gizmo.pivot", hint: "gizmo.pivot.hint", glyph: "⌖", key: "P" },
  ];

  const AXES: readonly Axis[] = ["x", "y", "z"];
</script>

<div class="gizmo-bar" role="toolbar" aria-label={t("gizmo.legend")}>
  <!--
    Copy and paste, because the stamp turned them into a loop rather than two
    one-off commands: copy, carry the box, paste, carry it again. Cut is
    deliberately not here -- it is destructive and happens once, so it is not
    part of that loop, and Ctrl+X still does it.

    The third is WorldEdit's `//paste -a` for the half this app did not already
    do. Air is never stored in a clipboard and so is never pasted; a `barrier`
    or a `water` chosen as empty space *is* a real block in the copy, and a
    paste stamps it over whatever was standing there.
  -->
  <div class="group">
    <button
      onclick={oncopy}
      disabled={busy}
      aria-label={t("gizmo.copy")}
      title={`${t("gizmo.copy")} (Ctrl+C) — ${t("gizmo.copy.hint")}`}
    >
      ⧉
    </button>
    <button
      onclick={onpaste}
      disabled={busy || !canPaste}
      aria-label={t("gizmo.paste")}
      title={`${t("gizmo.paste")} (Ctrl+V) — ${t("gizmo.paste.hint")}`}
    >
      ⤓
    </button>
    <button
      class:active={emptyIsAir || skipEmpty}
      onclick={() => onskipempty(!skipEmpty)}
      disabled={busy || emptyIsAir}
      aria-label={t("gizmo.skipEmpty")}
      aria-pressed={emptyIsAir || skipEmpty}
      title={emptyIsAir
        ? `${t("gizmo.skipEmpty")} — ${t("gizmo.skipEmpty.air")}`
        : `${t("gizmo.skipEmpty")} — ${t("gizmo.skipEmpty.hint", { block: emptyBlock })}`}
    >
      ⬚
    </button>
  </div>

  <div class="group">
    {#each MODES as entry (entry.mode)}
      <button
        class:active={mode === entry.mode}
        onclick={() => onmode(entry.mode)}
        disabled={busy}
        aria-label={t(entry.label)}
        aria-pressed={mode === entry.mode}
        title={`${t(entry.label)} (${entry.key}) — ${t(entry.hint)}`}
      >
        {entry.glyph}
      </button>
    {/each}
  </div>

  <!--
    Three axes, not two verbs. "Mirror" and "flip" are the same operation --
    a reflection through a plane -- and calling the horizontal one mirroring and
    the vertical one flipping would be two names for one thing and a missing
    third. The plane passes through the pivot, which is what makes moving the
    pivot worth doing.

    The axis letters carry their own colours rather than a glyph each, because
    X and Z are both horizontal and any mirror glyph would draw them
    identically. The colour is the language the gizmo has already taught in the
    viewport, so it is read without being explained; the `⇄` in front says which
    verb the three letters belong to and is decorative.
  -->
  <div class="group mirrors">
    <span class="marker" aria-hidden="true">⇄</span>
    {#each AXES as axis (axis)}
      <button
        class={`axis-${axis}`}
        onclick={() => onmirror(axis)}
        disabled={busy}
        aria-label={t(`gizmo.mirror.${axis}`)}
        title={t(`gizmo.mirror.${axis}`)}
      >
        {axis.toUpperCase()}
      </button>
    {/each}
  </div>

  {#if moved}
    <button
      class="reset"
      onclick={onresetpivot}
      disabled={busy}
      aria-label={t("gizmo.resetPivot")}
      title={`${t("gizmo.resetPivot")} — ${t("gizmo.resetPivotHint")}`}
    >
      ⌾
    </button>
  {/if}
</div>

<style>
  .gizmo-bar {
    position: absolute;
    /* Clear of the hotbar, from the tokens that describe it. See `app.css`. */
    bottom: calc(var(--hotbar-inset) + var(--hotbar-height) + 8px);
    left: 50%;
    transform: translateX(-50%);
    z-index: 5;
    display: flex;
    gap: 10px;
    align-items: center;
    padding: 4px 6px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-panel);
    box-shadow: 0 6px 20px var(--shadow);
  }

  .group {
    display: flex;
    gap: 2px;
    align-items: center;
  }

  button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 26px;
    border: 1px solid transparent;
    border-radius: 5px;
    background: none;
    color: var(--text-dim);
    font: inherit;
    /* The glyphs are drawn small by most families; the letters are not. */
    font-size: 15px;
    line-height: 1;
    cursor: pointer;
  }

  button:hover:not(:disabled) {
    background: var(--bg-input);
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

  .mirrors button {
    font-size: 12px;
    font-weight: 600;
  }

  /* The same three tokens the gizmo's own arrows are drawn from. */
  .mirrors .axis-x {
    color: var(--axis-x);
  }

  .mirrors .axis-y {
    color: var(--axis-y);
  }

  .mirrors .axis-z {
    color: var(--axis-z);
  }

  .marker {
    padding-right: 2px;
    color: var(--text-dim);
    font-size: 13px;
    opacity: 0.7;
  }

  .reset {
    border-color: var(--border);
  }
</style>
