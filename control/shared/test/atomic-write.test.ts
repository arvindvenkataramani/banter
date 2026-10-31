// Writing a file so a reader never sees it half-written, and the per-path lock
// that keeps read-modify-write cycles from losing updates.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, readdir, writeFile } from "node:fs/promises";
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

const unwritable = () => join(tmpDir, "nodir", "registry.json");

describe("writeFileAtomic", () => {
  it("lands one whole write out of several concurrent ones, leaving no temp file", async () => {
    await writeFile(target, "old");
    const results = await Promise.allSettled(["a", "b", "c"].map(s => writeFileAtomic(target, s)));
    expect(results.every(r => r.status === "fulfilled")).toBe(true);
    expect(["a", "b", "c"]).toContain(await readFile(target, "utf8"));
    expect(await readdir(tmpDir)).toEqual(["registry.json"]);
  });

  it.each([
    ["writeFileAtomic", writeFileAtomic],
    ["writeFileAtomicUnlocked", writeFileAtomicUnlocked],
  ])("%s passes a failed write's error on and leaves no temp file", async (_, write) => {
    await expect(write(unwritable(), "x")).rejects.toThrow();
    expect(await readdir(tmpDir)).toEqual([]);
  });

  it("writes unlocked inside a lock its caller already holds", async () => {
    await withFileLock(target, () => writeFileAtomicUnlocked(target, "inner"));
    expect(await readFile(target, "utf8")).toBe("inner");
  });
});

describe("withFileLock", () => {
  it("loses no update when read-modify-write cycles race", async () => {
    await writeFile(target, JSON.stringify({ count: 0 }));
    const increment = () => withFileLock(target, async () => {
      const cur = JSON.parse(await readFile(target, "utf8")) as { count: number };
      await new Promise(r => setTimeout(r, 5));
      await writeFile(target, JSON.stringify({ count: cur.count + 1 }));
    });
    await Promise.all([increment(), increment(), increment()]);
    expect(JSON.parse(await readFile(target, "utf8")).count).toBe(3);
  });

  it("frees the path after a holder fails, so later work proceeds", async () => {
    await expect(withFileLock(target, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await withFileLock(target, async () => "ok")).toBe("ok");
    await expect(writeFileAtomic(unwritable(), "x")).rejects.toThrow();
    await writeFileAtomic(target, "recovered");
    expect(await readFile(target, "utf8")).toBe("recovered");
  });
});
