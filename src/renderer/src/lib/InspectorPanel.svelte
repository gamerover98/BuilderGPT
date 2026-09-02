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
   *
   * ## The list is a union, and that is the whole fix
   *
   * It used to be `Object.entries(inspection.properties)` -- what the entry
   * happens to carry -- which is right for a block that arrived from a file and
   * useless for one that arrived bare. A campfire placed over MCP had no
   * properties at all, so the panel that exists to let you set its direction
   * said "This block has no block states" and offered nothing. The block did
   * have them; nobody had written them down.
   *
   * So the rows are the entry's own keys **and** what the registry says the
   * block may hold. `propertyRows` in `inspector_rows.ts` is that rule, and it
   * is a plain module rather than a `$derived.by` here for `selection_drag.ts`'s
   * reason: a rule written inside a component can only be grepped for, and this
   * one has edge cases worth stating -- an unknown block, and a property the
   * file carries that the block does not legally have.
   *
   * ## Empty means remove, in one place
   *
   * There is no separate delete verb. Clearing the field removes the property,
   * and the button beside a set row is a shortcut for clearing it. One rule,
   * decided in `App.svelte`, because two ways of saying "gone" is how they come
   * to disagree. Before this, clearing the box wrote `name: ""` -- a property
   * with an empty value, which is a state no block has.
   *
   * Removing is a real thing to want, not just the inverse of adding: a partial
   * state is legal in the file (the game fills the rest in with its own
   * defaults), and it is how the MCEdit writer's exact-state match is kept
   * clean -- the same reasoning that keeps `waterlogged` out of the defaults.
   */
  import type { BlockInspection } from "../../../shared/ipc.js";
  import { propertyRows } from "./inspector_rows.js";
  import type { LegacyIndex } from "../../../shared/legacy_ids.js";
  import { t } from "./i18n.svelte.js";

  interface Props {
    inspection: BlockInspection | null;
    at: { x: number; y: number; z: number } | null;
    busy: boolean;
    /**
     * The open document's legacy table when it is a pre-Flattening one, and
     * `null` otherwise -- which is the whole of how this panel knows not to
     * offer `waterlogged` on a 1.12.2 fence. `App.svelte` already derives it.
     */
    legacy?: LegacyIndex | null;
    onchangeproperty: (name: string, value: string) => void;
    onchangenbt: (path: (string | number)[], value: string) => void;
  }

  const {
    inspection,
    at,
    busy,
    legacy = null,
    onchangeproperty,
    onchangenbt,
  }: Props = $props();

  /** Raw NBT is worth showing, but not by default — it is long and wrapped. */
  let showRaw = $state(false);

  /**
   * Every property this block could carry, and what it carries now.
   *
   * `value: null` is a property the block legally has and this one does not --
   * drawn greyed, with the name still there to type into. Sorted by name and
   * not by whether it is set, so a row does not jump somewhere else the moment
   * you fill it in.
   *
   * Derived rather than looked up in the markup because the lookups take the
   * block id, and reading them per row would recompute them once per property
   * on every render.
   */
  const rows = $derived.by(() => {
    const block = inspection?.block;
    if (block === undefined) return [];
    return propertyRows(block, inspection?.properties ?? {}, legacy);
  });

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

    {#if rows.length > 0}
      <div class="field">
        <label for="props">{t("inspector.blockStates")}</label>
        <ul id="props" class="props">
          {#each rows as row (row.name)}
            <li>
              <span class="key" class:unset={row.value === null}>{row.name}</span>
              <input
                value={row.value ?? ""}
                placeholder={row.value === null ? t("inspector.unset") : undefined}
                list={row.values ? `values-${row.name}` : undefined}
                disabled={busy}
                spellcheck="false"
                onchange={(event) => onchangeproperty(row.name, event.currentTarget.value)}
              />
              <!--
                Only on a row that has something to remove. The column is a
                fixed width either way, so the fields stay lined up rather than
                each row sizing itself from whether it happens to be set.
              -->
              {#if row.value !== null}
                <button
                  class="remove"
                  disabled={busy}
                  title={t("inspector.removeProperty", { name: row.name })}
                  aria-label={t("inspector.removeProperty", { name: row.name })}
                  onclick={() => onchangeproperty(row.name, "")}
                >
                  ×
                </button>
              {/if}
              {#if row.values}
                <datalist id={`values-${row.name}`}>
                  {#each row.values as option (option)}
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
    /* Three columns, the last a fixed width: the remove button is only drawn on
       a row that carries something, and a column that sized itself to its
       contents would make every set row's field narrower than the rest. */
    grid-template-columns: minmax(70px, 34%) 1fr 18px;
    align-items: center;
    gap: 8px;
    padding: 2px 0;
  }

  /* A property the block can hold and does not. Present, nameable, and visibly
     not part of the block yet. */
  .key.unset {
    opacity: 0.55;
  }

  .props li button.remove {
    background: none;
    border: none;
    padding: 0;
    width: 18px;
    line-height: 1;
    font-size: 15px;
    color: var(--text-dim);
    cursor: pointer;
  }

  .props li button.remove:hover:not(:disabled) {
    color: var(--text);
  }

  .props li button.remove:disabled {
    cursor: default;
    opacity: 0.4;
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
