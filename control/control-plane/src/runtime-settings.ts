import { join, isAbsolute } from "node:path"
import { homedir } from "node:os"
import type { Registry } from "../../../shared/types"
import type { PlatformConfig } from "./gateway-config"

/**
 * Values the control plane needs at startup that are not service definitions.
 *
 * These used to live only in environment variables, which made the answer to
 * "where do I change this" depend on which setting you meant. They now come
 * from the files that already own everything else, with the environment kept
 * as an override. A normal run, pointed at a valid registry and config, needs
 * no environment variables at all.
 */
export interface RuntimeSettings {
  port: number
  host: string
  eventsPath: string
  healthIntervalMs: number
  shardPollIntervalMs: number
  /** Where `port` came from — surfaced at startup so an operator can see it. */
  portSource: "registry" | "BANTER_CONTROL_PORT"
}

/** The registry entry describing the control plane itself. */
const CONTROL_SERVICE_ID = "control"

const DEFAULT_HOST = "localhost"
const DEFAULT_HEALTH_INTERVAL_MS = 900_000
const DEFAULT_SHARD_POLL_INTERVAL_MS = 900_000

type Env = Record<string, string | undefined>

function expandHome(path: string): string {
  if (path === "~") return homedir()
  if (path.startsWith("~/")) return join(homedir(), path.slice(2))
  return path
}

/**
 * Parse a positive integer, throwing with a message naming the setting rather
 * than silently yielding NaN — `parseInt("nonsense")` binding port zero is the
 * exact failure this replaces.
 */
function positiveInt(raw: string | number, label: string): number {
  const n = typeof raw === "number" ? raw : Number(raw)
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${label} must be a positive integer, got ${JSON.stringify(raw)}`)
  }
  return n
}

function resolvePort(registry: Registry, env: Env): { port: number; portSource: RuntimeSettings["portSource"] } {
  // The environment wins, but only if it parses — an unusable override is an
  // error, not a reason to fall back to the registry.
  if (env.BANTER_CONTROL_PORT !== undefined && env.BANTER_CONTROL_PORT !== "") {
    return { port: positiveInt(env.BANTER_CONTROL_PORT, "BANTER_CONTROL_PORT"), portSource: "BANTER_CONTROL_PORT" }
  }

  const control = registry.services?.find(s => s.id === CONTROL_SERVICE_ID)
  if (!control) {
    throw new Error(
      `registry has no service with id "${CONTROL_SERVICE_ID}": the control plane reads its ` +
      `listening port from that entry. Add it, or set BANTER_CONTROL_PORT.`
    )
  }

  const port = control.network?.port
  if (port === undefined || port === null) {
    throw new Error(
      `registry service "${CONTROL_SERVICE_ID}" declares no network.port: the control plane ` +
      `reads its listening port from there. Add it, or set BANTER_CONTROL_PORT.`
    )
  }

  return { port: positiveInt(port, `registry service "${CONTROL_SERVICE_ID}" network.port`), portSource: "registry" }
}

function resolveInterval(
  envValue: string | undefined,
  configValue: number | undefined,
  fallback: number,
  label: string,
): number {
  if (envValue !== undefined && envValue !== "") return positiveInt(envValue, label)
  if (configValue !== undefined) return positiveInt(configValue, `config runtime.${label}`)
  return fallback
}

/**
 * Resolve every runtime setting from the registry, the config, and the
 * environment, in that order of increasing precedence.
 *
 * Pure by design: it reads no files and consults no globals, so tests can hand
 * it an empty environment and assert the files alone are sufficient.
 */
export function resolveRuntimeSettings(
  registry: Registry,
  config: PlatformConfig | undefined,
  env: Env,
): RuntimeSettings {
  const runtime = config?.runtime

  const { port, portSource } = resolvePort(registry, env)

  const host = env.BANTER_CONTROL_HOST || runtime?.host || DEFAULT_HOST

  // Defaults to a path inside this deployment. The previous default pointed at
  // ~/services/platform/logs — a directory belonging to a different system,
  // which meant a test run appended to another deployment's event log.
  const rawEventsPath =
    env.BANTER_EVENTS_PATH ||
    runtime?.eventsPath ||
    join(import.meta.dir, "../../../logs/events.jsonl")

  const eventsPath = expandHome(rawEventsPath)

  return {
    port,
    host,
    eventsPath: isAbsolute(eventsPath) ? eventsPath : join(process.cwd(), eventsPath),
    healthIntervalMs: resolveInterval(
      env.BANTER_HEALTH_INTERVAL_MS, runtime?.healthIntervalMs, DEFAULT_HEALTH_INTERVAL_MS, "BANTER_HEALTH_INTERVAL_MS",
    ),
    shardPollIntervalMs: resolveInterval(
      env.BANTER_SHARD_POLL_INTERVAL_MS, runtime?.shardPollIntervalMs, DEFAULT_SHARD_POLL_INTERVAL_MS, "BANTER_SHARD_POLL_INTERVAL_MS",
    ),
    portSource,
  }
}
