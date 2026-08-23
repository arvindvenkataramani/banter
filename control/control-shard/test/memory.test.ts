import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, readEvents } from "../../shared/src/events";

type RunFn = (cmd: string[]) => Promise<{ stdout: string; exitCode: number; stderr: string }>;

let tmpDir: string;
let eventsPath: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "memory-test-"));
  eventsPath = join(tmpDir, "events.jsonl");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("getFreeMem()", () => {
  it("parses top output and returns unused memory in bytes", async () => {
    const topOutput = `
Processes: 867 total, 3 running, 864 sleeping, 5074 threads
Load Avg: 1.83, 1.82, 1.92
CPU usage: 5.54% user, 7.7% sys, 87.37% idle
SharedLibs: 1154M resident, 199M data, 163M linkedit.
MemRegions: 718081 total, 15G resident, 940M private, 9489M shared.
PhysMem: 47G used (5847M wired, 2225M compressor), 285M unused.
VM: 396T vsize, 5702M framework vsize, 21005(0) swapins, 117910(0) swapouts.
    `.trim();
    const runFn: RunFn = async (cmd) => {
      if (cmd[0] === "top") {
        return { stdout: topOutput, exitCode: 0, stderr: "" };
      }
      return { stdout: "", exitCode: 1, stderr: "unknown command" };
    };

    // "285M unused" = 285 * 1024 * 1024 bytes
    const { getFreeMem } = await import("../src/memory");
    const freeMem = await getFreeMem(runFn);
    expect(freeMem).toBe(285 * 1024 * 1024);
  });

  it("handles GB units in top output", async () => {
    const topOutput = `PhysMem: 35G used (5G wired, 2G compressor), 13G unused.`;
    const runFn: RunFn = async (cmd) => {
      if (cmd[0] === "top") {
        return { stdout: topOutput, exitCode: 0, stderr: "" };
      }
      return { stdout: "", exitCode: 1, stderr: "unknown command" };
    };

    const { getFreeMem } = await import("../src/memory");
    const freeMem = await getFreeMem(runFn);
    expect(freeMem).toBe(13 * 1024 * 1024 * 1024);
  });

  it("returns 0 when top output cannot be parsed", async () => {
    const runFn: RunFn = async () => {
      return { stdout: "invalid output", exitCode: 0, stderr: "" };
    };

    const { getFreeMem } = await import("../src/memory");
    const freeMem = await getFreeMem(runFn);
    expect(freeMem).toBe(0);
  });

  it("returns 0 when top exits with non-zero", async () => {
    const runFn: RunFn = async () => {
      return { stdout: "", exitCode: 1, stderr: "command not found" };
    };

    const { getFreeMem } = await import("../src/memory");
    const freeMem = await getFreeMem(runFn);
    expect(freeMem).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("getLmsFootprint()", () => {
  it("returns footprint in bytes when lms ps --json returns a running process", async () => {
    const lmsOutput = JSON.stringify([
      { model_name: "some-model", size_bytes: 8589934592 }
    ]);
    const runFn: RunFn = async (cmd) => {
      if (cmd[0] === "lms" && cmd[1] === "ps") {
        return { stdout: lmsOutput, exitCode: 0, stderr: "" };
      }
      return { stdout: "", exitCode: 1, stderr: "" };
    };

    const { getLmsFootprint } = await import("../src/memory");
    const footprint = await getLmsFootprint(runFn);
    expect(footprint).toBe(8589934592);
  });

  it("returns 0 when lms ps --json returns an empty array", async () => {
    const runFn: RunFn = async (cmd) => {
      if (cmd[0] === "lms" && cmd[1] === "ps") {
        return { stdout: "[]", exitCode: 0, stderr: "" };
      }
      return { stdout: "", exitCode: 1, stderr: "" };
    };

    const { getLmsFootprint } = await import("../src/memory");
    const footprint = await getLmsFootprint(runFn);
    expect(footprint).toBe(0);
  });

  it("returns 0 when lms ps exits non-zero", async () => {
    const runFn: RunFn = async (cmd) => {
      if (cmd[0] === "lms") {
        return { stdout: "", exitCode: 1, stderr: "lms: command not found" };
      }
      return { stdout: "", exitCode: 1, stderr: "" };
    };

    const { getLmsFootprint } = await import("../src/memory");
    const footprint = await getLmsFootprint(runFn);
    expect(footprint).toBe(0);
  });

  it("returns 0 when lms ps output is not valid JSON", async () => {
    const runFn: RunFn = async (cmd) => {
      if (cmd[0] === "lms" && cmd[1] === "ps") {
        return { stdout: "not valid json", exitCode: 0, stderr: "" };
      }
      return { stdout: "", exitCode: 1, stderr: "" };
    };

    const { getLmsFootprint } = await import("../src/memory");
    const footprint = await getLmsFootprint(runFn);
    expect(footprint).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("checkMemoryBudget()", () => {
  it("always returns ok (memory checks disabled for now)", async () => {
    const runFn: RunFn = async () => ({ stdout: "", exitCode: 0, stderr: "" });
    const freeMem = 0; // even with no free memory
    const requestedMem = 999_999_999_999;
    const footprintMap = new Map<string, number>();

    const { checkMemoryBudget } = await import("../src/memory");
    const result = await checkMemoryBudget(
      runFn,
      freeMem,
      requestedMem,
      footprintMap,
      eventsPath
    );
    expect(result.ok).toBe(true);
  });

  it("does not emit memory.pressure events (memory checks disabled)", async () => {
    const runFn: RunFn = async () => ({ stdout: "", exitCode: 0, stderr: "" });
    const freeMem = 0;
    const requestedMem = 0;
    const footprintMap = new Map<string, number>();

    const { checkMemoryBudget } = await import("../src/memory");
    await checkMemoryBudget(runFn, freeMem, requestedMem, footprintMap, eventsPath);

    const events = await readEvents(eventsPath);
    expect(events.some(e => e.type === "memory.pressure")).toBe(false);
  });
});
