<script lang="ts">
  /**
   * What a schematic is going to be: how big, which container, which version.
   *
   * One component for New and for Save As, because they ask the same three
   * questions and only the size field differs — New sets it, Save As inherits
   * it from the open document and shows it as a fact. Two components would be
   * two places to keep the era rule, and the era rule is the whole reason these
   * questions belong together.
   *
   * ## Why the format is chosen here and not in the OS dialog
   *
   * `.schem` is both Sponge v2 and Sponge v3, and Electron's save dialog
   * reports the path the user chose but not which filter produced it. So the
   * container cannot be recovered from the file name, which means it has to be
   * decided before the native dialog opens rather than read out of it after.
   */
  import {
    SCHEMATIC_FORMAT_LABEL,
    schematicExtension,
    type SchematicFormat,
  } from "../../../shared/schematic.js";
  import {
    formatsFor,
    MC_VERSIONS,
    mcVersion,
    refusalFor,
  } from "../../../shared/mc_versions.js";
  import { t } from "./i18n.svelte.js";

  interface Props {
    open: boolean;
    /** `new` asks for a size; `save-as` shows the one the document already has. */
    mode: "new" | "save-as";
    /** Starting values, so Save As opens on what the document already is. */
    initial: {
      width: number;
      height: number;
      length: number;
      format: SchematicFormat;
      version: string;
    };
    /** The file name Save As will suggest, without an extension. */
    suggestedName?: string;
    onclose: () => void;
    onconfirm: (choice: {
      width: number;
      height: number;
      length: number;
      format: SchematicFormat;
      version: string;
    }) => void;
  }

  const { open, mode, initial, suggestedName, onclose, onconfirm }: Props = $props();

  let width = $state(16);
  let height = $state(16);
  let length = $state(16);
  let format = $state<SchematicFormat>("sponge3");
  let version = $state("");
  let dialog = $state<HTMLDivElement | undefined>(undefined);

  /**
   * Re-seeded every time it opens, not once at construction.
   *
   * The component stays mounted between openings, so fields set from `initial`
   * at construction would show the first document's size forever. Guarded on
   * `open` rather than on `initial` because a parent that rebuilds the object
   * would otherwise reset a half-typed number under the cursor.
   */
  $effect(() => {
    if (!open) return;
    width = initial.width;
    height = initial.height;
    length = initial.length;
    format = initial.format;
    version = initial.version;
    dialog?.focus();
  });

  /** Sizes are typed, so they arrive as anything. */
  const clamp = (value: number) => Math.max(1, Math.min(2048, Math.trunc(value) || 1));

  const volume = $derived(clamp(width) * clamp(height) * clamp(length));

  /**
   * The version decides which containers are on offer, not the other way round.
   *
   * That is the direction the fact runs: you are building *for* a Minecraft
   * version, and Sponge's palette is flattened block names that did not exist
   * before 1.13. A format picker that let you choose Sponge for 1.8.8 would be
   * offering a file nothing can read.
   */
  const formats = $derived(formatsFor(version));

  /**
   * Why the format the user had is no longer available, if it went away.
   *
   * Shown rather than silently corrected. The select below snaps to something
   * valid either way — leaving it on an impossible value would be worse — but a
   * control that changes under the cursor with no explanation is how someone
   * concludes the app is broken.
   */
  const refused = $derived(refusalFor(format, version));

  $effect(() => {
    if (formats.length > 0 && !formats.includes(format)) format = formats[0];
  });

  function confirm(): void {
    onconfirm({
      width: clamp(width),
      height: clamp(height),
      length: clamp(length),
      format,
      version,
    });
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onclose();
    }
    // Enter confirms from anywhere but a number field being edited, where it
    // would fire before the value is committed on some platforms.
    if (event.key === "Enter" && !(event.target as HTMLElement)?.matches?.("input[type=number]")) {
      event.preventDefault();
      confirm();
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
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      aria-label={mode === "new" ? t("doc.newTitle") : t("doc.saveAsTitle")}
      tabindex="-1"
      bind:this={dialog}
    >
      <h2>{mode === "new" ? t("doc.newTitle") : t("doc.saveAsTitle")}</h2>

      {#if mode === "new"}
        <fieldset>
          <legend>{t("doc.size")}</legend>
          <div class="sizes">
            <label>
              <span>{t("doc.width")}</span>
              <input type="number" min="1" max="2048" bind:value={width} />
            </label>
            <label>
              <span>{t("doc.height")}</span>
              <input type="number" min="1" max="2048" bind:value={height} />
            </label>
            <label>
              <span>{t("doc.length")}</span>
              <input type="number" min="1" max="2048" bind:value={length} />
            </label>
          </div>
          <p class="hint">{t("doc.volume", { count: volume.toLocaleString() })}</p>
        </fieldset>
      {:else}
        <p class="hint fact">
          {t("doc.savingSize", { size: `${initial.width}×${initial.height}×${initial.length}` })}
        </p>
      {/if}

      <!--
        Version above format, in the order the decision is actually made: which
        Minecraft you are building for, and only then which of the containers
        that version can live in.
      -->
      <label class="row">
        <span>{t("doc.version")}</span>
        <select bind:value={version}>
          {#each MC_VERSIONS as option (option.name)}
            <option value={option.name}>
              {option.label}{option.era === "legacy" ? ` — ${t("doc.legacyEra")}` : ""}
            </option>
          {/each}
        </select>
      </label>

      <label class="row">
        <span>{t("doc.format")}</span>
        <select bind:value={format}>
          {#each formats as option (option)}
            <option value={option}>{SCHEMATIC_FORMAT_LABEL[option]}</option>
          {/each}
        </select>
      </label>

      {#if refused}
        <p class="hint warn">{refused}</p>
      {:else if mcVersion(version)?.era === "legacy"}
        <p class="hint">{t("doc.legacyNote")}</p>
      {/if}

      {#if mode === "save-as" && suggestedName}
        <p class="hint">
          {t("doc.willBeNamed", { name: `${suggestedName}.${schematicExtension(format)}` })}
        </p>
      {/if}

      <div class="buttons">
        <button onclick={onclose}>{t("common.cancel")}</button>
        <button class="primary" onclick={confirm}>
          {mode === "new" ? t("doc.create") : t("doc.chooseLocation")}
        </button>
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
    gap: 12px;
    width: min(400px, calc(100vw - 48px));
    padding: 18px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--bg-panel);
    box-shadow: 0 16px 48px var(--shadow);
    outline: none;
  }

  h2 {
    margin: 0;
    font-size: 15px;
  }

  fieldset {
    margin: 0;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
  }

  legend {
    padding: 0 4px;
    font-size: 11px;
    color: var(--text-dim);
  }

  .sizes {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }

  .sizes label {
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: 11px;
    color: var(--text-dim);
  }

  .row {
    display: grid;
    grid-template-columns: 90px minmax(0, 1fr);
    align-items: center;
    gap: 8px;
    font-size: 12px;
  }

  input,
  select {
    width: 100%;
    min-width: 0;
    padding: 4px 6px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-input);
    color: var(--text);
    font: inherit;
  }

  .hint {
    margin: 0;
    font-size: 11px;
    color: var(--text-dim);
  }

  .hint.warn {
    padding: 6px 8px;
    border-radius: 6px;
    background: var(--bg-input);
    color: var(--text);
  }

  .hint.fact {
    padding: 6px 8px;
    border-radius: 6px;
    background: var(--bg-input);
  }

  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 2px;
  }
</style>
