import { appendEvent } from "../../shared/src/events";

export type RunFn = (cmd: string[]) => Promise<{ stdout: string; exitCode: number; stderr: string }>;

export async function getFreeMem(runFn: RunFn): Promise<number> {
  try {
    const result = await runFn(["top", "-l", "1", "-n", "0"]);
    if (result.exitCode !== 0) return 0;

    // Parse "PhysMem: 47G used (5847M wired, 2225M compressor), 285M unused."
    const match = result.stdout.match(/PhysMem:.*?(\d+)([KMG])\s+unused\./);
    if (!match) return 0;

    const value = parseInt(match[1], 10);
    const unit = match[2];

    const multipliers: Record<string, number> = {
      K: 1024,
      M: 1024 * 1024,
      G: 1024 * 1024 * 1024,
    };

    return value * (multipliers[unit] ?? 1);
  } catch {
    return 0;
  }
}

export async function getLmsFootprint(runFn: RunFn): Promise<number> {
  try {
    const result = await runFn(["lms", "ps", "--json"]);
    if (result.exitCode !== 0) return 0;

    const data = JSON.parse(result.stdout) as Array<{ size_bytes: number }>;
    if (!Array.isArray(data)) return 0;

    return data.reduce((sum, item) => sum + (item.size_bytes ?? 0), 0);
  } catch {
    return 0;
  }
}

export async function checkMemoryBudget(
  runFn: RunFn,
  freeMem: number,
  requestedMem: number,
  footprintMap: Map<string, number>,
  eventsPath: string
): Promise<{ ok: boolean; error?: string }> {
  // TODO: Implement proper memory pressure detection.
  // macOS Activity Monitor, top, vm_stat, and memory_pressure all report memory differently.
  // Research: https://github.com/exelban/stats — see how it calculates memory pressure.
  // For now, allow all loads (no memory budget check).
  return { ok: true };
}
