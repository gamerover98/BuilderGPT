/**
 * Turning one schematic file into another, without opening it.
 *
 * "Convert" already existed as a gesture -- open the file, Save As in the other
 * container -- and it went through the open document, which is wrong twice.
 * It costs the user their unsaved work if they had any, and it has no answer at
 * all for `.mcfunction`, which is read but never *becomes* the document's
 * format. So this is a verb of its own: a file goes in, a file comes out, and
 * whatever is open is untouched.
 *
 * There is no format code here and that is the point. It loads with
 * `loadStructure`, builds a document with `documentFromLoaded`, and writes with
 * `writeDocument` or `buildMcfunction` -- every one of which is the same path
 * the editor uses, so a conversion cannot be right in a way that opening the
 * file is not.
 *
 * ## It never overwrites
 *
 * A file already at the destination is moved aside under a timestamp, through
 * `resolveOutputPath`. That is `save_document_as`'s rule and it is here for the
 * same reason: this verb is reachable by an agent, and an agent that guesses a
 * path badly should cost a rename rather than somebody's build.
 *
 * ## It does not crop
 *
 * `saveSession` trims to content, because saving is the end of an editing
 * session and the room you made to build in is not part of the build. A
 * conversion is not an editing session: the size is a property of the file
 * being converted, and quietly returning a smaller one would make the two files
 * disagree about what the schematic is.
 */

import { mkdir, writeFile } from "fs/promises";
import path from "path";

import { documentFromLoaded, documentSize, countBlocks } from "../domain/document.js";
import { isMcfunctionPath, loadStructure, type FileKind } from "../pipeline/loader.js";
import { schematicExtension, type SchematicFormat } from "../../shared/schematic.js";
import { dataVersionOf, mcVersion, refusalFor } from "../../shared/mc_versions.js";
import { resolveOutputPath } from "./output.js";
import { writeDocument } from "./writers.js";
import { saveMcfunction } from "./mcfunction_writer.js";

export class ConvertError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConvertError";
  }
}

export interface ConvertOptions {
  /** The file to read. Any format the app can open, `.mcfunction` included. */
  readonly source: string;
  /** Where to write. The extension is replaced with the format's own. */
  readonly target: string;
  readonly format: FileKind;
  /**
   * The Minecraft version to stamp, by name (`JE_1_20_4`).
   *
   * Omitted keeps whatever the source carried, which is what a conversion
   * usually wants. Named rather than sent as a DataVersion so a container that
   * cannot carry the version can be refused by name -- the same reason
   * `SaveRequest` carries it that way.
   */
  readonly version?: string;
  /** Only for `.mcfunction`: the datapack namespace the dispatcher names. */
  readonly namespace?: string;
  /** Required to write MCEdit, and to read one. */
  readonly legacyBlocksPath?: string | null;
}

export interface ConvertResult {
  readonly format: FileKind;
  /** Every file written, in order; a `.mcfunction` may be several. */
  readonly files: readonly string[];
  /** Anything moved aside to make room, so the answer can say so. */
  readonly backedUp: readonly string[];
  readonly size: readonly [number, number, number];
  readonly blocks: number;
  /** Blocks whose exact state the container could not carry. */
  readonly degraded: readonly string[];
  /** What the container could not carry at all, by name. */
  readonly dropped: readonly string[];
  /** What the *reader* had to say, which only a `.mcfunction` ever fills. */
  readonly notes: readonly string[];
}

/** The extension a kind is written under, `.mcfunction` included. */
export function extensionForKind(kind: FileKind): string {
  return kind === "mcfunction" ? "mcfunction" : schematicExtension(kind);
}

export async function convertFile(options: ConvertOptions): Promise<ConvertResult> {
  const loaded = await loadStructure(options.source, {
    legacyBlocksPath: options.legacyBlocksPath ?? null,
  });
  const doc = documentFromLoaded(loaded, null);

  if (options.version !== undefined) {
    /*
     * Refused before anything is written, and by the same function the format
     * picker asks. A container that cannot express a version is not a setting
     * away from working, so the sentence says which way to move rather than
     * "not available".
     */
    if (options.format !== "mcfunction") {
      const refusal = refusalFor(options.format as SchematicFormat, options.version);
      if (refusal !== null) throw new ConvertError(refusal);
    }
    const dataVersion = dataVersionOf(options.version);
    if (dataVersion === null && mcVersion(options.version) === undefined) {
      throw new ConvertError(`${options.version} is not a Minecraft version this build knows`);
    }
    doc.dataVersion = dataVersion;
  }

  const directory = path.dirname(options.target);
  const extension = extensionForKind(options.format);
  const stem = path.basename(options.target).replace(/\.[^.]*$/, "");
  await mkdir(directory, { recursive: true });

  const files: string[] = [];
  const backedUp: string[] = [];

  if (options.format === "mcfunction") {
    const built = await saveMcfunction(
      doc,
      path.join(directory, `${stem}.mcfunction`),
      options.namespace === undefined ? {} : { namespace: options.namespace },
    );
    return {
      format: options.format,
      files: built.written ?? [],
      backedUp: built.backedUp ?? [],
      size: documentSize(doc),
      blocks: countBlocks(doc),
      degraded: [],
      dropped: built.dropped,
      notes: loaded.notes,
    };
  }

  const written = await writeDocument(doc, {
    format: options.format,
    legacyBlocksPath: options.legacyBlocksPath ?? null,
  });
  const reserved = await resolveOutputPath(directory, stem, extension);
  await writeFile(reserved.filePath, written.bytes);
  files.push(reserved.filePath);
  if (reserved.backedUpTo !== null) backedUp.push(reserved.backedUpTo);

  return {
    format: options.format,
    files,
    backedUp,
    size: documentSize(doc),
    blocks: countBlocks(doc),
    degraded: written.degraded,
    dropped: written.dropped,
    notes: loaded.notes,
  };
}

/** Whether a path is one this can read at all, for a dialog's filter. */
export function isConvertibleSource(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    isMcfunctionPath(lower) ||
    lower.endsWith(".schem") ||
    lower.endsWith(".schematic") ||
    lower.endsWith(".litematic")
  );
}
