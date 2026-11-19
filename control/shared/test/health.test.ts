// Probing services and recording what the probe finds.
// Promises: docs/reference/components/health-checker.md; healthExpect and managed runners in registry.md.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkService, checkAllServices, startHealthLoop, resetFailureCounts, tailnetRouteUrl } from "../src/health";
import { readEvents, appendEvent } from "../src/events";
import type { Service, Registry } from "../../../shared/types";

let tmpDir: string;
let eventsPath: string;
const servers: ReturnType<typeof Bun.serve>[] = [];

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "health-test-"));
  eventsPath = join(tmpDir, "events.jsonl");
  resetFailureCounts();
});

afterEach(async () => {
  for (const s of servers) s.stop(true);
  servers.length = 0;
  await rm(tmpDir, { recursive: true, force: true });
});

const REFUSED = "http://localhost:19876";

type Over = Partial<Omit<Service, "network">> & { network?: Partial<Service["network"]> };

function service(endpoint: string, over: Over = {}): Service {
  const { network, ...rest } = over;
  return {
    id: "svc1",
    capabilityId: "cap1",
    hostId: "host1",
    permissions: { enabled: true },
    network: { port: Number(new URL(endpoint).port), healthPath: "/health", endpoint, ...network },
    ...rest,
  } as Service;
}

/** A server answering every request with `status`, after `delayMs`. */
function serve(status = 200, delayMs = 0): string {
  const server = Bun.serve({
    port: 0,
    fetch: async () => {
      if (delayMs) await new Promise(r => setTimeout(r, delayMs));
      return new Response("x", { status });
    },
  });
  servers.push(server);
  return `http://localhost:${server.port}`;
}

const types = async (subjectId?: string): Promise<string[]> => (await readEvents(eventsPath, { subjectId })).map(e => e.type);
const once = { bypassThreshold: true };

describe("a single check", () => {
  it.each([
    ["a 2xx", () => serve(200), undefined, "service.up"],
    ["a non-2xx", () => serve(500), undefined, "service.down"],
    ["a refused connection", () => REFUSED, undefined, "service.down"],
    ["no answer within the timeout", () => serve(200, 300), undefined, "service.timed_out"],
    ["a non-2xx, for a service whose healthExpect is reachable", () => serve(406), "reachable", "service.up"],
    ["a 5xx, for a service whose healthExpect is reachable", () => serve(500), "reachable", "service.up"],
    ["a refused connection, for a service whose healthExpect is reachable", () => REFUSED, "reachable", "service.down"],
    ["no answer within the timeout, for a service whose healthExpect is reachable", () => serve(200, 300), "reachable", "service.timed_out"],
    ["a non-2xx, for a service whose healthExpect is ok", () => serve(406), "ok", "service.down"],
  ] as [string, () => string, "ok" | "reachable" | undefined, string][])("records %s as %s", async (_, endpoint, healthExpect, type) => {
    await checkService(service(endpoint(), { network: { healthExpect } }), eventsPath, { ...once, timeoutMs: 100 });
    expect(await types()).toEqual([type]);
  });

  // A connection held open from an earlier check can still be answered after
  // the service has gone — Tailscale Serve keeps proxying it once the route is
  // removed — so a check must open its own.
  it("opens a fresh connection for every check", async () => {
    const clientPorts: number[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: (req, srv) => { clientPorts.push(srv.requestIP(req)!.port); return new Response("x"); },
    });
    servers.push(server);
    const svc = service(`http://localhost:${server.port}`);
    await checkService(svc, eventsPath, once);
    await checkService(svc, eventsPath, once);
    expect(clientPorts).toHaveLength(2);
    expect(clientPorts[0]).not.toBe(clientPorts[1]);
  });

  it("records the latency of a service that is up", async () => {
    await checkService(service(serve()), eventsPath, once);
    const [event] = await readEvents(eventsPath);
    expect(typeof event.data.latencyMs).toBe("number");
  });

  it("skips a disabled service", async () => {
    let ran = false;
    const runFn = async () => { ran = true; return { exitCode: 0, stdout: "", stderr: "" }; };
    await checkService(service(serve(), { permissions: { enabled: false } }), eventsPath, once);
    await checkService(managed({ permissions: { enabled: false } }), eventsPath, { ...once, runFn });

    expect(await types()).toEqual([]);
    expect(ran).toBe(false);
  });

  it("logs a repeated result once, and the next change again", async () => {
    let status = 200;
    const server = Bun.serve({ port: 0, fetch: () => new Response("x", { status }) });
    servers.push(server);
    const svc = service(`http://localhost:${server.port}`);
    await checkService(svc, eventsPath, once);
    await checkService(svc, eventsPath, once);
    status = 500;
    await checkService(svc, eventsPath, once);
    await checkService(svc, eventsPath, once);

    expect(await types()).toEqual(["service.down", "service.up"]);
  });
});

