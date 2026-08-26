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
import { parsePaletteEntry } from "../pipeline/loader_formats.js";
import { paletteEntryCacheKey, type PaletteEntry } from "../pipeline/types.js";
import { MAX_DOCUMENT_VOLUME, MAX_EDIT_VOLUME } from "../services/session.js";
import { orderRegion } from "../domain/grow.js";

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

function checkBlockAllowed(context: ToolContext, entry: PaletteEntry): void {
  if (!context.allowedBlocks.has(entry.namespacedName)) {
    // Named, not silently swapped for stone: the model can correct a typo or
    // choose something else, but only if it is told.
    throw new Error(
      `${entry.namespacedName} is not a block this app can place. ` +
        `Use get_palette to see what the schematic already uses.`,
    );
  }
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
    name: "get_schematic_info",
    description:
      "Size, block count and format of the schematic being edited, plus the user's current selection if they have one. Call this first.",
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
      "Fill a region with one block. Defaults to the user's selection. Use minecraft:air to clear.",
    schema: {
      type: "object",
      properties: { ...regionSchema.properties, block: { type: "string" } },
      required: ["block"],
      additionalProperties: false,
    },
    async run(context, args: Partial<RegionArgs> & { block: string }, id) {
      const { region, ...notes } = resolveRegion(context, args ?? {});
      const entry = toEntry(args.block);
      checkBlockAllowed(context, entry);
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
      "Replace one block with another inside a region. Defaults to the user's selection. Block states must match exactly — check get_palette for the spelling.",
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
      const from = toEntry(args.from);
      const to = toEntry(args.to);
      checkBlockAllowed(context, to);
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
        // A zero here is the single most common way an edit "does nothing":
        // the state string did not match. Say so rather than reporting success.
        note:
          changed === 0
            ? `Nothing matched ${paletteEntryCacheKey(from)}. Check get_palette for the exact spelling, including block states.`
            : undefined,
      };
    },
  },

  {
    name: "set_block",
    description: "Place a single block at one coordinate.",
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
      const entry = toEntry(args.block);
      checkBlockAllowed(context, entry);
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
        if (context.tx.setBlock(x, y, z, parsePaletteEntry(blockData))) {
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

/** The same nine, as the `ai` package wants them. */
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
