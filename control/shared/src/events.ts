import { writeFile, mkdir, open, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { Event, EventType, HealthState, Service } from "../../../shared/types";

interface AppendEventInput {
  type: EventType;
  subjectType: string;
  subjectId: string;
  data: Record<string, unknown>;
  actor: "system" | "user";
}

const NEWLINE = 0x0a;
const TAIL_CHUNK_BYTES = 64 * 1024;

export async function appendEvent(eventsPath: string, input: AppendEventInput): Promise<Event> {
  const event: Event = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    ...input,
  };

  await mkdir(dirname(eventsPath), { recursive: true });
  await writeFile(eventsPath, JSON.stringify(event) + "\n", { flag: "a" });
  return event;
}

function parseLine(line: string): Event | undefined {
  if (!line.trim()) return undefined;
  try { return JSON.parse(line) as Event; } catch { return undefined; }
}

/**
 * Newest first, at most `limit` (default 50), optionally only one subject's.
 * Reads backwards from the end of the file in chunks and stops once it has
 * enough, so a small limit costs the same however long the log has grown.
 */
export async function readEvents(
  eventsPath: string,
  opts: { limit?: number; subjectId?: string } = {}
): Promise<Event[]> {
  const limit = opts.limit ?? 50;
  const { subjectId } = opts;
  const events: Event[] = [];
  if (limit <= 0) return events;

  let fh;
  try {
    fh = await open(eventsPath, "r");
  } catch {
    return events;
  }

  try {
    let pos = (await fh.stat()).size;
    // Bytes of a line cut by the chunk boundary, carried into the next read.
    // Splitting on the newline byte is safe: it never occurs inside a
    // multi-byte UTF-8 sequence.
    let carry = Buffer.alloc(0);

    while (pos > 0 && events.length < limit) {
      const len = Math.min(TAIL_CHUNK_BYTES, pos);
      pos -= len;
      const chunk = Buffer.alloc(len);
      await fh.read(chunk, 0, len, pos);
      const data = carry.length ? Buffer.concat([chunk, carry]) : chunk;

      let start = 0;
      if (pos > 0) {
        const first = data.indexOf(NEWLINE);
        if (first === -1) { carry = data; continue; }
        carry = data.subarray(0, first);
        start = first + 1;
      } else {
        carry = Buffer.alloc(0);
      }

      const lines = data.subarray(start).toString("utf-8").split("\n");
      for (let i = lines.length - 1; i >= 0 && events.length < limit; i--) {
        const line = lines[i];
        if (subjectId && !line.includes(subjectId)) continue;
        const event = parseLine(line);
        if (!event) continue;
        if (subjectId && event.subjectId !== subjectId) continue;
        events.push(event);
      }
    }
  } finally {
    await fh.close();
  }

  return events;
}

interface LogCache {
  ino: number;
  /** Bytes consumed: everything before this offset is reflected below. */
  offset: number;
  /** The most recent health-deciding event per subject. */
  health: Map<string, Event>;
  /** Per subject, whether its latest start/stop-type event asks for it to run. */
  runIntent: Map<string, boolean>;
  /** The refresh in progress, so concurrent callers never read a range twice. */
  refreshing?: Promise<void>;
}

const RUN_INTENT: Partial<Record<EventType, boolean>> = {
  "service.started": true,
  "service.restarted": true,
  "service.stopped": false,
  "service.unloaded": false,
  "service.disabled": false,
};

const logCaches = new Map<string, LogCache>();

async function refreshCache(eventsPath: string, cache: LogCache, size: number): Promise<void> {
  if (size <= cache.offset) return;
  const fh = await open(eventsPath, "r");
  let data: Buffer;
  try {
    data = Buffer.alloc(size - cache.offset);
    await fh.read(data, 0, data.length, cache.offset);
  } finally {
    await fh.close();
  }

  const apply = (line: string) => {
    const event = parseLine(line);
    if (!event) return;
    // An install is a record of what was placed on disk, not a statement about
    // whether the service answers, so it never becomes the health-deciding event.
    if (event.type !== "service.installed") cache.health.set(event.subjectId, event);
    const intent = RUN_INTENT[event.type];
    if (intent !== undefined) cache.runIntent.set(event.subjectId, intent);
  };

  const last = data.lastIndexOf(NEWLINE);
  if (last >= 0) {
    for (const line of data.subarray(0, last).toString("utf-8").split("\n")) apply(line);
    cache.offset += last + 1;
  }
  // A final line with no newline yet is applied but not consumed: if it is
  // still being written, the next refresh reads it again whole.
  apply(data.subarray(last + 1).toString("utf-8"));
}

