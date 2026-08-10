/**
 * `services/autosave.ts` — crash recovery.
 *
 * This is the one feature whose entire value is in the case nobody exercises
 * deliberately, so the suite plays out that case: edit, snapshot, throw the
 * session away as a crash would, and check that what comes back is the work
 * rather than the last save.
 *
 * The things that would quietly ruin it, and are checked here: recovering into
 * the app's own directory instead of the user's file, coming back marked clean
 * so the user closes it again, and offering a stale recovery for work that was
 * in fact saved.
 */

import { mkdtemp, readdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

import { getBlock, type SchematicDocument } from "../src/main/domain/document.js";
import { isDirty } from "../src/main/domain/history.js";
import {
  clearAutosave,
  readAutosave,
  restoreAutosave,
  startAutosave,
  writeAutosave,
} from "../src/main/services/autosave.js";
import {
  applyEdit,
  closeDocument,
  currentSession,
  newDocument,
  openDocument,
  saveSession,
} from "../src/main/services/session.js";
import { SpongeSchematicWriter } from "../src/main/services/schematic.js";
import { dataVersionFor } from "../src/main/services/versions.js";

let failures = 0;

function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  PASS: ${label}`);
  } else {
    console.log(`  FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
    failures += 1;
  }
}

function equal(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    console.log(`         expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  check(label, ok);
}

const stone = { namespacedName: "minecraft:stone" };
const glass = { namespacedName: "minecraft:glass" };

function grid(doc: SchematicDocument): string {
  const out: string[] = [];
  for (let x = 0; x < doc.width; x += 1) {
    for (let y = 0; y < doc.height; y += 1) {
      for (let z = 0; z < doc.length; z += 1) {
        out.push(getBlock(doc, x, y, z).namespacedName);
      }
    }
  }
  return out.join(",");
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

console.log("=== Schematic AI Studio: autosave ===\n");

const workDir = await mkdtemp(path.join(tmpdir(), "bgpt-autosave-"));
const saveDir = path.join(workDir, "documents");
const autoDir = path.join(workDir, "autosave");

try {
  // --- nothing to recover ---------------------------------------------------
  console.log("--- with no snapshot ---");
  {
    check("an empty directory offers nothing", (await readAutosave(autoDir)) === null);
    check("...and restoring from it yields nothing", (await restoreAutosave(autoDir)) === null);
  }

  // --- the crash ------------------------------------------------------------
  //
  // A file saved once, edited again, snapshotted, and then lost.
  console.log("\n--- surviving a crash ---");
  {
    const writer = new SpongeSchematicWriter();
    writer.setBlock([0, 0, 0], "minecraft:cobblestone");
    writer.setBlock([1, 0, 0], "minecraft:cobblestone");
    writer.setBlock([2, 2, 2], "minecraft:oak_planks");
    const filePath = await writer.save(saveDir, "house", dataVersionFor("JE_1_20_4"));

    const session = await openDocument(filePath);
    applyEdit(session, {
      kind: "fill",
      region: { minX: 0, minY: 1, minZ: 0, maxX: 2, maxY: 1, maxZ: 2 },
      block: stone,
    });
    const workInProgress = grid(session.doc);
    check("the document is dirty before the crash", isDirty(session.history));

    await writeAutosave(session.doc, autoDir);

    // The crash: the session simply ceases to exist, with nothing written to
    // the user's file.
    closeDocument();
    check("nothing is open any more", currentSession() === null);

    const offer = await readAutosave(autoDir);
    check("a recovery is offered", offer !== null);
    equal("...naming the file it belongs to", offer?.filePath, filePath);
    equal("...and its display name", offer?.fileName, "house.schem");
    equal("...and its format", offer?.format, "sponge2");
    check("...with a plausible block count", (offer?.blockCount ?? 0) > 3, String(offer?.blockCount));

    const restored = await restoreAutosave(autoDir);
    check("it restores", restored !== null);
    equal("the recovered blocks are the unsaved ones", grid(restored!.doc), workInProgress);
    equal(
      "...not the ones on disk",
      grid(restored!.doc) === grid((await openDocument(filePath)).doc),
      false,
    );

    // The two failures that would make recovery worse than useless.
    equal("the recovered document points at the user's file", restored!.doc.filePath, filePath);
    equal("...in the user's format, not the snapshot's", restored!.doc.format, "sponge2");
    check(
      "...and reads as differing from disk, so it is not closed again unsaved",
      isDirty(restored!.history),
    );

    closeDocument();
    await clearAutosave(autoDir);
    equal("clearing removes both files", (await readdir(autoDir)).length, 0);
  }

  // --- a document that was never saved --------------------------------------
  console.log("\n--- unsaved-from-birth documents ---");
  {
    const session = newDocument({ width: 4, height: 4, length: 4 });
    applyEdit(session, { kind: "setBlock", x: 1, y: 1, z: 1, block: glass });
    await writeAutosave(session.doc, autoDir);
    closeDocument();

    const offer = await readAutosave(autoDir);
    equal("it has no file to point at", offer?.filePath, null);
    equal("...and no name", offer?.fileName, null);

    const restored = await restoreAutosave(autoDir);
    equal("the work is still recovered", getBlock(restored!.doc, 1, 1, 1).namespacedName, "minecraft:glass");
    equal("...with nowhere to save to yet", restored!.doc.filePath, null);
    await clearAutosave(autoDir);
  }

  // --- a corrupt or half-written snapshot -----------------------------------
  //
  // A crash can land between the two writes. That must read as "nothing to
  // recover", not as a recovery that then fails to open.
  console.log("\n--- damaged snapshots ---");
  {
    await rm(autoDir, { recursive: true, force: true });
    const session = newDocument({ width: 2, height: 2, length: 2 });
    applyEdit(session, { kind: "setBlock", x: 0, y: 0, z: 0, block: stone });
    await writeAutosave(session.doc, autoDir);
    closeDocument();

    await writeFile(path.join(autoDir, "autosave.json"), "{ this is not json", "utf-8");
    check("a truncated sidecar offers nothing", (await readAutosave(autoDir)) === null);
    check("...and restores nothing", (await restoreAutosave(autoDir)) === null);

    await rm(path.join(autoDir, "autosave.json"), { force: true });
    check("a snapshot with no sidecar offers nothing", (await readAutosave(autoDir)) === null);
    await clearAutosave(autoDir);
  }

  // --- the timer ------------------------------------------------------------
  //
  // Driven at 60ms rather than the real 20s. What is being checked is the
  // decision it makes, not the interval.
  console.log("\n--- the snapshot timer ---");
  {
    await rm(autoDir, { recursive: true, force: true });
    const stop = startAutosave({
      dir: autoDir,
      getSession: currentSession,
      intervalMs: 60,
      onError: (err) => console.log(`         autosave error: ${String(err)}`),
    });
    try {
      closeDocument();
      await sleep(150);
      check("nothing open means no snapshot", (await readAutosave(autoDir)) === null);

      const session = newDocument({ width: 4, height: 4, length: 4 });
      await sleep(150);
      check("a clean document is not snapshotted either", (await readAutosave(autoDir)) === null);

      applyEdit(session, { kind: "setBlock", x: 2, y: 2, z: 2, block: stone });
      await sleep(200);
      const afterEdit = await readAutosave(autoDir);
      check("an edit produces one", afterEdit !== null);

      // Saving means the work is safe, so a recovery prompt on next launch
      // would be a lie — and a prompt people learn to dismiss unread.
      await saveSession(session, { filePath: path.join(saveDir, "timer.schem") });
      await sleep(200);
      check("saving clears the snapshot", (await readAutosave(autoDir)) === null);
    } finally {
      stop();
      closeDocument();
    }
  }
} finally {
  closeDocument();
  await rm(workDir, { recursive: true, force: true });
}

console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
process.exitCode = failures === 0 ? 0 : 1;
