import type { ServiceWithHealth, Event, NodeRoster, ShardReloadResponse } from "../../../shared/types";

const FETCH_TIMEOUT_MS = 10_000;

// A TLS terminator answering a plaintext request says so in the body and not in
// the status: the status is a bare 400, which reads like the shard rejected the
// request. Keeping a snippet of the body turns that into a diagnosis.
const BODY_SNIPPET_MAX = 200;

// Tailscale Serve, nginx, and Caddy all answer a plaintext request to an HTTPS
// listener with this sentence. It means the endpoint's scheme is http while the
// host actually speaks TLS — a registry that predates `scheme`, most often.
const HTTPS_TO_HTTP_HINT = /client sent an http request to an https server/i;

// Read at most `limit` bytes of a response body. The body is remote input and
// goes into a log line, so it is never buffered whole: res.text() would pull a
// multi-gigabyte response into memory before we truncated it, once per poll.
async function readBodyPrefix(res: Response, limit: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  } catch {
    // A body that cannot be read is not worth failing over — the status stands.
  } finally {
    // Drop the rest; we are not going to read it.
    await reader.cancel().catch(() => {});
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(joined.slice(0, limit));
}

// Remote text reaches a log line here, where a newline would let it forge one —
// a body ending in "\n[shard-poller] gpu-machine: 11 services" would read as a
// second, fabricated entry. Collapse control characters into spaces.
function sanitizeForLog(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
}

// Build the error for a non-ok shard response, reading the body for a cause the
// status alone does not carry.
async function shardResponseError(endpoint: string, res: Response): Promise<Error> {
  const body = sanitizeForLog(await readBodyPrefix(res, BODY_SNIPPET_MAX));

  if (HTTPS_TO_HTTP_HINT.test(body)) {
    return new Error(
      `Shard returned ${res.status}: the endpoint ${endpoint} is http, but the host answered TLS. ` +
        `Set "scheme": "https" on this shard's registry entry.`
    );
  }

  const snippet = body.slice(0, BODY_SNIPPET_MAX);
  return new Error(`Shard returned ${res.status}${snippet ? `: ${snippet}` : ""}`);
}

