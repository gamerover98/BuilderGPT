/**
 * What the agent is allowed to do to a schematic.
 *
 * The boundary the plan asks for: the model never touches the document. It
 * calls these, they call the domain, and the domain validates and records. So
 * "the AI edited my build" and "I edited my build" are the same kind of event,
 * on the same undo stack, with the same guarantees.
 *
 * ## Two kinds of tool, on purpose
 *
 * Fine-grained tools (`fill_region`, `replace_blocks`) are right for edits:
 * targeted, inspectable, cheap to describe. But they are a terrible way to
 * *build* — a twenty-block tower is twenty lines of JavaScript and four hundred
 * tool calls. So `run_build_script` keeps the original app's approach as one
 * tool: the model writes a build script, it runs in the same QuickJS sandbox
 * that has always run generated code, and its placements land in the same
 * transaction as everything else.
 *
 * ## Schemas without a new dependency
 *
 * Plain JSON Schema, handed to `jsonSchema()` from `ai` rather than written in
 * zod. Zod is in the tree already, but only as a transitive dependency of `ai`,
 * and reaching into one of those directly is how a minor version bump becomes a
 * build break. The schemas here are half a dozen flat objects; they do not need
 * a DSL.
 *
 * Every `run` re-checks what it was handed anyway. The arguments come from a
 * language model, which is exactly the position `normalizeBlock` is in at the
 * sandbox bridge: a schema is a request, not a guarantee.
 *
 * ## Declared once, consumed twice
 *
 * `TOOL_SPECS` is the definition; `buildTools` derives the `ai` package's
 * `Tool` objects for the in-app agent, and `mcp/tools.ts` reads the same array
 * to serve `tools/list` and `tools/call` over MCP. Keeping one definition is
 * not tidiness -- two places deciding what `fill_region` means is how you get a
 * tool that works in the chat and not over MCP, the same failure `resolveModel`
 * is exported to prevent.
 *
 * It also has to be readable with **no document open**: `tools/list` is
 * answered before any schematic exists, which is why the context is an argument
 * to `run` rather than something the array is built from.
 */

import { jsonSchema, tool, type Tool } from "ai";

import { FILE_KINDS, FILE_KIND_LABEL, type FileKind } from "../../shared/ipc.js";
import { convertFile } from "../services/convert.js";

interface ConvertArgs {
  source?: string;
  target?: string;
  format?: FileKind;
  version?: string;
  namespace?: string;
}

import {
  countBlocks,
  getBlock,
  normalizeRegion,
  paletteHistogram,
  regionVolume,
  type Region,
  type SchematicDocument,
} from "../domain/document.js";
import type { TransactionScope } from "../domain/history.js";
import {
  applyRegionTransform,
  describeTransform,
  NotSquareError,
  type RegionTransform,
} from "../domain/transform.js";
import { executeJsBuild } from "../core.js";
import { loadLegacyBlockTable, parsePaletteEntry } from "../pipeline/loader_formats.js";
import { legacyBlockNames } from "../services/writers.js";
import {
  buildLegacyIndex,
  legacyIdLabel,
  type LegacyIndex,
} from "../../shared/legacy_ids.js";
import {
  documentEra,
  documentVersionName,
  mcVersion,
} from "../../shared/mc_versions.js";
import { paletteEntryCacheKey, type PaletteEntry } from "../pipeline/types.js";
import { MAX_DOCUMENT_VOLUME, MAX_EDIT_VOLUME } from "../services/session.js";
import { orderRegion } from "../domain/grow.js";
import {
  defaultStateFor,
  isKnownBlock,
  legalValuesFor,
  propertiesOf,
} from "../../shared/block_states.js";
import { describeProperty } from "../../shared/block_properties.js";

/**
 * The model names a turn or a reflection with two optional fields rather than a
 * tagged union, because a union of objects is the shape tool schemas describe
 * worst and models fill in least reliably.
 */
function toTransform(args: { rotate?: number; mirror?: string }): RegionTransform {
  if (args.mirror !== undefined) {
    const axis = String(args.mirror).toLowerCase();
    if (axis !== "x" && axis !== "z") {
      throw new Error(`mirror must be "x" or "z", not "${args.mirror}".`);
    }
    return { kind: "mirror", axis };
  }
  const steps = Number(args.rotate);
  if (!Number.isInteger(steps) || steps < 0 || steps > 3) {
    throw new Error("Pass rotate as 1, 2 or 3 quarter turns, or mirror as \"x\" or \"z\".");
  }
  return { kind: "rotate", steps: steps as 0 | 1 | 2 | 3 };
}

/** Cap on how much of the grid one `get_region` may return. */
const MAX_REPORTED_BLOCKS = 2048;

/**
 * How many blocks one `describe_block` may ask about.
 *
 * A batch rather than one at a time because the question arrives in batches:
 * anyone about to build a house wants the stairs, the slab, the door and the
 * campfire before they start, and four round trips to learn four property lists
 * is four chances to give up and guess instead.
 */
const MAX_DESCRIBED_BLOCKS = 16;

