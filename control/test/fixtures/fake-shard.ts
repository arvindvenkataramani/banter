// A shard on a real port that serves whatever a test puts in it and records
// every request it receives. GET /api/services, /api/services/:id, /api/events
// and /api/roster answer from the fields below; any other route answers from
// `reply`, else 404.

import type { Event, NodeRoster, ServiceWithHealth } from "../../../shared/types";

export type Reply = { status: number; body?: unknown; text?: string };

export class FakeShard {
  services: ServiceWithHealth[] = [];
  events: Event[] = [];
  /** A roster to serve, or a reply in its place (a 404 from a shard older than the route, a malformed body). */
  roster: NodeRoster | Reply = { ttsModels: [], sttModels: [], providers: {}, voices: [] };
  requests: { method: string; path: string; body: string }[] = [];
  private replies = new Map<string, Reply>();
  private server: ReturnType<typeof Bun.serve>;

  constructor() {
    this.server = Bun.serve({ port: 0, fetch: req => this.handle(req) });
  }

  get port(): number {
    return this.server.port as number;
  }

  get endpoint(): string {
    return `http://localhost:${this.port}`;
  }

  /** Sets the answer to `METHOD /path`. */
  reply(method: string, path: string, reply: Reply): void {
    this.replies.set(`${method} ${path}`, reply);
  }

  received(method: string, path: string): { method: string; path: string; body: string }[] {
    return this.requests.filter(r => r.method === method && r.path === path);
  }

  stop(): void {
    this.server.stop(true);
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const body = ["GET", "HEAD"].includes(req.method) ? "" : await req.text();
    this.requests.push({ method: req.method, path, body });

    const set = this.replies.get(`${req.method} ${path}`);
    if (set) return answer(set);

    if (req.method === "GET") {
      if (path === "/api/services") return Response.json(this.services);
      if (path === "/api/events") return Response.json(this.events);
      if (path === "/api/roster") return "status" in this.roster ? answer(this.roster as Reply) : Response.json(this.roster);
      const one = path.match(/^\/api\/services\/([^/]+)$/);
      if (one) {
        const svc = this.services.find(s => s.id === one[1]);
        return svc ? Response.json(svc) : Response.json({ error: "Service not found" }, { status: 404 });
      }
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  }
}

function answer(reply: Reply): Response {
  if (reply.text !== undefined) return new Response(reply.text, { status: reply.status });
  if (reply.body === undefined) return new Response(null, { status: reply.status });
  return Response.json(reply.body, { status: reply.status });
}

/** A service as a shard reports it. */
export function shardService(id: string, over: Partial<ServiceWithHealth> = {}): ServiceWithHealth {
  return {
    id,
    capabilityId: "tts",
    hostId: "gpu-machine",
    permissions: { enabled: true },
    network: { port: 8000, healthPath: "/health", endpoint: "https://gpu-machine.example.ts.net:8000" },
    health: "unknown",
    lastEvent: null,
    ...over,
  } as ServiceWithHealth;
}
