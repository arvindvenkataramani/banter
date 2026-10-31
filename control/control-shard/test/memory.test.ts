// Reading the Mac's free memory from `top`.

import { describe, it, expect } from "bun:test";
import { getFreeMem } from "../src/memory";
import type { RunFn } from "../../shared/src/tailscale";

const top = (stdout: string, exitCode = 0): RunFn => async () => ({ stdout, exitCode, stderr: "" });

describe("getFreeMem", () => {
  const CASES: [string, RunFn, number][] = [
    ["megabytes", top("Load Avg: 1.83\nPhysMem: 47G used (5847M wired, 2225M compressor), 285M unused.\nVM: 396T vsize"), 285 * 1024 * 1024],
    ["gigabytes", top("PhysMem: 35G used (5G wired, 2G compressor), 13G unused."), 13 * 1024 * 1024 * 1024],
    ["output it cannot parse, as zero", top("invalid output"), 0],
    ["a failed top, as zero", top("", 1), 0],
  ];
  it.each(CASES)("reads %s", async (_, runFn, bytes) => {
    expect(await getFreeMem(runFn)).toBe(bytes);
  });
});
