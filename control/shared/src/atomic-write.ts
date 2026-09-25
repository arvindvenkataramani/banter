import { writeFile, rename, rm } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { randomUUID } from "node:crypto";

// ── Serialise writes to a single file ────────────────────────────────────────
// Generalises the lock in media-store.ts: two callers rewriting the same file
// must not interleave, whatever the file is. Keyed on the target path, so
// unrelated files never wait on each other.
//
// In-memory, so it orders writers within one process only. That is enough for
// the platform as deployed — control plane and shard own separate files — but
// it is not a file lock and will not coordinate across processes.

const fileLocks = new Map<string, Promise<void>>();

/** Run `fn` exclusively with respect to any other call for the same path,
 * queuing behind whatever is already in flight rather than rejecting. Callers
 * that read-modify-write must wrap the read too — serialising only the write
 * still lets two readers race and drop one update. */
export async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prior = fileLocks.get(path) ?? Promise.resolve();
  let release: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  const chained = prior.then(() => next);
  fileLocks.set(path, chained);

  await prior;
  try {
    return await fn();
  } finally {
    release!();
    if (fileLocks.get(path) === chained) {
      fileLocks.delete(path);
    }
  }
}

/** Test seam, mirroring lifecycle.ts's clearLocks. */
export function clearFileLocks(): void {
  fileLocks.clear();
}

// ── Atomic write ─────────────────────────────────────────────────────────────

/** Write `contents` to `target` atomically: a reader sees either the old file
 * or the new one, never a partial write.
 *
 * The temp name carries a UUID rather than a timestamp. Two writes in the same
 * millisecond would otherwise pick the same temp path, and the second rename
 * would fail with ENOENT once the first had already moved it. */
export async function writeFileAtomic(target: string, contents: string): Promise<void> {
  await withFileLock(target, () => writeFileAtomicUnlocked(target, contents));
}

/** The write half alone, for callers already holding the lock via
 * `withFileLock` — the lock is not reentrant, so calling `writeFileAtomic`
 * inside a critical section for the same path would deadlock. */
export async function writeFileAtomicUnlocked(target: string, contents: string): Promise<void> {
  const tmpPath = join(dirname(target), `.${basename(target)}.tmp.${process.pid}.${randomUUID()}`);
  try {
    await writeFile(tmpPath, contents);
    await rename(tmpPath, target);
  } catch (err) {
    // Leave no debris in the data directory when the write or rename fails.
    await rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}
