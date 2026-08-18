<script lang="ts">
  /**
   * What the clicked block actually is: its id, its block states, and the NBT
   * it carries if it is a chest, a sign or a spawner.
   *
   * The block-state editor is built from the block's own properties rather than
   * from a table of block types. There are hundreds of block types and no two
   * agree on their states, so a hand-written form per type would be permanently
   * incomplete — whereas whatever `facing` or `half` or `waterlogged` a block
   * turns out to have, it is already right there in what the loader parsed.
   *
   * Values are free text with a datalist of the usual suspects, not a closed
   * dropdown. The app vendors no blockstate registry (the resource pack ships
   * textures only), so it does not know the legal values for an arbitrary
   * property, and pretending to would be worse than admitting it.
   */
  import type { BlockInspection } from "../../../shared/ipc.js";
  import { t } from "./i18n.svelte.js";

  interface Props {
    inspection: BlockInspection | null;
    at: { x: number; y: number; z: number } | null;
    busy: boolean;
    onchangeproperty: (name: string, value: string) => void;
    onchangenbt: (path: (string | number)[], value: string) => void;
  }

  const { inspection, at, busy, onchangeproperty, onchangenbt }: Props = $props();

  /** Raw NBT is worth showing, but not by default — it is long and wrapped. */
  let showRaw = $state(false);

  /**
   * The values these properties almost always take. Offered as suggestions;
   * a property not listed here still gets a plain text field.
   */
  const COMMON_VALUES: Readonly<Record<string, readonly string[]>> = {
    facing: ["north", "south", "east", "west", "up", "down"],
    axis: ["x", "y", "z"],
    half: ["top", "bottom", "upper", "lower"],
    type: ["top", "bottom", "double", "single", "left", "right"],
    shape: ["straight", "inner_left", "inner_right", "outer_left", "outer_right"],
    waterlogged: ["true", "false"],
    open: ["true", "false"],
    powered: ["true", "false"],
    lit: ["true", "false"],
    snowy: ["true", "false"],
    hinge: ["left", "right"],
    part: ["head", "foot"],
  };

  const properties = $derived(Object.entries(inspection?.properties ?? {}).sort());

  /**
   * NBT as `prismarine-nbt` shapes it is a tree of `{type, value}` wrappers,
   * which is unreadable printed raw. This strips the wrappers and keeps the
   * structure.
   */
  function readable(node: unknown, depth = 0): string {
    const pad = "  ".repeat(depth);
    if (node === null || node === undefined) return "";
    if (Array.isArray(node)) {
      return node.map((item) => `${pad}- ${readable(item, depth + 1).trimStart()}`).join("\n");
    }
    if (typeof node === "object") {
      const tag = node as { type?: unknown; value?: unknown };
      if (typeof tag.type === "string" && "value" in tag) {
        // A list nests its elements one level deeper than a compound does.
        if (tag.type === "list") return readable((tag.value as { value?: unknown })?.value, depth);
        return readable(tag.value, depth);
      }
      return Object.entries(node as Record<string, unknown>)
        .map(([key, value]) => {
          const rendered = readable(value, depth + 1);
          return rendered.includes("\n")
            ? `${pad}${key}:\n${rendered}`
            : `${pad}${key}: ${rendered.trim()}`;
        })
        .join("\n");
    }
    return `${pad}${String(node)}`;
  }

  const nbtText = $derived(
    inspection?.blockEntity ? readable(JSON.parse(inspection.blockEntity.nbt)) : "",
  );
</script>

{#if !inspection || !at}
  <!--
    An empty state, which this panel did not need until it became a tab. As one
    card in a stack it could simply not render; as a tab of its own, rendering
    nothing looks like something failed to load.
  -->
  <p class="hint empty">{t("inspector.empty")}</p>
{:else}
  <fieldset>
    <legend>{t("inspector.legend")}</legend>

    <p class="id">{inspection.block}</p>
    <p class="hint">{t("inspector.at", { x: at.x, y: at.y, z: at.z })}</p>

    {#if properties.length > 0}
      <div class="field">
        <label for="props">{t("inspector.blockStates")}</label>
        <ul id="props" class="props">
          {#each properties as [name, value] (name)}
            <li>
              <span class="key">{name}</span>
              <input
                value={value}
                list={COMMON_VALUES[name] ? `values-${name}` : undefined}
                disabled={busy}
                spellcheck="false"
                onchange={(event) => onchangeproperty(name, event.currentTarget.value)}
              />
              {#if COMMON_VALUES[name]}
                <datalist id={`values-${name}`}>
                  {#each COMMON_VALUES[name] as option (option)}
                    <option value={option}></option>
                  {/each}
                </datalist>
              {/if}
            </li>
          {/each}
        </ul>
        <p class="hint">{t("inspector.blockStatesHint")}</p>
      </div>
    {:else if inspection.block !== "minecraft:air"}
      <p class="hint">{t("inspector.noBlockStates")}</p>
    {/if}

    {#if inspection.blockEntity}
      <div class="field">
        <label for="nbt-fields">{t("inspector.entityData", { id: inspection.blockEntity.id })}</label>
        {#if inspection.blockEntity.fields.length === 0}
          <p class="hint" id="nbt-fields">{t("inspector.noEntityData")}</p>
        {:else}
          <ul id="nbt-fields" class="props nbt">
            {#each inspection.blockEntity.fields as field (field.label)}
              <li>
                <span class="key" title={`${field.label} · ${field.type}`}>
                  {field.label}
                  <em>{field.type}</em>
                </span>
                <input
                  value={field.value}
                  disabled={busy || !field.editable}
                  spellcheck="false"
                  title={field.editable
                    ? undefined
                    : t("inspector.notEditable", { type: field.type })}
                  onchange={(event) => onchangenbt(field.path, event.currentTarget.value)}
                />
              </li>
            {/each}
          </ul>
          <p class="hint">{t("inspector.nbtHint")}</p>
        {/if}

        <button class="link" onclick={() => (showRaw = !showRaw)}>
          {showRaw ? t("inspector.hideRaw") : t("inspector.showRaw")}
        </button>
        {#if showRaw}
          <pre>{nbtText || t("inspector.emptyTree")}</pre>
        {/if}
      </div>
    {/if}
  </fieldset>
{/if}

<style>
  .empty {
    padding: 20px 2px;
  }

  .id {
    margin: 0;
    font-weight: 600;
    word-break: break-all;
  }

  .props {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .props li {
    display: grid;
    grid-template-columns: minmax(80px, 40%) 1fr;
    align-items: center;
    gap: 8px;
    padding: 2px 0;
  }

  .key {
    font-size: 12px;
    color: var(--text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .nbt {
    max-height: 240px;
    overflow-y: auto;
  }

  /* Long paths like Items[0].tag.display.Name need the room more than the
     value box does. */
  .nbt li {
    grid-template-columns: minmax(90px, 55%) 1fr;
  }

  .key em {
    font-style: normal;
    opacity: 0.65;
    margin-left: 4px;
    font-size: 10px;
  }

  button.link {
    background: none;
    border: none;
    padding: 4px 0 0;
    color: var(--accent);
    cursor: pointer;
    font: inherit;
    font-size: 12px;
  }

  button.link:hover {
    text-decoration: underline;
  }

  pre {
    margin: 0;
    max-height: 220px;
    overflow: auto;
    padding: 8px;
    background: var(--bg-input);
    border-radius: 6px;
    font-size: 12px;
    line-height: 1.4;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
