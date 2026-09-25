export type RunFn = (cmd: string[]) => Promise<{ stdout: string; exitCode: number; stderr: string }>;
export type PollHealthFn = (
  endpoint: string,
  timeout: number,
  opts?: { acceptsAnyResponse?: boolean }
) => Promise<boolean>;

/** Single-shot "is this already running" probe for startService's fast path.
 *  Distinct from PollHealthFn (which retries across a startup grace period) —
 *  this fires once, immediately, with no retry. Defaults to a real fetch;
 *  tests inject a fake so the fast path's outcome doesn't depend on real
 *  port/network state.
 *
 *  "Not running" is signaled by rejecting/throwing (as a real fetch does on
 *  connection refused) — not by resolving with { ok: false }, which means
 *  "reachable but answered with a non-2xx status". startService's
 *  healthExpect: "reachable" handling treats any resolved result as
 *  already-running, so a fake meant to model "nothing listening" must throw. */
export type ProbeFn = (url: string, timeoutMs: number) => Promise<{ ok: boolean }>;

/** Spawn a long-running process. For process runner services.
 *  `exited` resolves with the exit code when the process ends, however it
 *  ended — crash detection needs it, and without it a dying service is
 *  invisible to the platform. Optional so a caller that never spawns real
 *  processes can omit it. */
export type SpawnFn = (cmd: string[], opts?: { cwd?: string; env?: Record<string, string>; logDir?: string }) => { kill: () => void; exited?: Promise<number> };

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

export type RetryOpts = { attempts: number; delayMs: number };

// Collects each attempt's error, reporting every distinct message once.
// Two identical etag mismatches mean contention; an etag mismatch followed
// by a different error means the first failure was incidental — collapsing
// them into one loses that distinction.
function distinctErrors(errors: string[]): string {
  return [...new Set(errors)].join("; ");
}

async function withRetry(
  attempt: () => Promise<{ ok: boolean; error?: string }>,
  retry?: RetryOpts
): Promise<{ ok: boolean; error?: string }> {
  const attempts = retry?.attempts ?? 1;
  const delayMs = retry?.delayMs ?? 0;
  const errors: string[] = [];

  for (let i = 1; i <= attempts; i++) {
    const result = await attempt();
    if (result.ok) return result;
    errors.push(result.error ?? "unknown error");
    if (i < attempts) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  return { ok: false, error: distinctErrors(errors) };
}

export async function removeTailscaleServe(
  runFn: RunFn,
  port: number,
  retry?: RetryOpts
): Promise<{ ok: boolean; error?: string }> {
  if (!await isPortServed(runFn, port)) {
    return { ok: true };
  }

  return withRetry(async () => {
    try {
      const result = await runFn(["tailscale", "serve", "--bg", `--https=${port}`, "off"]);
      if (result.exitCode !== 0) {
        return { ok: false, error: result.stderr || `exit code ${result.exitCode}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }, retry);
}

export async function addTailscaleServe(
  runFn: RunFn,
  port: number,
  retry?: RetryOpts
): Promise<{ ok: boolean; error?: string }> {
  return withRetry(async () => {
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
  }, retry);
}
