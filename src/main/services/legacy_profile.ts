/**
 * The profile the 1.0.0 rename left behind.
 *
 * `app.getName()` is what Electron names the userData directory after, and the
 * name changed with the product -- `buildergpt` became `schematic-ai-studio`.
 * `resources.ts` records that as a deliberate one-time cost, on the reasoning
 * that a migration for an app with no audience yet would be more code to be
 * wrong than the case is worth. That reasoning was right about the migration
 * and wrong about the silence: **the app knew and did not say.**
 *
 * What it cost, once, in full: an install with working API keys came back after
 * the rename reading an empty profile, so generation stopped. Every other part
 * of the app kept working, because nothing else needs a key. The failure that
 * surfaced was the provider's own `Invalid API key.` -- which is true, and
 * which points at a key the user had already set, in a directory the app was no
 * longer reading. It took a report, a wrong diagnosis about the MCP token, and
 * a second report to find.
 *
 * So this does not migrate anything. It answers one question -- *is there a
 * profile next door with something in it that this one lacks* -- and the
 * callers say so where it matters.
 *
 * ## Why the paths are arguments
 *
 * `app.getPath("userData")` reaches Electron and would put this out of the
 * suites' reach, which is where every rule in this app that can be checked
 * belongs. Injected as strings, exactly as `ToolContext.legacyBlocksPath` and
 * `DocumentSpec.run`'s third parameter are.
 *
 * ## Why it cannot decrypt anything
 *
 * `safeStorage` encrypts with a key held in the profile's own `Local State`,
 * itself protected by the OS keyring. The two profiles have different ones, so
 * the ciphertext next door is unreadable from here without carrying that file
 * across -- and reading it by hand would want `CryptUnprotectData`, a native
 * dependency this project does not have and should not gain. Hence a *notice*:
 * the keys are recoverable by pasting them again, and the app's job is to say
 * where to look, not to reach.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export interface OrphanedProfile {
  /** Where it is, so a person can be shown the folder. */
  path: string;
  /** Which providers have a stored key there. Never the keys themselves. */
  providers: string[];
  /** How many conversations are sitting in it. */
  conversations: number;
}

/** The `settings.json` shape this cares about, and nothing more. */
interface ProfileFile {
  encryptedKeys?: Record<string, unknown>;
}

async function readProfile(dir: string): Promise<ProfileFile | null> {
  try {
    return JSON.parse(await readFile(path.join(dir, "settings.json"), "utf8")) as ProfileFile;
  } catch {
    /*
     * Absent, unreadable, or not JSON -- all the same answer, and all of them
     * `null` rather than a throw. This runs at startup, and a corrupt file in a
     * directory the app has stopped using must not be able to stop it starting.
     */
    return null;
  }
}

function storedProviders(profile: ProfileFile | null): string[] {
  const keys = profile?.encryptedKeys;
  if (keys === undefined || keys === null || typeof keys !== "object") return [];
  return Object.entries(keys)
    .filter(([, value]) => typeof value === "string" && value !== "")
    .map(([provider]) => provider)
    .sort();
}

async function countConversations(dir: string): Promise<number> {
  try {
    return (await readdir(path.join(dir, "conversations"))).length;
  } catch {
    return 0;
  }
}

/**
 * The orphaned profile, or `null` when there is nothing to say.
 *
 * `null` in three situations that are one situation: there is nothing next door
 * worth mentioning. It does not exist; it exists and holds nothing; or **this**
 * profile already has a key, which is the one that matters -- without it the
 * notice would still be on screen after the user had pasted the keys back, and
 * a warning that outlives its cause is one people learn to ignore.
 *
 * Conversations are counted but do not on their own raise the notice. They are
 * worth mentioning once somebody is being sent to the folder anyway; they are
 * not worth a warning of their own, because losing a chat log is an
 * inconvenience and losing a key looks like the app being broken.
 */
export async function orphanedProfile(
  current: string,
  legacy: string,
): Promise<OrphanedProfile | null> {
  if (path.resolve(current) === path.resolve(legacy)) return null;

  const mine = storedProviders(await readProfile(current));
  if (mine.length > 0) return null;

  const theirs = await readProfile(legacy);
  if (theirs === null) return null;
  const providers = storedProviders(theirs);
  if (providers.length === 0) return null;

  return {
    path: legacy,
    providers,
    conversations: await countConversations(legacy),
  };
}
