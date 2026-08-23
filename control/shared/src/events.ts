import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Event, EventType, HealthState } from "../../../shared/types";

interface AppendEventInput {
  type: EventType;
  subjectType: string;
  subjectId: string;
  data: Record<string, unknown>;
  actor: "system" | "user";
}

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

export async function readEvents(
  eventsPath: string,
  opts: { limit?: number; subjectId?: string } = {}
): Promise<Event[]> {
  let content: string;
  try {
    content = await readFile(eventsPath, "utf-8");
  } catch {
    return [];
  }

  const lines = content.split("\n").filter(l => l.trim());
  let events: Event[] = [];
  for (const line of lines) {
    try { events.push(JSON.parse(line) as Event); } catch { /* skip malformed line */ }
  }
  events.reverse();

  if (opts.subjectId) {
    events = events.filter(e => e.subjectId === opts.subjectId);
  }

  const limit = opts.limit ?? 50;
  return events.slice(0, limit);
}

export async function deriveHealthMap(eventsPath: string): Promise<Map<string, Event>> {
  let content: string;
  try {
    content = await readFile(eventsPath, "utf-8");
  } catch {
    return new Map();
  }

  const lines = content.split("\n").filter(l => l.trim());
  const map = new Map<string, Event>();

  // Read in order (oldest first), later events overwrite earlier ones
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as Event;
      map.set(event.subjectId, event);
    } catch { /* skip malformed line */ }
  }

  return map;
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
