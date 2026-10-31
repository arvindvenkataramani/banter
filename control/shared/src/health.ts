import { appendEvent, deriveHealthMap, deriveRunIntentMap } from "./events";
import type { RunFn } from "./tailscale";
import type { Service, Registry } from "../../../shared/types";

interface CheckOpts {
  bypassThreshold?: boolean;
  timeoutMs?: number;
  localHostId?: string;  // hostId of the node running this check; enables localhost fallback for local services
  runFn?: RunFn;          // required for services with a managed runner (runs healthCmd)
}

// In-memory consecutive failure counters (lost on restart — acceptable)
const failureCounts = new Map<string, number>();
const FAILURE_THRESHOLD = 2;


type CheckOutcome = "service.up" | "service.degraded" | "service.timed_out" | "service.down";

/**
 * Logs a check result only when it differs from the service's last
 * health-deciding event, so the log holds state changes rather than one line
 * per check round.
 */
async function recordOutcome(eventsPath: string, serviceId: string, type: CheckOutcome, data: Record<string, unknown>): Promise<void> {
  const last = (await deriveHealthMap(eventsPath)).get(serviceId);
  if (last?.type === type) return;
  await appendEvent(eventsPath, { type, subjectType: "service", subjectId: serviceId, data, actor: "system" });
}
export function resetFailureCounts(): void {
  failureCounts.clear();
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return response;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

export async function checkService(
  service: Service,
  eventsPath: string,
  opts: CheckOpts = {}
): Promise<void> {
  if (!service.permissions.enabled) return;

  const timeoutMs = opts.timeoutMs ?? 5000;
  const bypassThreshold = opts.bypassThreshold ?? false;
  const isManaged = service.runner?.type === "managed";

  // Fallback URL: localhost, only for services local to this node. Not meaningful
  // for a managed runner — it has no HTTP surface at all, primary or fallback.
  const isLocal =
    !isManaged &&
    (service.network.listenAddress != null ||
      (opts.localHostId != null && service.hostId === opts.localHostId));
  const fallbackUrl = isLocal
    ? `http://localhost:${service.network.port}${service.network.healthPath}`
    : null;

  const start = Date.now();
  let primaryOk = false;
  let primaryError: string | null = null;
  let isTimeout = false;

  // "reachable" treats any HTTP response as alive — for services whose health
  // path answers non-2xx by design (an MCP endpoint returns 406 to a plain GET).
  // Connection refused and timeouts still fail: reachability means a response
  // came back, not that the service is exempt from being reported down.
  // Not meaningful for a managed runner (no HTTP response to be lenient about).
  const acceptsAnyResponse = service.network.healthExpect === "reachable";

  if (isManaged) {
    // ── Primary check (managed runner: healthCmd exit code, no HTTP) ────────
    const result = await opts.runFn!(["sh", "-c", (service.runner as { healthCmd: string }).healthCmd]);
    if (result.exitCode === 0) {
      primaryOk = true;
    } else {
      primaryError = result.stderr || `exit code ${result.exitCode}`;
    }
  } else {
    // ── Primary check (Tailscale HTTPS endpoint) ────────────────────────────
    const primaryUrl = service.network.endpoint + service.network.healthPath;

    try {
      const response = await fetchWithTimeout(primaryUrl, timeoutMs);
      if (response.ok || acceptsAnyResponse) {
        primaryOk = true;
      } else {
        primaryError = `status ${response.status}`;
      }
    } catch (err: unknown) {
      isTimeout = err instanceof Error && err.name === "AbortError";
      primaryError = isTimeout ? "timeout" : (err instanceof Error ? err.message : String(err));
    }
  }

  if (primaryOk) {
    failureCounts.delete(service.id);
    await recordOutcome(eventsPath, service.id, "service.up", { latencyMs: Date.now() - start });
    return;
  }

  // ── Primary failed: apply threshold ──────────────────────────────────────

  const count = (failureCounts.get(service.id) ?? 0) + 1;
  failureCounts.set(service.id, count);

  if (!bypassThreshold && count < FAILURE_THRESHOLD) {
    // Not yet at threshold — skip emitting an event
    return;
  }

  failureCounts.delete(service.id);

  // ── Fallback check (localhost) ────────────────────────────────────────────

  if (fallbackUrl) {
    let fallbackOk = false;
    try {
      const fallbackResponse = await fetchWithTimeout(fallbackUrl, timeoutMs);
      fallbackOk = fallbackResponse.ok || acceptsAnyResponse;
    } catch {
      fallbackOk = false;
    }

    if (fallbackOk) {
      // Process is up but Tailscale endpoint is unreachable — degraded
      await recordOutcome(eventsPath, service.id, "service.degraded", { tailscaleError: primaryError, localOk: true });
      return;
    }
  }

  // ── Both checks failed ────────────────────────────────────────────────────

  if (isTimeout) {
    await recordOutcome(eventsPath, service.id, "service.timed_out", { timeoutMs });
  } else {
    await recordOutcome(eventsPath, service.id, "service.down", { reason: primaryError ?? "connection_refused" });
  }
}

/**
 * Checks every enabled service, except a demand-loaded one whose latest run
 * intent is not to run: one never started, or last stopped, unloaded or
 * disabled. A demand service that was started and then failed stays checked,
 * so it reads as down rather than off.
 */
export async function checkAllServices(
  registry: Registry,
  eventsPath: string,
  opts: CheckOpts = {}
): Promise<void> {
  const runIntent = await deriveRunIntentMap(eventsPath);
  const services = registry.services.filter(s =>
    s.permissions.enabled &&
    (s.lifecycle?.loadStrategy !== "demand" || runIntent.get(s.id) === true));
  await Promise.allSettled(services.map(s => checkService(s, eventsPath, opts)));
}

export function startHealthLoop(
  registry: Registry,
  eventsPath: string,
  intervalMs = 30000,
  opts: CheckOpts = {}
): { stop: () => void } {
  let stopped = false;
  let sleepResolve: (() => void) | null = null;
  let sleepTimer: ReturnType<typeof setTimeout> | null = null;

  async function loop() {
    while (!stopped) {
      const start = Date.now();
      await checkAllServices(registry, eventsPath, opts);
      if (stopped) break;
      const elapsed = Date.now() - start;
      const remaining = intervalMs - elapsed;
      if (remaining > 0) {
        await new Promise<void>(r => {
          sleepResolve = r;
          sleepTimer = setTimeout(r, remaining);
        });
        sleepResolve = null;
        sleepTimer = null;
      }
    }
  }

  loop();

  return {
    stop: () => {
      stopped = true;
      if (sleepTimer) clearTimeout(sleepTimer);
      if (sleepResolve) sleepResolve();
    },
  };
}