// A service behind Tailscale Serve: the process answers on localhost, and a
// second server stands in for the route. The route can answer when the process
// cannot, which is why the process is asked first.
describe("a service behind Tailscale Serve", () => {
  const behindServe = (processUrl: string, over: Over = {}) =>
    service(processUrl, { ...over, network: { tailscaleServe: true, ...over.network } });

  it.each([
    ["relays the service's answer", 200, () => serve(200), undefined, "service.up"],
    ["relays the non-2xx answer of a reachable service", 406, () => serve(406), "reachable", "service.up"],
    ["answers with a status of its own", 200, () => serve(404), undefined, "service.degraded"],
    ["answers a reachable service with a gateway error", 406, () => serve(502), "reachable", "service.degraded"],
    ["refuses the connection", 200, () => REFUSED, undefined, "service.degraded"],
  ] as [string, number, () => string, "reachable" | undefined, string][])(
    "records the route that %s as %s",
    async (_, processStatus, route, healthExpect, type) => {
      const svc = behindServe(serve(processStatus), { network: { healthExpect } });
      await checkService(svc, eventsPath, { ...once, timeoutMs: 100, routeUrl: route() + "/health" });
      expect(await types()).toEqual([type]);
    }
  );

  it("records the service down when its process does not answer, whatever the route says", async () => {
    let routeAsked = false;
    const route = Bun.serve({ port: 0, fetch: () => { routeAsked = true; return new Response("x", { status: 502 }); } });
    servers.push(route);
    const svc = behindServe(REFUSED, { network: { healthExpect: "reachable" } });
    await checkService(svc, eventsPath, { ...once, routeUrl: `http://localhost:${route.port}/health` });
    expect(await types()).toEqual(["service.down"]);
    expect(routeAsked).toBe(false);
  });

  it("asks the process on localhost, not at its registered endpoint", async () => {
    const processUrl = serve(200);
    const port = Number(new URL(processUrl).port);
    const svc = behindServe(REFUSED, { network: { port } });
    await checkService(svc, eventsPath, once);
    expect(await types()).toEqual(["service.up"]);
  });

  it("derives the route from the tailnet hostname of the service's host", () => {
    const reg = registry([behindServe(serve(), { id: "s", hostId: "h1", network: { port: 8770, healthPath: "/mcp" } })]);
    expect(tailnetRouteUrl(reg, reg.services[0])).toBe("https://h1.ts.net:8770/mcp");
    expect(tailnetRouteUrl(reg, service(serve()))).toBeUndefined();
  });
});

describe("the consecutive failure threshold", () => {
  it("records a failure only on the second in a row, and a success at once, which resets the count", async () => {
    const down = service(REFUSED);
    await checkService(down, eventsPath);
    expect(await types()).toEqual([]);
    await checkService(down, eventsPath);
    expect(await types()).toEqual(["service.down"]);

    await checkService(service(serve()), eventsPath);
    await checkService(down, eventsPath);
    expect(await types()).toEqual(["service.up", "service.down"]);
  });

  it("applies to a managed runner's health command too", async () => {
    const runFn = async () => ({ exitCode: 1, stdout: "", stderr: "" });
    await checkService(managed(), eventsPath, { runFn });
    expect(await types()).toEqual([]);
    await checkService(managed(), eventsPath, { runFn });
    expect(await types()).toEqual(["service.down"]);
  });
});

function managed(over: Over = {}): Service {
  return service("http://localhost:6767", {
    runner: { type: "managed", startCmd: ["paseo", "daemon", "start"], stopCmd: ["paseo", "daemon", "stop"], healthCmd: "paseo daemon status --json | jq -e '.localDaemon == \"running\"'" },
    network: { healthPath: "", endpoint: "" },
    ...over,
  } as Over);
}

describe("a managed runner", () => {
  it.each([
    [0, "service.up"],
    [1, "service.down"],
  ])("is checked by running its health command through sh -c, exit %i recording %s, with no HTTP request", async (exitCode, type) => {
    const ran: string[][] = [];
    const runFn = async (cmd: string[]) => { ran.push(cmd); return { exitCode, stdout: "", stderr: "" }; };
    const originalFetch = globalThis.fetch;
    let fetched = false;
    globalThis.fetch = (async () => { fetched = true; throw new Error("no HTTP expected"); }) as unknown as typeof fetch;
    try {
      await checkService(managed(), eventsPath, { ...once, runFn });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(ran).toEqual([["sh", "-c", "paseo daemon status --json | jq -e '.localDaemon == \"running\"'"]]);
    expect(fetched).toBe(false);
    expect(await types()).toEqual([type]);
  });
});

function registry(services: Service[]): Registry {
  return {
    version: 2,
    type: "control",
    hosts: [{ id: "h1", name: "h1", hostname: "h1.ts.net", role: "control" }],
    capabilities: [{ id: "c1", name: "c1" }],
    services,
  };
}

describe("the loop", () => {
  it("checks every enabled service in parallel, so a slow or failing one holds up no other", async () => {
    const reg = registry([
      service(serve(), { id: "fast" }),
      service(serve(200, 1000), { id: "slow" }),
      service(REFUSED, { id: "refused" }),
      service(serve(), { id: "off", permissions: { enabled: false } }),
    ]);
    const { stop } = startHealthLoop(reg, eventsPath, 5000);
    await new Promise(r => setTimeout(r, 150));
    stop();

    expect(await types("fast")).toEqual(["service.up"]);
    expect(await types("off")).toEqual([]);
  });

  it("checks a demand-loaded service only while its latest run intent is to run", async () => {
    const reg = registry([service(serve(), { id: "d1", lifecycle: { loadStrategy: "demand" } })]);
    const intent = (type: "service.started" | "service.stopped") =>
      appendEvent(eventsPath, { type, subjectType: "service", subjectId: "d1", data: {}, actor: "user" });
    const last = async () => (await readEvents(eventsPath, { subjectId: "d1", limit: 1 }))[0]?.type;

    await checkAllServices(reg, eventsPath);
    expect(await last()).toBeUndefined();

    await intent("service.started");
    await checkAllServices(reg, eventsPath);
    expect(await last()).toBe("service.up");

    await intent("service.stopped");
    await checkAllServices(reg, eventsPath);
    expect(await last()).toBe("service.stopped");
  });
});
