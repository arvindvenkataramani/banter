export type RunFn = (cmd: string[]) => Promise<{ stdout: string; exitCode: number; stderr: string }>;
export type PollHealthFn = (endpoint: string, timeout: number) => Promise<boolean>;

/** Spawn a long-running process. Returns a kill function. For process runner services. */
export type SpawnFn = (cmd: string[], opts?: { cwd?: string; env?: Record<string, string>; logDir?: string }) => { kill: () => void };

/** Serve registration state for a port. "unknown" means the query itself failed
 * (tailscaled down, unparseable output) — which is NOT the same as "not served",
 * and callers that would take a corrective action on "no" must not take it on
 * "unknown". */
export type ServeState = "served" | "not-served" | "unknown";

export async function queryPortServed(runFn: RunFn, port: number): Promise<ServeState> {
  try {
    const result = await runFn(["tailscale", "serve", "status", "--json"]);
    if (result.exitCode !== 0) return "unknown";
    const status = JSON.parse(result.stdout);
    // HTTPS serve appears under Web with keys like "hostname:PORT"
    if (status?.Web == null) return "not-served";
    return Object.keys(status.Web).some(k => k.endsWith(`:${port}`)) ? "served" : "not-served";
  } catch {
    return "unknown";
  }
}

/** Boolean view of {@link queryPortServed}: "unknown" collapses to false. Callers
 * that need to tell a failed query apart from a genuine absence should use
 * queryPortServed directly. */
export async function isPortServed(runFn: RunFn, port: number): Promise<boolean> {
  return await queryPortServed(runFn, port) === "served";
}

export async function removeTailscaleServe(runFn: RunFn, port: number): Promise<{ ok: boolean; error?: string }> {
  if (!await isPortServed(runFn, port)) {
    return { ok: true };
  }
  try {
    const result = await runFn(["tailscale", "serve", "--bg", `--https=${port}`, "off"]);
    if (result.exitCode !== 0) {
      return { ok: false, error: result.stderr || `exit code ${result.exitCode}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function addTailscaleServe(runFn: RunFn, port: number): Promise<{ ok: boolean; error?: string }> {
  try {
    const result = await runFn(["tailscale", "serve", "--bg", `--https=${port}`, `localhost:${port}`]);
    if (result.exitCode !== 0) {
      return { ok: false, error: result.stderr || `exit code ${result.exitCode}` };
    }
    // Verify the entry actually registered — tailscale can exit 0 while in a broken state
    if (!await isPortServed(runFn, port)) {
      return { ok: false, error: `tailscale serve exited 0 but port ${port} is not in serve status` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
