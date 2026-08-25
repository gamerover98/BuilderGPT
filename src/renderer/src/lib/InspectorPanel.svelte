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
   * Values are free text with a datalist of the legal ones, not a closed
   * dropdown. The list is real now -- `shared/block_states.ts` is generated
   * from the game's own data -- where it used to be twelve properties written
   * out by hand, so `layers`, `age`, `level`, `power`, `rotation`, `honey_level`
   * and every connection value were typed blind.
   *
   * Still free text, and still deliberately. The table knows 1105 blocks and
   * the app will happily open a schematic holding one it does not, so a closed
   * dropdown would refuse a value the file already contains. `legalValuesFor`
   * returns `null` rather than `[]` for exactly that case, and a property with
   * no known values gets a plain field instead of an empty menu.
   */
  import type { BlockInspection } from "../../../shared/ipc.js";
  import { legalValuesFor } from "../../../shared/block_states.js";
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
   * The legal values of each property this block actually carries, keyed by
   * property name. `null` for anything the generated table does not describe.
   *
   * Derived rather than looked up in the markup because the lookup takes the
   * block id, and reading it per row would recompute it once per property on
   * every render.
   */
  const valueLists = $derived.by(() => {
    const block = inspection?.block;
    if (block === undefined) return {} as Record<string, readonly string[]>;
    const out: Record<string, readonly string[]> = {};
    for (const name of Object.keys(inspection?.properties ?? {})) {
      const values = legalValuesFor(block, name);
      if (values !== null) out[name] = values;
    }
    return out;
  });

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
  <!--
    No `<fieldset>` and no legend: this lives inside a `ToolWindow`, whose title
    bar already says what it is. It carried both while it was the sidebar's
    third tab, and keeping them here would draw a second border and a second
    heading inside the first.
  -->
  <div class="panel">
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
                list={valueLists[name] ? `values-${name}` : undefined}
                disabled={busy}
                spellcheck="false"
                onchange={(event) => onchangeproperty(name, event.currentTarget.value)}
              />
              {#if valueLists[name]}
                <datalist id={`values-${name}`}>
                  {#each valueLists[name] as option (option)}
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
  </div>
{/if}

<style>
  .panel {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

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
