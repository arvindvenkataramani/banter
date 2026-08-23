import { appendEvent } from "./events";
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
    const latencyMs = Date.now() - start;
    failureCounts.delete(service.id);
    await appendEvent(eventsPath, {
      type: "service.up",
      subjectType: "service",
      subjectId: service.id,
      data: { latencyMs },
      actor: "system",
    });
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
      await appendEvent(eventsPath, {
        type: "service.degraded",
        subjectType: "service",
        subjectId: service.id,
        data: { tailscaleError: primaryError, localOk: true },
        actor: "system",
      });
      return;
    }
  }

  // ── Both checks failed ────────────────────────────────────────────────────

  if (isTimeout) {
    await appendEvent(eventsPath, {
      type: "service.timed_out",
      subjectType: "service",
      subjectId: service.id,
      data: { timeoutMs },
      actor: "system",
    });
  } else {
    await appendEvent(eventsPath, {
      type: "service.down",
      subjectType: "service",
      subjectId: service.id,
      data: { reason: primaryError ?? "connection_refused" },
      actor: "system",
    });
  }
}

export async function checkAllServices(
  registry: Registry,
  eventsPath: string,
  opts: CheckOpts & { onlyLoaded?: boolean } = {}
): Promise<void> {
  let services = registry.services.filter(s => s.permissions.enabled);
  if (opts.onlyLoaded) {
    services = services.filter(s => s.lifecycle?.loadStrategy !== "demand" || s.state?.loadTime != null);
  }
  await Promise.allSettled(services.map(s => checkService(s, eventsPath, opts)));
}

export function startHealthLoop(
  registry: Registry,
  eventsPath: string,
  intervalMs = 30000,
  opts: CheckOpts & { onlyLoaded?: boolean } = {}
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