const regionSchema = {
  type: "object",
  properties: {
    minX: { type: "integer" },
    minY: { type: "integer" },
    minZ: { type: "integer" },
    maxX: { type: "integer" },
    maxY: { type: "integer" },
    maxZ: { type: "integer" },
  },
  required: ["minX", "minY", "minZ", "maxX", "maxY", "maxZ"],
  additionalProperties: false,
} as const;

interface RegionArgs {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

/** Parses `minecraft:oak_stairs[facing=north]`, the spelling used everywhere. */
function toEntry(block: string): PaletteEntry {
  const trimmed = String(block ?? "").trim();
  if (trimmed === "") {
    throw new Error("a block id is required");
  }
  return parsePaletteEntry(trimmed.includes(":") ? trimmed : `minecraft:${trimmed}`);
}

/**
 * The same id, in the state the game would give a block placed just now.
 *
 * ## Why a second function rather than a flag on the first
 *
 * Because half the callers are not placing anything. `replace_blocks` reads
 * `from` as a **pattern**: `tx.replace` matches a palette entry exactly, so a
 * default written onto it turns "take out the campfires" into "take out the
 * campfires that happen to face north, are lit, and are not signal fires" --
 * which finds a fraction of them and reports a cheerful `changed` count for the
 * ones it did find. That is the failure `replace_blocks`'s own `note` already
 * warns about, arriving this time as the fix for a different bug.
 *
 * So the two are named for what they are: one parses, one places.
 *
 * ## Why it is needed at all
 *
 * `placementState` has been doing this since the generated table landed, and it
 * is called in exactly one place -- `App.svelte`, at the click. Every other way
 * a block gets written named it and stopped: an MCP client, the in-app agent
 * and a build script all interned `minecraft:campfire` with an empty property
 * bag. Nothing here notices -- the writers write what they are given and the
 * mesher ignores what it does not recognise -- and the file then reaches a game
 * that fills the gaps with its own defaults, so the bug is invisible until
 * somebody opens the inspector to change one and finds nothing to change.
 *
 * The explicit properties go **over** the defaults, for `placementState`'s
 * reason: `minecraft:campfire[lit=false]` is an instruction and this is only a
 * birth state.
 *
 * There is no orientation half here and there must not be. `orientPlacement`
 * asks where the camera was looking, and a tool call has no camera.
 *
 * One consequence worth knowing: writing more properties changes what the
 * MCEdit writer can match exactly, and so what it reports as `degraded`. That
 * is already why `waterlogged` is left out of the defaults -- see
 * `shared/block_states.ts` -- so this inherits that policy rather than opening
 * a second one.
 */
/**
 * The legacy index, memoised on the table it came from.
 *
 * `buildLegacyIndex` walks 1,682 rows, and `describe_block` may be called once
 * per block in a batch. `loadLegacyBlockTable` already hands back the same
 * object every time, which is what makes identity a sound key here.
 */
/** `"35:14"`, or `null` for a block the pre-Flattening game never had. */
function legacyIdOf(index: LegacyIndex | null, name: string): string | null {
  if (index === null) return null;
  const found = index.byName.get(name);
  return found === undefined ? null : legacyIdLabel(found);
}

let cachedIdIndex: { table: object; index: LegacyIndex } | null = null;
function legacyIdIndex(table: Readonly<Record<string, string>>): LegacyIndex {
  if (cachedIdIndex !== null && cachedIdIndex.table === table) return cachedIdIndex.index;
  const index = buildLegacyIndex(table);
  cachedIdIndex = { table, index };
  return index;
}

/**
 * How to say this document's Minecraft version to a model.
 *
 * A label rather than the raw `DataVersion`, because 1343 is not something a
 * model can reason about and "1.12.2" is. `documentVersionName` falls back
 * inside the document's own era, so a legacy file that names no version still
 * gets a legacy answer rather than a flat one.
 */
function versionLabel(doc: SchematicDocument): string {
  const name = documentVersionName(doc.format, doc.dataVersion);
  return (name === null ? null : mcVersion(name)?.label) ?? "an unstated version";
}

function toPlacedEntry(block: string): PaletteEntry {
  const entry = toEntry(block);
  return {
    namespacedName: entry.namespacedName,
    properties: { ...defaultStateFor(entry.namespacedName), ...entry.properties },
  };
}

export interface ToolContext {
  doc: SchematicDocument;
  tx: TransactionScope;
  /** The user's current selection, when they have one. */
  selection: Region | null;
  allowedBlocks: ReadonlySet<string>;
  /**
   * Called for each tool invocation, so the UI can narrate progress.
   *
   * `id` is the SDK's `toolCallId`, which is what ties this readable line to
   * the row the trace opened when the call was announced. Matching on the
   * tool's *name* would do right up until a model issues two `fill_region`s
   * in one step, which it does whenever it builds two walls.
   */
  onStep?: (step: { tool: string; summary: string; id?: string }) => void;
  /**
   * Where `legacy_blocks.json` is, for the one tool that reads and writes
   * files rather than the open document.
   *
   * Passed in rather than resolved here for `LoadStructureOptions`' reason:
   * `services/resources.ts` imports Electron, and this module has to stay
   * reachable from the suites. `null` means MCEdit is simply not available,
   * which `convert_schematic` reports by name rather than by crashing.
   */
  legacyBlocksPath?: string | null;
}

/**
 * The region a tool should act on.
 *
 * Omitting it means "the selection", which is what makes "replace the
 * cobblestone with stone" work without the model having to restate
 * coordinates it was already told. With neither, the whole document.
 */
/**
 * The region a tool acted on, and what had to happen to get there.
 *
 * The two notes exist because both used to be silent, and both produced a
 * result that looked like success:
 *
 * - **Clamping.** `normalizeRegion` trims a region to the document, so a fill
 *   asked for above the ceiling quietly became a fill *at* the ceiling and
 *   reported a cheerful `changed` count. The model has no way to notice that
 *   the thing it built is not where it put it.
 * - **Leaving the selection.** A tool given explicit coordinates may name
 *   anything, which is deliberate -- "replace all the cobblestone everywhere"
 *   is a real request. But an edit that quietly reached 708 cells outside the
 *   selection it was told to default to is how a whole structure gets rewritten
 *   while the summary says `changed: 868` and nothing else.
 */
interface ResolvedRegion {
  region: Region;
  /** Set when the region asked for reached outside the document. */
  clamped?: string;
  /** Set when the region acted on cells the user had not selected. */
  outsideSelection?: string;
}

function overlapVolume(a: Region, b: Region): number {
  const span = (aMin: number, aMax: number, bMin: number, bMax: number) =>
    Math.max(0, Math.min(aMax, bMax) - Math.max(aMin, bMin) + 1);
  return (
    span(a.minX, a.maxX, b.minX, b.maxX) *
    span(a.minY, a.maxY, b.minY, b.maxY) *
    span(a.minZ, a.maxZ, b.minZ, b.maxZ)
  );
}

function resolveRegion(context: ToolContext, args: Partial<RegionArgs>): ResolvedRegion {
  const { doc, selection } = context;
  const hasExplicit =
    typeof args.minX === "number" &&
    typeof args.minY === "number" &&
    typeof args.minZ === "number" &&
    typeof args.maxX === "number" &&
    typeof args.maxY === "number" &&
    typeof args.maxZ === "number";

  if (!hasExplicit) {
    // Omitting the region means "the selection", which is what makes "replace
    // the cobblestone with stone" work without restating coordinates. With
    // neither, the whole document.
    const whole = {
      minX: 0,
      minY: 0,
      minZ: 0,
      maxX: doc.width - 1,
      maxY: doc.height - 1,
      maxZ: doc.length - 1,
    };
    return { region: normalizeRegion(doc, selection ?? whole) };
  }

  const asked = orderRegion(args as RegionArgs);
  const region = normalizeRegion(doc, asked);

  const resolved: ResolvedRegion = { region };
  if (
    asked.minX < 0 ||
    asked.minY < 0 ||
    asked.minZ < 0 ||
    asked.maxX > doc.width - 1 ||
    asked.maxY > doc.height - 1 ||
    asked.maxZ > doc.length - 1
  ) {
    resolved.clamped =
      `The region you gave reaches outside the schematic, which is ${doc.width}x${doc.height}x${doc.length} ` +
      `(x 0-${doc.width - 1}, y 0-${doc.height - 1}, z 0-${doc.length - 1}). It was trimmed to ` +
      `${describeRegion(region)}. Use resize_document first if you need the room.`;
  }
  if (selection) {
    const inSelection = overlapVolume(region, normalizeRegion(doc, selection));
    const outside = regionVolume(region) - inSelection;
    if (outside > 0) {
      resolved.outsideSelection =
        `${outside.toLocaleString()} of the ${regionVolume(region).toLocaleString()} cells this touched are ` +
        `outside the user's selection. Say so in your answer, or narrow the region.`;
    }
  }
  return resolved;
}

/**
 * Whether a model may write this block into the open document.
 *
 * Two questions, and they fail for different reasons and want different
 * sentences. **Can this app place it at all** is the registry, and a failure
 * there is a typo. **Can this schematic hold it** is the version, and a
 * failure there is a block that exists in Minecraft but not in the one this
 * file is for -- `minecraft:deepslate` in a 1.12 schematic. Telling a model
 * "check the spelling" about a correctly spelled block sends it round a loop
 * it cannot get out of.
 *
 * The version half only ever restricts a *legacy* document, from the same
 * table `buildMcEdit` decides the save on. There is no equivalent data for the
 * flat era, and inventing it would refuse blocks that do exist.
 *
 * Async because the table is read from disk. It is memoised, so this costs a
 * map lookup after the first call in a session.
 */
async function checkBlockAllowed(context: ToolContext, entry: PaletteEntry): Promise<void> {
  if (!context.allowedBlocks.has(entry.namespacedName)) {
    // Named, not silently swapped for stone: the model can correct a typo or
    // choose something else, but only if it is told.
    throw new Error(
      `${entry.namespacedName} is not a block this app can place. ` +
        `Use get_palette to see what the schematic already uses.`,
    );
  }
  if (entry.namespacedName === "minecraft:air") return;

  const { format, dataVersion } = context.doc;
  if (documentEra(format, dataVersion) !== "legacy") return;
  const tablePath = context.legacyBlocksPath;
  // No table, no claim. Refusing everything because a resource is missing
  // would be worse than the problem it guards against.
  if (tablePath === undefined || tablePath === null) return;

  const names = legacyBlockNames(await loadLegacyBlockTable(tablePath));
  if (names.has(entry.namespacedName)) return;
  const name = documentVersionName(format, dataVersion);
  const label = (name === null ? null : mcVersion(name)?.label) ?? "this version";
  throw new Error(
    `${entry.namespacedName} does not exist in Minecraft ${label}, which is what ` +
      `this schematic is for. Before 1.13 blocks were numeric ids and the set is ` +
      `much smaller. Use get_schematic_info to see the version, get_palette to ` +
      `see what this schematic already uses, or ask the user to change the ` +
      `schematic's Minecraft version.`,
  );
}

function describeRegion(region: Region): string {
  return `(${region.minX},${region.minY},${region.minZ})-(${region.maxX},${region.maxY},${region.maxZ})`;
}

/**
 * A tool's own phrasing of what it just did.
 *
 * A free function rather than a closure over the context, because the bodies
 * below are now `ToolSpec.run` and take their context as an argument -- which
 * is what lets `TOOL_SPECS` be read with no document open at all.
 */
function step(context: ToolContext, tool: string, summary: string, id: string): void {
  context.onStep?.({ tool, summary, id });
}

/**
 * One tool, declared once.
 *
 * `buildTools` turns these into the `ai` package's `Tool` objects for the
 * in-app agent, and `mcp/tools.ts` reads the same array to answer `tools/list`
 * over MCP. Two consumers, one definition: two places deciding what
 * `fill_region` means is how you get something that works in the chat and not
 * over MCP, which is the same argument `resolveModel` is exported for.
 *
 * `schema` is plain JSON Schema because that is what MCP puts on the wire and
 * what `jsonSchema()` wants anyway -- so neither consumer has to translate, and
 * zod stays out of this file for the reason given at the top.
 *
 * `run` is declared as a *method* rather than a property on purpose:
 * TypeScript checks method parameters bivariantly, so each spec below can
 * annotate `args` with the shape its schema describes while the array stays
 * one type. That the annotation is a claim rather than a guarantee is the
 * point made at the top of this file -- every body re-checks what it was
 * handed, because the arguments come from a language model.
 */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly schema: Record<string, unknown>;
  run(context: ToolContext, args: unknown, id: string): Promise<unknown>;
}

