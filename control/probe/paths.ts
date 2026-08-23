// Where the probe keeps its identity and its captures.
//
// Both live under control/probe/ and are gitignored. They sit next to the
// code that writes them so they are visible on a plain `ls` — an earlier
// version hid them in ~/.openclaw-probe/, where nothing would ever have
// pruned or found them.
//
// Captures may contain conversation content. They must not be committed, and
// should not be copied anywhere they'd outlive the debugging session.

import { readdirSync, statSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const PROBE_DIR = import.meta.dir;

export const IDENTITY_PATH =
  process.env.PROBE_IDENTITY_PATH ?? join(PROBE_DIR, "identity.json");

export const CAPTURE_DIR = process.env.PROBE_CAPTURE_DIR ?? join(PROBE_DIR, "captures");

/** Captures kept before the oldest are deleted. */
const KEEP_CAPTURES = 20;

/**
 * Deletes all but the newest `keep` captures. Called on every run so the
 * directory stays bounded without anyone having to remember it exists.
 * Returns the paths removed.
 */
export function pruneCaptures(keep = KEEP_CAPTURES): string[] {
  mkdirSync(CAPTURE_DIR, { recursive: true });

  const captures = readdirSync(CAPTURE_DIR)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => {
      const path = join(CAPTURE_DIR, name);
      return { path, mtimeMs: statSync(path).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const stale = captures.slice(keep);
  for (const { path } of stale) unlinkSync(path);
  return stale.map((c) => c.path);
}