export async function fetchShardServices(endpoint: string): Promise<ServiceWithHealth[]> {
  const url = `${endpoint}/api/services`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw await shardResponseError(endpoint, res);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchShardService(endpoint: string, serviceId: string): Promise<ServiceWithHealth | null> {
  const url = `${endpoint}/api/services/${serviceId}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (res.status === 404) return null;
    if (!res.ok) throw await shardResponseError(endpoint, res);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchShardEvents(
  endpoint: string,
  opts?: { limit?: number; subjectId?: string }
): Promise<Event[]> {
  const url = new URL(`${endpoint}/api/events`);
  if (opts?.limit) url.searchParams.set("limit", String(opts.limit));
  if (opts?.subjectId) url.searchParams.set("subjectId", opts.subjectId);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url.toString(), { signal: controller.signal });
    if (!res.ok) throw await shardResponseError(endpoint, res);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

/** Never throws. An unreachable shard, a non-2xx response, a 404 (shard
 *  older than this route) or a body missing `registry` all resolve to
 *  `{ registry: { ok: false, error }, warnings: [] }`. */
export async function reloadShard(endpoint: string): Promise<ShardReloadResponse> {
  const url = `${endpoint}/api/config/reload`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, { method: "POST", signal: controller.signal });
    let data: any = null;
    try { data = await res.json(); } catch { /* empty or non-JSON body */ }
    if (data && typeof data.registry === "object" && data.registry !== null) {
      return { registry: data.registry, warnings: Array.isArray(data.warnings) ? data.warnings : [] };
    }
    return { registry: { ok: false, error: data?.error ?? `shard returned ${res.status}` }, warnings: [] };
  } catch (err) {
    return { registry: { ok: false, error: err instanceof Error ? err.message : String(err) }, warnings: [] };
  } finally {
    clearTimeout(timeout);
  }
}

export async function proxyShardAction(
  endpoint: string,
  serviceId: string,
  action: "start" | "stop" | "restart"
): Promise<{ ok: boolean; status?: number; data?: any; error?: string }> {
  const url = `${endpoint}/api/services/${serviceId}/${action}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, { method: "POST", signal: controller.signal });
    let data: any = null;
    try { data = await res.json(); } catch { /* empty or non-JSON body */ }
    if (!res.ok) {
      return { ok: false, status: res.status, data, error: data?.error ?? `shard returned ${res.status}` };
    }
    return { ok: true, status: res.status, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

export async function proxyShardPatch(
  endpoint: string,
  serviceId: string,
  patch: Record<string, unknown>
): Promise<{ ok: boolean; status?: number; data?: any; error?: string }> {
  const url = `${endpoint}/api/services/${serviceId}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
      signal: controller.signal,
    });
    let data: any = null;
    try { data = await res.json(); } catch { /* shard may return non-JSON on 500 */ }
    if (!res.ok) {
      return { ok: false, status: res.status, data, error: data?.error ?? `shard returned ${res.status}` };
    }
    return { ok: true, status: res.status, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

export async function proxyShardEnabledToggle(
  endpoint: string,
  serviceId: string,
  body: { enabled: boolean }
): Promise<{ ok: boolean; status?: number; data?: any; error?: string }> {
  const url = `${endpoint}/api/services/${serviceId}/enabled`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let data: any = null;
    try { data = await res.json(); } catch { /* shard may return non-JSON on 500 */ }
    if (!res.ok) {
      return { ok: false, status: res.status, data, error: data?.error ?? `shard returned ${res.status}` };
    }
    return { ok: true, status: res.status, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

export async function proxyShardInfo(
  endpoint: string,
  serviceId: string
): Promise<{ ok: boolean; status?: number; data?: any; error?: string }> {
  const url = `${endpoint}/api/services/${serviceId}/info`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    let data: any = null;
    try { data = await res.json(); } catch { /* shard may return non-JSON on 500 */ }
    if (!res.ok) {
      return { ok: false, status: res.status, data, error: data?.error ?? `shard returned ${res.status}` };
    }
    return { ok: true, status: res.status, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

export async function proxyShardCheck(
  endpoint: string,
  serviceId: string
): Promise<{ ok: boolean; status?: number; data?: any; error?: string }> {
  const url = `${endpoint}/api/services/${serviceId}/check`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, { method: "POST", signal: controller.signal });
    let data: any = null;
    try { data = await res.json(); } catch { /* empty or non-JSON body */ }
    if (!res.ok) {
      return { ok: false, status: res.status, data, error: data?.error ?? `shard returned ${res.status}` };
    }
    return { ok: true, status: res.status, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

/** Tell the shard a service is still in use, so its idle loop defers eviction.
 * Activity is runtime state and belongs in the shard's ping map — the
 * `idleUnload` flag in the registry is declared policy and is never written to
 * say "busy right now". */
export async function proxyShardPing(
  endpoint: string,
  serviceId: string
): Promise<{ ok: boolean; status?: number; data?: any; error?: string }> {
  const url = `${endpoint}/ping/${serviceId}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, { method: "POST", signal: controller.signal });
    let data: any = null;
    try { data = await res.json(); } catch { /* empty or non-JSON body */ }
    if (!res.ok) {
      return { ok: false, status: res.status, data, error: data?.error ?? `shard returned ${res.status}` };
    }
    return { ok: true, status: res.status, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Null only for a 404 (shard older than this route) or a malformed body.
 *  Any other failure throws — the poller keeps the last cached roster
 *  rather than clearing it. */
export async function fetchShardRoster(endpoint: string): Promise<NodeRoster | null> {
  const url = `${endpoint}/api/roster`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Shard returned ${res.status}`);
    const body = await res.json();
    if (!isRecord(body) || !isRecord(body.providers) || !Array.isArray(body.voices)) return null;
    return body as unknown as NodeRoster;
  } finally {
    clearTimeout(timeout);
  }
}