export const TOOL_SPECS: readonly ToolSpec[] = [
  {
    /**
     * The second tool here that is not about the open document, and the first
     * that writes anything outside it.
     *
     * It exists because "convert this file" had no answer that did not go
     * through the editor: opening a file and saving it in another container
     * costs the user whatever they had open, and `.mcfunction` cannot be a
     * document's format at all, so there was nothing to save *as*.
     *
     * In `TOOL_SPECS` rather than in MCP's own table so the chat and an
     * external client get the same tool from one definition -- the rule
     * `tests/mcp.ts` states from both sides. It reads no document, which is
     * what `NO_DOCUMENT` in `mcp/tools.ts` is for.
     */
    name: "convert_schematic",
    description:
      "Convert a schematic file on disk into another format, without opening it. Reads .schem (Sponge v2 and v3), .schematic (MCEdit), .litematic and .mcfunction, and writes any of them. The open document is untouched, and an existing file at the destination is moved aside with a timestamp rather than overwritten. A .mcfunction may come out as several files with a dispatcher.",
    schema: {
      type: "object",
      properties: {
        source: { type: "string" },
        target: { type: "string" },
        format: {
          type: "string",
          enum: ["sponge3", "sponge2", "mcedit", "litematic", "mcfunction"],
        },
        version: { type: "string" },
        namespace: { type: "string" },
      },
      required: ["source", "target", "format"],
      additionalProperties: false,
    },
    async run(context, args: ConvertArgs, id) {
      const source = typeof args?.source === "string" ? args.source : "";
      const target = typeof args?.target === "string" ? args.target : "";
      const format = args?.format;
      if (source === "" || target === "") {
        throw new Error("Pass both `source` and `target` as file paths.");
      }
      if (format === undefined || !FILE_KINDS.includes(format)) {
        throw new Error(`\`format\` must be one of ${FILE_KINDS.join(", ")}.`);
      }
      step(context, "convert_schematic", `converting to ${FILE_KIND_LABEL[format]}`, id);

      const result = await convertFile({
        source,
        target,
        format,
        ...(typeof args.version === "string" ? { version: args.version } : {}),
        ...(typeof args.namespace === "string" ? { namespace: args.namespace } : {}),
        legacyBlocksPath: context.legacyBlocksPath ?? null,
      });
      return {
        files: result.files,
        format: result.format,
        size: result.size,
        blocks: result.blocks,
        backedUp: result.backedUp,
        degraded: result.degraded,
        dropped: result.dropped,
        notes: result.notes,
      };
    },
  },
  {
    name: "get_schematic_info",
    description:
      "Size, block count, container format and **Minecraft version** of the schematic " +
      "being edited, plus the user's current selection if they have one. Call this " +
      "first: the version decides which blocks may be placed at all, and before 1.13 " +
      "that set is much smaller than the modern one.",
    schema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async run(context, _args: Record<string, never>, id) {
      step(context, "get_schematic_info", "reading the schematic's dimensions", id);
      const { doc, selection } = context;
      return {
        width: doc.width,
        height: doc.height,
        length: doc.length,
        blockCount: countBlocks(doc),
        format: doc.format,
        /*
         * The version, said three ways, because the model needs a different one
         * for each job: `era` decides which blocks it may place, `version` is
         * what a person calls it, and `dataVersion` is the raw tag -- `null`
         * when the file carries none, which MCEdit never does.
         *
         * None of this was reported before. The model was told the container and
         * not the version, so on a 1.12 schematic it placed modern blocks all
         * turn and met the objection at save time, from a writer, about blocks
         * it had long since built around.
         */
        dataVersion: doc.dataVersion,
        version: versionLabel(doc),
        era: documentEra(doc.format, doc.dataVersion),
        blocks:
          documentEra(doc.format, doc.dataVersion) === "legacy"
            ? `This schematic is for Minecraft ${versionLabel(doc)}, which is before the ` +
              `Flattening. Blocks are stored as numeric id:data pairs there, so only the ` +
              `few hundred that existed then can be placed -- minecraft:deepslate and ` +
              `anything else added in 1.13 or later will be refused by name. Name blocks ` +
              `the modern way anyway (minecraft:oak_fence); the conversion is this app's ` +
              `job. describe_block says whether one exists here.`
            : `This schematic is for Minecraft ${versionLabel(doc)}. Blocks are named the ` +
              `flattened way, minecraft:oak_stairs[facing=north].`,
        coordinates:
          "x is 0..width-1, y is 0..height-1 (y up), z is 0..length-1. All coordinates are inclusive.",
        selection: selection ? normalizeRegion(doc, selection) : null,
      };
    },
  },

  {
    name: "get_palette",
    description:
      "Which blocks the schematic contains and how many of each. Use this before replacing a block, to find how it is actually spelled.",
    schema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async run(context, _args: Record<string, never>, id) {
      step(context, "get_palette", "listing the materials in use", id);
      const entries = [...paletteHistogram(context.doc).entries()]
        .filter(([block]) => !block.startsWith("minecraft:air"))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 128)
        .map(([block, count]) => ({ block, count }));
      return { blocks: entries };
    },
  },

  {
    /*
     * The one tool here that is not about the open schematic.
     *
     * ## Why it exists
     *
     * Everything else in this table answers a question about *this* build.
     * This one answers a question about Minecraft, and without it the model had
     * to already know the answer. A block state is the part of a block that is
     * not its name -- `facing`, `half`, `lit`, `signal_fire` -- and nothing in
     * this app validates a property name: the writers write what they are
     * given and the mesher ignores what it does not recognise. So a guess
     * costs nothing *here* and produces a schematic that behaves differently
     * in the game, a long way from anyone who could connect the two.
     *
     * The failure it was built for is quieter than a wrong guess, though. A
     * model that names no properties at all gets a block in its default state,
     * which looks right -- and then whoever opens the inspector to change the
     * direction of that campfire finds a panel with nothing in it, because
     * until `toPlacedEntry` the block was interned bare.
     *
     * ## Why the answer includes `placedAs`
     *
     * It is the question underneath the question. "What properties does a
     * campfire have" is asked in order to find out what will actually be
     * written, and that is one string. It is built by `toPlacedEntry` -- the
     * same function `set_block` uses, not a description of it -- so it cannot
     * drift from what a placement really does.
     */
    name: "describe_block",
    description:
      "What block states a block has, what values each one takes, what it means, and what state the block will actually be written in if you name none. Ask before placing anything with a direction, a shape or an on/off state — stairs, doors, slabs, trapdoors, campfires, buttons, walls — rather than guessing property names. Values are written inside the id, as minecraft:campfire[lit=false].",
    schema: {
      type: "object",
      properties: {
        blocks: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: MAX_DESCRIBED_BLOCKS,
        },
      },
      required: ["blocks"],
      additionalProperties: false,
    },
    async run(context, args: { blocks: string[] }, id) {
      const asked = Array.isArray(args?.blocks) ? args.blocks : [];
      if (asked.length === 0) {
        throw new Error("Pass one or more block ids in `blocks`.");
      }
      if (asked.length > MAX_DESCRIBED_BLOCKS) {
        throw new Error(
          `Ask about at most ${MAX_DESCRIBED_BLOCKS} blocks at a time; you asked about ${asked.length}.`,
        );
      }
      step(
        context,
        "describe_block",
        asked.length === 1
          ? `looking up ${String(asked[0])}`
          : `looking up ${asked.length} block states`,
        id,
      );

      /*
       * The pre-Flattening table, when this build can reach it. `null` means
       * the answer is simply not offered -- better than claiming every block is
       * modern because a resource file could not be read.
       */
      const legacy =
        context.legacyBlocksPath === undefined || context.legacyBlocksPath === null
          ? null
          : legacyIdIndex(await loadLegacyBlockTable(context.legacyBlocksPath));
      const blocks = asked.map((each) => {
        // Deliberately not `toPlacedEntry` for the *name*: an id the caller
        // spelled with states already is still a question about the block, and
        // stripping them is what lets `minecraft:oak_stairs[facing=east]` be
        // asked about at all.
        const entry = toEntry(each);
        const name = entry.namespacedName;
        const placed = toPlacedEntry(name);

        const properties = propertiesOf(name).map((property) => {
          const values = legalValuesFor(name, property) ?? [];
          const doc = describeProperty(property, values);
          const fallback = placed.properties[property];
          return {
            name: property,
            values,
            /*
             * `null` rather than a value when the property is legal but is not
             * written on a new block. `waterlogged` is the whole of that set
             * today, and saying "default: false" for it would contradict
             * `placedAs`, which does not carry it -- see `block_states.ts` for
             * why it is left out.
             */
            default: fallback ?? null,
            description: doc?.description ?? null,
            ...(doc?.versions ? { versions: doc.versions } : {}),
            ...(fallback === undefined
              ? {
                  note:
                    "Legal, but not written on a newly placed block. Name it explicitly if you want it.",
                }
              : {}),
          };
        });

        return {
          block: name,
          // Two different questions, and a block can fail either alone. A
          // pre-Flattening spelling like `minecraft:grass` is placeable and has
          // no entry in the state registry; a misspelling has neither.
          placeable: context.allowedBlocks.has(name),
          known: isKnownBlock(name),
          /*
           * What this block was before the Flattening, or `null` if it was
           * nothing -- which is the same as saying it did not exist yet.
           *
           * The era question, asked in the only way this tool is allowed to ask
           * it. `describe_block` is in `NO_DOCUMENT`: it is answered before any
           * schematic exists and its `doc` is a proxy that throws on every read,
           * so it cannot say whether *this* document can hold the block. It can
           * say whether Minecraft ever could before 1.13, which is a fact about
           * the game and is what the question is really after.
           */
          legacyId: legacyIdOf(legacy, name),
          placedAs: paletteEntryCacheKey(placed),
          properties,
          note: !context.allowedBlocks.has(name)
            ? "This app cannot place that block — check the spelling."
            : properties.length === 0
              ? isKnownBlock(name)
                ? "This block has no block states. Place it by name."
                : "The state registry does not know this block, which is normal for a pre-Flattening spelling. It is placed exactly as named."
              : undefined,
        };
      });

      return {
        blocks,
        spelling:
          "Pass states inside the id: minecraft:oak_stairs[facing=east,half=top]. Anything you leave out is written at the value shown in placedAs.",
      };
    },
  },

  {
    name: "get_region",
    description:
      "The blocks in a region, as a list of coordinates and block ids. Air is omitted. Defaults to the user's selection. Refuses regions too large to describe — narrow it, or use get_palette for an overview.",
    schema: {
      type: "object",
      properties: regionSchema.properties,
      additionalProperties: false,
    },
    async run(context, args: Partial<RegionArgs>, id) {
      const { region, clamped } = resolveRegion(context, args ?? {});
      step(context, "get_region", `reading ${describeRegion(region)}`, id);
      if (regionVolume(region) > MAX_REPORTED_BLOCKS * 8) {
        throw new Error(
          `That region holds ${regionVolume(region)} cells, too many to list. ` +
            `Ask for a smaller one, or use get_palette for an overview.`,
        );
      }
      const blocks: Array<{ x: number; y: number; z: number; block: string }> = [];
      for (let x = region.minX; x <= region.maxX; x += 1) {
        for (let y = region.minY; y <= region.maxY; y += 1) {
          for (let z = region.minZ; z <= region.maxZ; z += 1) {
            const entry = getBlock(context.doc, x, y, z);
            if (entry.namespacedName === "minecraft:air") continue;
            if (blocks.length >= MAX_REPORTED_BLOCKS) {
              return {
                region,
                blocks,
                truncated: true,
                note: `Stopped at ${MAX_REPORTED_BLOCKS} blocks; the region holds more.`,
              };
            }
            blocks.push({ x, y, z, block: paletteEntryCacheKey(entry) });
          }
        }
      }
      return { region, blocks, truncated: false, clamped };
    },
  },

  {
    name: "fill_region",
    description:
      "Fill a region with one block. Defaults to the user's selection. Use minecraft:air to " +
      "clear. The block has to exist in the schematic's Minecraft version, which " +
      "get_schematic_info reports.",
    schema: {
      type: "object",
      properties: { ...regionSchema.properties, block: { type: "string" } },
      required: ["block"],
      additionalProperties: false,
    },
    async run(context, args: Partial<RegionArgs> & { block: string }, id) {
      const { region, ...notes } = resolveRegion(context, args ?? {});
      const entry = toPlacedEntry(args.block);
      await checkBlockAllowed(context, entry);
      if (regionVolume(region) > MAX_EDIT_VOLUME) {
        throw new Error(`That region covers ${regionVolume(region)} blocks, more than one edit may touch.`);
      }
      step(context, "fill_region", `filling ${describeRegion(region)} with ${entry.namespacedName}`, id);
      return { changed: context.tx.fill(region, entry), region, ...notes };
    },
  },

  {
    name: "replace_blocks",
    description:
      "Replace one block with another inside a region. Defaults to the user's selection. " +
      "Naming `from` without states matches the block in every state it appears in; " +
      "spell the states out to match only that one. get_palette shows what is there.",
    schema: {
      type: "object",
      properties: {
        ...regionSchema.properties,
        from: { type: "string" },
        to: { type: "string" },
      },
      required: ["from", "to"],
      additionalProperties: false,
    },
    async run(context, args: Partial<RegionArgs> & { from: string; to: string }, id) {
      const { region, ...notes } = resolveRegion(context, args ?? {});
      // `from` is a pattern and `to` is a placement -- see `toPlacedEntry`.
      const from = toEntry(args.from);
      const to = toPlacedEntry(args.to);
      await checkBlockAllowed(context, to);
      step(
        context,
        "replace_blocks",
        `replacing ${from.namespacedName} with ${to.namespacedName} in ${describeRegion(region)}`,
        id,
      );
      const changed = context.tx.replace(region, from, to);
      return {
        changed,
        region,
        ...notes,
        /*
         * A zero is the commonest way an edit does nothing, so it is said out
         * loud rather than reported as success.
         *
         * It used to advise checking the spelling *including block states*,
         * which was advice for a rule that no longer holds: a name on its own
         * now matches the block in every state. So a miss means the block is
         * not in the region, and sending the model back to add states would
         * only narrow a search that already found nothing.
         */
        note:
          changed === 0
            ? `Nothing matched ${paletteEntryCacheKey(from)}. A name on its own matches the ` +
              `block in every state, so it is not in this region at all. get_palette shows ` +
              `what the schematic actually contains.`
            : undefined,
      };
    },
  },

  {
    name: "set_block",
    description:
      "Place a single block at one coordinate. The block has to exist in the schematic's " +
      "Minecraft version -- get_schematic_info reports it, and before 1.13 the set is much " +
      "smaller.",
    schema: {
      type: "object",
      properties: {
        x: { type: "integer" },
        y: { type: "integer" },
        z: { type: "integer" },
        block: { type: "string" },
      },
      required: ["x", "y", "z", "block"],
      additionalProperties: false,
    },
    async run(context, args: { x: number; y: number; z: number; block: string }, id) {
      const entry = toPlacedEntry(args.block);
      await checkBlockAllowed(context, entry);
      step(context, "set_block", `placing ${entry.namespacedName} at (${args.x},${args.y},${args.z})`, id);
      const changed = context.tx.setBlock(args.x, args.y, args.z, entry);
      return {
        changed: changed ? 1 : 0,
        note: changed
          ? undefined
          : "Nothing changed — that coordinate is outside the schematic, or already held that block.",
      };
    },
  },

  {
    name: "transform_region",
    description:
      "Rotate or mirror a region in place, carrying block states with it so stairs, logs, doors and signs keep facing the way they should. Defaults to the user's selection. `steps` is quarter turns clockwise seen from above (1 = 90°); a quarter turn needs a region whose x and z extents are equal, a half turn does not.",
    schema: {
      type: "object",
      properties: {
        ...regionSchema.properties,
        rotate: { type: "integer", description: "Quarter turns: 1, 2 or 3." },
        mirror: { type: "string", description: '"x" swaps east and west, "z" north and south.' },
      },
      additionalProperties: false,
    },
    async run(context, args: Partial<RegionArgs> & { rotate?: number; mirror?: string }, id) {
      const { region, ...notes } = resolveRegion(context, args ?? {});
      const transform = toTransform(args ?? {});
      step(context, "transform_region", `${describeTransform(transform).toLowerCase()} on ${describeRegion(region)}`, id);
      // Errors are returned to the model rather than thrown past it — a
      // quarter turn refused for being oblong is something it can correct by
      // squaring the region or turning 180° instead.
      try {
        return {
          changed: applyRegionTransform(context.doc, context.tx, region, transform),
          region,
          ...notes,
        };
      } catch (err) {
        if (err instanceof NotSquareError) {
          throw new Error(err.message);
        }
        throw err;
      }
    },
  },

  {
    name: "resize_document",
    description:
      "Make the schematic bigger. The new room is empty space added at the +x/+y/+z sides, so every existing block and coordinate stays exactly where it is. Use this when what the user asked for does not fit — a roof on a build that already reaches the top needs somewhere to go, and every other tool is trimmed to the current box.",
    schema: {
      type: "object",
      properties: {
        width: { type: "number" },
        height: { type: "number" },
        length: { type: "number" },
      },
      additionalProperties: false,
    },
    async run(context, args: { width?: number; height?: number; length?: number }, id) {
      const { doc } = context;
      const next = {
        width: Math.trunc(args?.width ?? doc.width),
        height: Math.trunc(args?.height ?? doc.height),
        length: Math.trunc(args?.length ?? doc.length),
      };

      /*
       * Growth only, and only at the far side. Two reasons, and neither is
       * timidity:
       *
       * A shrink destroys blocks. The command records them so undo works, but
       * "make it smaller" is not a thing anyone asks an editing agent for --
       * saving already trims to content (`domain/crop.ts`), so the room the
       * user left themselves is deliberate and is not the model's to reclaim.
       *
       * Growing at the far side means no shift, and no shift means every
       * coordinate the model has already been told -- the selection, the
       * palette histogram, whatever it read with get_region -- is still valid
       * afterwards. Room *below* the origin would move all the content up, and
       * the model would be reasoning from coordinates that had silently
       * changed under it.
       */
      const shrinking = (["width", "height", "length"] as const).filter(
        (axis) => next[axis] < doc[axis],
      );
      if (shrinking.length > 0) {
        throw new Error(
          `This tool only makes the schematic bigger, and you asked to shrink ${shrinking.join(" and ")}. ` +
            `Saving already trims the file to its content, so the empty room is the user's to keep.`,
        );
      }
      if (next.width === doc.width && next.height === doc.height && next.length === doc.length) {
        throw new Error("That is the size it already is. Say what you need the extra room for.");
      }

      // The cap that stops the process dying rather than a design limit: the
      // voxels are an Int32Array.
      const volume = next.width * next.height * next.length;
      if (volume > MAX_DOCUMENT_VOLUME) {
        throw new Error(
          `${next.width}x${next.height}x${next.length} is ${volume.toLocaleString()} blocks, past the ` +
            `${MAX_DOCUMENT_VOLUME.toLocaleString()} one schematic may hold. Ask for less.`,
        );
      }

      const was = `${doc.width}x${doc.height}x${doc.length}`;
      step(context, "resize_document", `making room: ${was} to ${next.width}x${next.height}x${next.length}`, id);
      context.tx.resize(next);
      return {
        was,
        now: `${next.width}x${next.height}x${next.length}`,
        note:
          "The new space is empty and sits at the far side, so nothing moved. " +
          "The user's selection still names the same blocks it did before.",
      };
    },
  },

  {
    name: "run_build_script",
    description:
      "Run a JavaScript build script to place many blocks at once. Define `function buildCreation(startX, startY, startZ) {}` and call safeSetBlock(x,y,z,block,options) and safeFill(x1,y1,z1,x2,y2,z2,block,options) inside it. Coordinates are the schematic's own. Far cheaper than hundreds of individual calls — prefer this for anything structural.",
    schema: {
      type: "object",
      properties: { code: { type: "string" } },
      required: ["code"],
      additionalProperties: false,
    },
    async run(context, args: { code: string }, id) {
      step(context, "run_build_script", "running the build script", id);
      // The same sandbox that has always run model-written code: QuickJS on
      // WASM, memory-limited, deadline-interrupted, with nothing bridged in
      // but the two placement callbacks. `tests/sandbox.ts` guards that
      // contract and this tool does not widen it.
      const outcome = await executeJsBuild(String(args.code ?? ""), context.allowedBlocks);
      let changed = 0;
      for (const [x, y, z, blockData] of outcome.placements) {
        // Through `toPlacedEntry` like every other placement: a script that
        // writes `safeSetBlock(x, y, z, "campfire")` means the same thing a
        // `set_block` call does.
        if (context.tx.setBlock(x, y, z, toPlacedEntry(blockData))) {
          changed += 1;
        }
      }
      return {
        changed,
        placements: outcome.placements.length,
        // Surfaced so the model can correct itself rather than wondering why
        // its walls are missing.
        dropped: outcome.rejections.map((r) => ({ block: r.blockId, reason: r.reason, calls: r.calls })),
        note:
          changed === 0 && outcome.placements.length > 0
            ? "The script ran but every placement already matched what was there."
            : undefined,
      };
    },
  },
];

/** The same ten, as the `ai` package wants them. */
export function buildTools(context: ToolContext): Record<string, Tool> {
  const tools: Record<string, Tool> = {};
  for (const spec of TOOL_SPECS) {
    tools[spec.name] = tool({
      description: spec.description,
      inputSchema: jsonSchema(spec.schema as Parameters<typeof jsonSchema>[0]),
      execute: async (args, call) => await spec.run(context, args, call.toolCallId),
    });
  }
  return tools;
}
