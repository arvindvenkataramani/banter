import { appendEvent, deriveHealthMap, deriveRunIntentMap } from "./events";
import type { RunFn } from "./tailscale";
import type { Service, Registry } from "../../../shared/types";

interface CheckOpts {
  bypassThreshold?: boolean;
  timeoutMs?: number;
  routeUrl?: string;      // the service's Tailscale address, from tailnetRouteUrl; the route is checked only when given
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
    // A pooled connection can outlive the service behind it: Tailscale Serve
    // keeps answering on an open connection after its route is removed.
    const response = await fetch(url, { signal: controller.signal, keepalive: false });
    clearTimeout(timer);
    return response;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * The Tailscale address of a service behind Tailscale Serve, on its host's
 * tailnet name. Undefined for a service with no route.
 */
export function tailnetRouteUrl(registry: Registry, service: Service): string | undefined {
  if (!service.network.tailscaleServe || !service.network.port) return undefined;
  const hostname = registry.hosts.find(h => h.id === service.hostId)?.hostname;
  if (!hostname) return undefined;
  return `https://${hostname}:${service.network.port}${service.network.healthPath}`;
}

type Probe = { status: number } | { error: string; timedOut: boolean };

async function probe(url: string, timeoutMs: number): Promise<Probe> {
  try {
    return { status: (await fetchWithTimeout(url, timeoutMs)).status };
  } catch (err: unknown) {
    const timedOut = err instanceof Error && err.name === "AbortError";
    return { error: timedOut ? "timeout" : (err instanceof Error ? err.message : String(err)), timedOut };
  }
}

/**
 * Checks a service on the node it runs on. The process is asked first, and
 * only its answer decides whether the service is up: Tailscale Serve answers
 * on its own (a 404 on a stale connection, a 502 with nothing behind it), so a
 * response at the Tailscale address proves nothing about the process. For a
 * service behind Serve, the route is then asked, and works when it relays the
 * status the process gave; anything else is degraded.
 */
export async function checkService(
  service: Service,
  eventsPath: string,
  opts: CheckOpts = {}
): Promise<void> {
  if (!service.permissions.enabled) return;

  const timeoutMs = opts.timeoutMs ?? 5000;
  const start = Date.now();
  let outcome: { type: CheckOutcome; data: Record<string, unknown> };

  if (service.runner?.type === "managed") {
    const result = await opts.runFn!(["sh", "-c", (service.runner as { healthCmd: string }).healthCmd]);
    outcome = result.exitCode === 0
      ? { type: "service.up", data: { latencyMs: Date.now() - start } }
      : { type: "service.down", data: { reason: result.stderr || `exit code ${result.exitCode}` } };
  } else {
    // Behind Serve, the process listens on localhost and the registered
    // endpoint may be the route. Otherwise nothing sits between the checker
    // and the process, and the endpoint is the process.
    const processUrl = service.network.tailscaleServe
      ? `http://localhost:${service.network.port}${service.network.healthPath}`
      : service.network.endpoint + service.network.healthPath;
    const proc = await probe(processUrl, timeoutMs);
    // "reachable" treats any HTTP response as alive, for services whose health
    // path answers non-2xx by design (an MCP endpoint returns 406 to a plain GET).
    const acceptsAnyResponse = service.network.healthExpect === "reachable";

    if ("error" in proc) {
      outcome = proc.timedOut
        ? { type: "service.timed_out", data: { timeoutMs } }
        : { type: "service.down", data: { reason: proc.error } };
    } else if (!(acceptsAnyResponse || (proc.status >= 200 && proc.status < 300))) {
      outcome = { type: "service.down", data: { reason: `status ${proc.status}` } };
    } else {
      const latencyMs = Date.now() - start;
      outcome = { type: "service.up", data: { latencyMs } };
      if (service.network.tailscaleServe && opts.routeUrl) {
        const route = await probe(opts.routeUrl, timeoutMs);
        if ("error" in route || route.status !== proc.status) {
          const tailscaleError = "error" in route ? route.error : `status ${route.status} where the process answered ${proc.status}`;
          outcome = { type: "service.degraded", data: { tailscaleError, localOk: true } };
        }
      }
    }
  }

  if (outcome.type === "service.up") {
    failureCounts.delete(service.id);
  } else {
    const count = (failureCounts.get(service.id) ?? 0) + 1;
    failureCounts.set(service.id, count);
    if (!opts.bypassThreshold && count < FAILURE_THRESHOLD) return;
    failureCounts.delete(service.id);
  }
  await recordOutcome(eventsPath, service.id, outcome.type, outcome.data);
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
  await Promise.allSettled(services.map(s => checkService(s, eventsPath, { ...opts, routeUrl: tailnetRouteUrl(registry, s) })));
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
