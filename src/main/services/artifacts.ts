/**
 * Replaces `cynia_agents.artifact_manager` (component.py:12, 58-59, 147-152,
 * 169-174).
 *
 * `cynia-agents` is a private package with no npm counterpart and no public
 * source; only two of its functions are reachable from this app --
 * `register_artifact_type(name)` and
 * `write_artifact(component, path, description, type)`. The former is a no-op
 * registration whose only observable effect is that the latter accepts the
 * type; the latter records a generated file so the host framework's "Artifact
 * Center" can list it.
 *
 * A standalone Electron app has no Artifact Center, so this is the whole of it:
 * a JSON index next to the generated files. RULEBOOK.md §1's
 * no-equivalent-library rule would normally push this behind a DI seam, but
 * there is no second implementation to choose between and no upstream contract
 * to honour -- the host framework is gone with Streamlit.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";

import { app } from "electron";

import type { Artifact } from "../../shared/ipc.js";
import type { ExportType } from "../../shared/settings.js";
import { describeFor } from "./naming.js";

function indexPath(): string {
  return path.join(app.getPath("userData"), "artifacts.json");
}

async function readIndex(): Promise<Artifact[]> {
  try {
    const text = await readFile(indexPath(), "utf-8");
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? (parsed as Artifact[]) : [];
  } catch (err: unknown) {
    const code = (err as { code?: string } | null)?.code;
    if (code !== "ENOENT" && !(err instanceof SyntaxError)) {
      throw err;
    }
    return [];
  }
}

export async function listArtifacts(): Promise<Artifact[]> {
  const all = await readIndex();
  // Newest first -- the Streamlit Artifact Center listed most-recent-first and
  // that is the only ordering a "what did I just make" panel wants.
  return all.slice().reverse();
}

export async function writeArtifact(entry: {
  filePath: string;
  name: string;
  type: ExportType;
  description: string;
}): Promise<Artifact> {
  const artifact: Artifact = {
    path: entry.filePath,
    name: entry.name,
    type: entry.type,
    description:
      entry.type === "schem"
        ? `Minecraft schematic: ${describeFor(entry.description)}`
        : `Minecraft function: ${describeFor(entry.description)}`,
    createdAt: new Date().toISOString(),
  };
  const all = await readIndex();
  all.push(artifact);
  await mkdir(path.dirname(indexPath()), { recursive: true });
  await writeFile(indexPath(), JSON.stringify(all, null, 2), "utf-8");
  return artifact;
}