/**
 * The derived state of one log, kept in memory per file and brought up to
 * date by reading only what was appended since the last call. A file that
 * was replaced or truncated is read again from the start.
 */
async function currentCache(eventsPath: string): Promise<LogCache | undefined> {
  let cache = logCaches.get(eventsPath);
  while (cache?.refreshing) {
    await cache.refreshing;
    cache = logCaches.get(eventsPath);
  }

  let st;
  try {
    st = await stat(eventsPath);
  } catch {
    logCaches.delete(eventsPath);
    return undefined;
  }

  cache = logCaches.get(eventsPath);
  if (!cache || cache.ino !== st.ino || st.size < cache.offset) {
    cache = { ino: st.ino, offset: 0, health: new Map(), runIntent: new Map() };
    logCaches.set(eventsPath, cache);
  }

  if (!cache.refreshing) {
    const current = cache;
    current.refreshing = refreshCache(eventsPath, current, st.size).finally(() => { current.refreshing = undefined; });
  }
  await cache.refreshing;
  return cache;
}

/** The most recent health-deciding event per subject. */
export async function deriveHealthMap(eventsPath: string): Promise<Map<string, Event>> {
  const cache = await currentCache(eventsPath);
  return new Map(cache?.health);
}

/** Per subject, whether its latest start, restart, stop, unload or disable
 *  asks for it to run. A subject with none of those is absent. */
export async function deriveRunIntentMap(eventsPath: string): Promise<Map<string, boolean>> {
  const cache = await currentCache(eventsPath);
  return new Map(cache?.runIntent);
}

export interface ServiceHealth {
  health: HealthState;
  lastEvent: Event | null;
}

/**
 * A service's health as the API reports it. `off` is a service not meant to
 * be running and not seen running: its latest run intent is stop, unload or
 * disable, or it is demand-loaded and has never been started, and its last
 * health event is not a running one. Off is separate from down, which means
 * meant to be running and not answering. A check that finds it answering
 * still wins, so a service started outside the platform shows what it is.
 */
export async function deriveServiceHealth(eventsPath: string): Promise<(svc: Service) => ServiceHealth> {
  const cache = await currentCache(eventsPath);
  const health = cache?.health ?? new Map<string, Event>();
  const runIntent = cache?.runIntent ?? new Map<string, boolean>();
  return (svc) => {
    if (!svc.permissions.enabled) return { health: "disabled", lastEvent: null };
    const lastEvent = health.get(svc.id) ?? null;
    const intent = runIntent.get(svc.id);
    const observed = deriveHealth(lastEvent);
    const notMeantToRun = intent === false || (intent === undefined && svc.lifecycle?.loadStrategy === "demand");
    const seenRunning = observed === "healthy" || observed === "degraded" || observed === "timed_out";
    return { health: notMeantToRun && !seenRunning ? "off" : observed, lastEvent };
  };
}

export function deriveHealth(event: Event | null): HealthState {
  if (!event) return "unknown";
  switch (event.type) {
    case "service.up": return "healthy";
    case "service.degraded": return "degraded";
    case "service.down": return "down";
    case "service.timed_out": return "timed_out";
    case "service.disabled": return "disabled";
    case "service.enabled": return "unknown";
    case "service.restarted": return "unknown";
    case "service.started": return "unknown";
    case "service.stopped": return "down";
    case "service.unloaded": return "down";
    case "service.installed": return "unknown";
    case "service.uninstalled": return "down";
    case "memory.pressure": return "down";
    default: return "unknown";
  }
}
