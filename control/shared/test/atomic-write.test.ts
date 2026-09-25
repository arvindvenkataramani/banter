import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, readdir, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic, writeFileAtomicUnlocked, withFileLock, clearFileLocks } from "../src/atomic-write";

let tmpDir: string;
let target: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "atomic-write-test-"));
  target = join(tmpDir, "registry.json");
  clearFileLocks();
});

afterEach(async () => {
  clearFileLocks();
  await rm(tmpDir, { recursive: true, force: true });
});

/** Temp files are the ones this module creates alongside the target. */
async function strayTempFiles(): Promise<string[]> {
  const entries = await readdir(tmpDir);
  return entries.filter(e => e.includes(".tmp."));
}

describe("writeFileAtomic", () => {
  it("writes contents to the target", async () => {
    await writeFileAtomic(target, "hello");
    expect(await readFile(target, "utf8")).toBe("hello");
  });

  it("replaces existing contents", async () => {
    await writeFile(target, "old");
    await writeFileAtomic(target, "new");
    expect(await readFile(target, "utf8")).toBe("new");
  });

  it("leaves no temp file behind on success", async () => {
    await writeFileAtomic(target, "hello");
    expect(await strayTempFiles()).toEqual([]);
  });

  // The bug: `.tmp.${Date.now()}` collides at millisecond resolution, so the
  // first rename moves the shared temp file and the second hits ENOENT.
  it("survives concurrent writes to the same target", async () => {
    const results = await Promise.allSettled([
      writeFileAtomic(target, "a"),
      writeFileAtomic(target, "b"),
      writeFileAtomic(target, "c"),
    ]);

    const rejected = results.filter(r => r.status === "rejected");
    expect(rejected).toEqual([]);

    // Last writer wins; the file is always one whole value, never a mix.
    expect(["a", "b", "c"]).toContain(await readFile(target, "utf8"));
    expect(await strayTempFiles()).toEqual([]);
  });

  it("serializes concurrent writes rather than interleaving them", async () => {
    const order: string[] = [];
    await Promise.all([
      writeFileAtomic(target, "a").then(() => { order.push("a"); }),
      writeFileAtomic(target, "b").then(() => { order.push("b"); }),
    ]);
    expect(order.length).toBe(2);
  });

  it("does not serialize writes to different targets", async () => {
    const other = join(tmpDir, "other.json");
    await Promise.all([
      writeFileAtomic(target, "a"),
      writeFileAtomic(other, "b"),
    ]);
    expect(await readFile(target, "utf8")).toBe("a");
    expect(await readFile(other, "utf8")).toBe("b");
  });

  it("propagates the error and strands no temp file when the write fails", async () => {
    const unwritable = join(tmpDir, "nodir", "registry.json");
    await expect(writeFileAtomic(unwritable, "x")).rejects.toThrow();
    expect(await strayTempFiles()).toEqual([]);
  });

  it("releases the lock after a failure so later writes still succeed", async () => {
    const unwritable = join(tmpDir, "nodir", "registry.json");
    await expect(writeFileAtomic(unwritable, "x")).rejects.toThrow();
    await writeFileAtomic(unwritable.replace("nodir/", ""), "recovered");
    expect(await readFile(join(tmpDir, "registry.json"), "utf8")).toBe("recovered");
  });
});

describe("writeFileAtomicUnlocked", () => {
  it("writes without taking the lock, for callers already holding it", async () => {
    await withFileLock(target, async () => {
      await writeFileAtomicUnlocked(target, "inner");
    });
    expect(await readFile(target, "utf8")).toBe("inner");
    expect(await strayTempFiles()).toEqual([]);
  });

  it("strands no temp file when the write fails", async () => {
    const unwritable = join(tmpDir, "nodir", "registry.json");
    await expect(writeFileAtomicUnlocked(unwritable, "x")).rejects.toThrow();
    expect(await strayTempFiles()).toEqual([]);
  });
});

describe("withFileLock", () => {
  it("runs one critical section at a time per path", async () => {
    const events: string[] = [];
    const slow = withFileLock(target, async () => {
      events.push("first:enter");
      await new Promise(r => setTimeout(r, 20));
      events.push("first:exit");
    });
    const fast = withFileLock(target, async () => {
      events.push("second:enter");
      events.push("second:exit");
    });
    await Promise.all([slow, fast]);

    expect(events).toEqual([
      "first:enter", "first:exit",
      "second:enter", "second:exit",
    ]);
  });

  it("queues behind a failing holder instead of deadlocking", async () => {
    const failed = withFileLock(target, async () => { throw new Error("boom"); });
    await expect(failed).rejects.toThrow("boom");
    expect(await withFileLock(target, async () => "ok")).toBe("ok");
  });

  it("returns the critical section's value", async () => {
    expect(await withFileLock(target, async () => 42)).toBe(42);
  });

  // Read-modify-write is the pattern that actually loses updates: both callers
  // read, both mutate, and the loser's change vanishes. The lock has to cover
  // the read as well as the write.
  it("makes read-modify-write safe under concurrency", async () => {
    await writeFile(target, JSON.stringify({ count: 0 }));

    const increment = () => withFileLock(target, async () => {
      const cur = JSON.parse(await readFile(target, "utf8")) as { count: number };
      await new Promise(r => setTimeout(r, 5)); // widen the race window
      await writeFile(target, JSON.stringify({ count: cur.count + 1 }));
    });

    await Promise.all([increment(), increment(), increment()]);

    const final = JSON.parse(await readFile(target, "utf8")) as { count: number };
    expect(final.count).toBe(3);
  });
});
