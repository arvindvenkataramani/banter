import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { withFileLock, writeFileAtomic, writeFileAtomicUnlocked } from "./atomic-write";
import { syncDocument } from "./live-config/sync";
import { registrySpec } from "./live-config/schemas";
import { validateRoster, emptyRoster } from "./roster";
import type { Registry, Service, ReloadWarning, Provider, NodeRoster } from "../../../shared/types";

// ── Patch allowlists ──────────────────────────────────────────────────────────

const PATCHABLE_TOP = new Set(["capabilityId", "hostId", "notes"]);
const PATCHABLE_NETWORK = new Set(["port", "healthPath", "listenAddress", "tailscaleServe", "scheme"]);
const PATCHABLE_LIFECYCLE = new Set(["loadStrategy", "autoStart", "idleUnload", "idleTimeout", "startupTime", "restartOnCrash", "maxRestarts", "restartBackoff", "serveRetryAttempts", "serveRetryDelay"]);
const PATCHABLE_PERMISSIONS = new Set(["enabled"]);
const PATCHABLE_GROUPS = new Set(["permissions", "network", "lifecycle"]);

// ── Clearable fields ───────────────────────────────────────────────────────────

// `null` in a patch means "remove this field", and only these fields accept it.
// Everything else is required by validateRegistry — `port`, `healthPath`,
// `hostId`, `capabilityId` — so clearing one is refused with a message naming
// the field, before the whole-file validation would reject it less clearly.
//
// Removing rather than storing null matters for the defaults-backed fields:
// validateRegistry merges `{...defaults.lifecycle, ...svc.lifecycle}`, so a
// stored null shadows the default while an absent key inherits it.
const CLEARABLE_TOP = new Set(["notes"]);
const CLEARABLE_NETWORK = new Set(["listenAddress"]);
const CLEARABLE_LIFECYCLE = new Set(["idleTimeout", "startupTime", "maxRestarts", "restartBackoff", "serveRetryAttempts", "serveRetryDelay"]);

function applyGroupPatch(
  group: Record<string, unknown>,
  groupPatch: Record<string, unknown>,
  clearable: Set<string>,
  groupName: string
): Record<string, unknown> {
  const next = { ...group };
  for (const [key, value] of Object.entries(groupPatch)) {
    if (value === null) {
      if (!clearable.has(key)) throw new Error(`${groupName}.${key} cannot be cleared`);
      delete next[key];
    } else {
      next[key] = value;
    }
  }
  return next;
}

// ── Defaults allowlists ────────────────────────────────────────────────────────

const DEFAULTABLE_PERMISSIONS = new Set(["protected"]);
const DEFAULTABLE_NETWORK = new Set(["tailscaleServe", "scheme"]);
const DEFAULTABLE_LIFECYCLE = new Set(["loadStrategy", "idleUnload", "idleTimeout", "autoStart", "shutdown", "startupTime", "serveRetryAttempts", "serveRetryDelay"]);
const DEFAULTABLE_GROUPS = new Set(["permissions", "network", "lifecycle"]);

// ── Endpoint scheme ────────────────────────────────────────────────────────────

// http unless `scheme` says otherwise — per service, or once in
// `defaults.network` for the whole registry. Banter does not assume a tailnet,
// so a LAN or plain-IP install works as shipped; a tailnet install sets
// `scheme: "https"` in `defaults.network`. See docs/guide/remote-access.md for why
// https is the safer choice where it is available.
//
// Nothing infers the protocol. `listenAddress` says which address, and
// `tailscaleServe` says whether to register with Serve on start; neither says
// which protocol, and reading either as a scheme switch is how a service ends
// up with an endpoint nothing can answer.
function defaultScheme(_hostname: string | undefined): "http" | "https" {
  return "http";
}

function isScheme(value: unknown): value is "http" | "https" {
  return value === "http" || value === "https";
}

const SHARD_ONLY: Record<string, Set<string>> = {
  network: new Set(["tailscaleServe"]),
  lifecycle: new Set(["idleUnload", "idleTimeout", "autoStart", "shutdown"]),
};

// ── Validation ─────────────────────────────────────────────────────────────────

// A path an install copies from or to. Relative, and never climbing out: the
// install scripts resolve `from` against the source tree and `to` against the
// working directory, and a path that escaped either would read or overwrite
// files the registry has no business naming.
function isContainedPath(p: unknown): p is string {
  return typeof p === "string" && p.length > 0 && !isAbsolute(p) && !p.split("/").includes("..");
}

function validateInstall(svc: Record<string, unknown>): void {
  const ops = svc.ops as Record<string, unknown> | undefined;
  if (ops?.install === undefined) return;
  const install = ops.install as Record<string, unknown>;
  const artifacts = install?.artifacts;
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    throw new Error(`service ${svc.id}: ops.install.artifacts must be a non-empty array`);
  }
  for (const a of artifacts as Record<string, unknown>[]) {
    for (const key of ["from", "to"] as const) {
      if (a?.[key] === undefined) throw new Error(`service ${svc.id}: an install artifact is missing ${key}`);
      if (!isContainedPath(a[key])) {
        throw new Error(`service ${svc.id}: install artifact ${key} "${a[key]}" must be a relative path without ..`);
      }
    }
  }
  const env = ops.env as Record<string, unknown> | undefined;
  if (typeof env?.workingDirectory !== "string") {
    throw new Error(`service ${svc.id}: ops.install needs ops.env.workingDirectory to install into`);
  }
}

/** Semantic validation of a registry document; fills defaults and derived fields in place. */
export function validateRegistry(data: unknown): Registry {
  const d = data as Record<string, unknown>;

  // Type check
  if (d.type !== "control" && d.type !== "shard") throw new Error(`registry: invalid type (expected "control" or "shard", got "${d.type}")`);

  if (d.intervals !== undefined) {
    if (typeof d.intervals !== "object" || d.intervals === null || Array.isArray(d.intervals)) {
      throw new Error("registry: intervals must be an object");
    }
    const intervals = d.intervals as Record<string, unknown>;
    for (const [key, value] of Object.entries(intervals)) {
      if (key !== "healthMs" && key !== "shardPollMs") throw new Error(`registry: unknown field in intervals: "${key}"`);
      if (key === "shardPollMs" && d.type === "shard") throw new Error("registry: intervals.shardPollMs is control-only");
      if (!Number.isInteger(value) || (value as number) <= 0) {
        throw new Error(`registry: intervals.${key} must be a positive integer, got ${JSON.stringify(value)}`);
      }
    }
  }

  // Defaults validation
  if (d.defaults !== undefined) {
    if (typeof d.defaults !== "object" || d.defaults === null || Array.isArray(d.defaults)) {
      throw new Error("registry: defaults must be an object");
    }
    const defaults = d.defaults as Record<string, unknown>;
    for (const groupKey of Object.keys(defaults)) {
      if (!DEFAULTABLE_GROUPS.has(groupKey)) {
        throw new Error(`registry: unknown group in defaults: "${groupKey}"`);
      }
      const group = defaults[groupKey] as Record<string, unknown>;
      if (typeof group !== "object" || group === null || Array.isArray(group)) {
        throw new Error(`registry: defaults.${groupKey} must be an object`);
      }

      let allowedKeys: Set<string>;
      if (groupKey === "permissions") allowedKeys = DEFAULTABLE_PERMISSIONS;
      else if (groupKey === "network") allowedKeys = DEFAULTABLE_NETWORK;
      else allowedKeys = DEFAULTABLE_LIFECYCLE;

      for (const key of Object.keys(group)) {
        if (!allowedKeys.has(key)) {
          throw new Error(`registry: unknown field in defaults.${groupKey}: "${key}"`);
        }
        if (d.type === "control" && SHARD_ONLY[groupKey]?.has(key)) {
          throw new Error(`registry: shard-only field in defaults on control registry: "${groupKey}.${key}"`);
        }
      }

      // Type-check default values
      if (groupKey === "permissions") {
        if ("protected" in group && typeof group.protected !== "boolean") throw new Error("defaults.permissions.protected must be boolean");
      }
      if (groupKey === "network") {
        if ("tailscaleServe" in group && typeof group.tailscaleServe !== "boolean") throw new Error("defaults.network.tailscaleServe must be boolean");
        if ("scheme" in group && !isScheme(group.scheme)) throw new Error(`defaults.network.scheme must be "http" or "https", got ${JSON.stringify(group.scheme)}`);
      }
      if (groupKey === "lifecycle") {
        if ("loadStrategy" in group && !["startup", "demand"].includes(group.loadStrategy as string)) throw new Error("defaults.lifecycle.loadStrategy must be 'startup' or 'demand'");
        if ("idleUnload" in group && typeof group.idleUnload !== "boolean") throw new Error("defaults.lifecycle.idleUnload must be boolean");
        if ("idleTimeout" in group && typeof group.idleTimeout !== "number") throw new Error("defaults.lifecycle.idleTimeout must be number");
        if ("autoStart" in group && typeof group.autoStart !== "boolean") throw new Error("defaults.lifecycle.autoStart must be boolean");
        if ("shutdown" in group && typeof group.shutdown !== "boolean") throw new Error("defaults.lifecycle.shutdown must be boolean");
        if ("startupTime" in group && typeof group.startupTime !== "number") throw new Error("defaults.lifecycle.startupTime must be number");
        if ("serveRetryAttempts" in group) {
          if (!Number.isInteger(group.serveRetryAttempts) || (group.serveRetryAttempts as number) < 1) {
            throw new Error("defaults.lifecycle.serveRetryAttempts must be an integer >= 1");
          }
        }
        if ("serveRetryDelay" in group && typeof group.serveRetryDelay !== "number") throw new Error("defaults.lifecycle.serveRetryDelay must be number");
      }
    }
  }

  if (!Array.isArray(d.hosts)) throw new Error("registry: missing hosts array");
  if (!Array.isArray(d.capabilities)) throw new Error("registry: missing capabilities array");
  if (!Array.isArray(d.services)) throw new Error("registry: missing services array");

  const capIds = new Set((d.capabilities as Record<string, unknown>[]).map(c => {
    if (!c.id) throw new Error("capability missing id");
    return c.id as string;
  }));
  const hostIds = new Set((d.hosts as Record<string, unknown>[]).map(h => {
    if (!h.id) throw new Error("host missing id");
    if (!h.hostname) throw new Error(`host ${h.id}: missing hostname`);
    if (h.port !== undefined && (!Number.isInteger(h.port) || (h.port as number) <= 0)) {
      throw new Error(`host ${h.id}: port must be a positive integer`);
    }
    return h.id as string;
  }));

  const hostMap = new Map((d.hosts as Record<string, unknown>[]).map(h => [h.id as string, h.hostname as string]));

  for (const svc of d.services as Record<string, unknown>[]) {
    if (!svc.id) throw new Error("service missing id");
    if (!svc.capabilityId) throw new Error(`service ${svc.id}: missing capabilityId`);
    if (!svc.hostId) throw new Error(`service ${svc.id}: missing hostId`);
    if (!capIds.has(svc.capabilityId as string)) {
      throw new Error(`service ${svc.id}: capabilityId "${svc.capabilityId}" references nonexistent capability`);
    }
    if (!hostIds.has(svc.hostId as string)) {
      throw new Error(`service ${svc.id}: hostId "${svc.hostId}" references nonexistent host`);
    }

    // Ensure required groups exist
    if (typeof svc.permissions !== "object" || svc.permissions === null) {
      svc.permissions = {};
    }
    if (typeof svc.network !== "object" || svc.network === null) {
      svc.network = {};
    }

    // Merge defaults per group (before required-field validation)
    if (d.defaults !== undefined) {
      const defaults = d.defaults as Record<string, Record<string, unknown>>;
      if (defaults.permissions) {
        svc.permissions = { ...defaults.permissions, ...(svc.permissions as Record<string, unknown>) };
      }
      if (defaults.network) {
        svc.network = { ...defaults.network, ...(svc.network as Record<string, unknown>) };
      }
      if (defaults.lifecycle) {
        svc.lifecycle = { ...defaults.lifecycle, ...(typeof svc.lifecycle === "object" && svc.lifecycle !== null ? svc.lifecycle as Record<string, unknown> : {}) };
      }
    }

    // Validate runner (required)
    if (svc.runner === undefined) throw new Error(`service ${svc.id}: runner is required`);
    const runner = svc.runner as Record<string, unknown>;
    const runnerType = runner.type as string | undefined;
    if (!["process", "systemd", "launchd", "external", "managed"].includes(runnerType ?? "")) {
      throw new Error(`service ${svc.id}: runner.type must be one of: process, systemd, launchd, external, managed`);
    }
    if (runnerType === "process" && !runner.main) {
      throw new Error(`service ${svc.id}: process runner requires runner.main`);
    }
    if (runnerType === "systemd" && (!runner.unit || !runner.unitFile)) {
      throw new Error(`service ${svc.id}: systemd runner requires runner.unit and runner.unitFile`);
    }
    if (runnerType === "launchd" && (!runner.label || !runner.plist)) {
      throw new Error(`service ${svc.id}: launchd runner requires runner.label and runner.plist`);
    }
    if (runnerType === "managed" && (!runner.startCmd || !runner.stopCmd || !runner.healthCmd)) {
      throw new Error(`service ${svc.id}: managed runner requires runner.startCmd, runner.stopCmd, and runner.healthCmd`);
    }

    const perm = svc.permissions as Record<string, unknown>;
    const net = svc.network as Record<string, unknown>;

    if (typeof perm.enabled !== "boolean") throw new Error(`service ${svc.id}: permissions.enabled must be a boolean`);
    // Managed runners have no HTTP health surface — health comes from runner.healthCmd, not a URL.
    if (runnerType !== "managed") {
      if (!net.healthPath) throw new Error(`service ${svc.id}: network.healthPath is required`);
      if (!net.port) throw new Error(`service ${svc.id}: network.port is required`);
    }

    if (net.scheme !== undefined && !isScheme(net.scheme)) {
      throw new Error(`service ${svc.id}: network.scheme must be "http" or "https", got ${JSON.stringify(net.scheme)}`);
    }

    validateInstall(svc);

    // network.port is the only place a service's port is written. A process
    // receives it as {port} in runner.main and as PORT in its environment, so
    // a second copy in either could only drift from it.
    const mainCmd = runner.main;
    if (typeof mainCmd === "string" && /--port[= ]\d/.test(mainCmd)) {
      throw new Error(`service ${svc.id}: runner.main writes a port; use {port}, which is filled from network.port`);
    }
    const variables = (svc.ops as { env?: { variables?: Record<string, unknown> } } | undefined)?.env?.variables;
    if (variables && "PORT" in variables) {
      throw new Error(`service ${svc.id}: ops.env.variables sets PORT; a process receives PORT from network.port`);
    }

    // A port gives a service an address whatever its runner. How its health is
    // checked is the runner's business: a managed runner uses healthCmd.
    if (net.port) {
      const listenAddr = net.listenAddress as string | undefined;
      const hostname = listenAddr ?? hostMap.get(svc.hostId as string);
      net.endpoint = `${net.scheme ?? defaultScheme(hostname)}://${hostname}:${net.port}`;
    }
  }

  // Must run after the services validated above — a provider naming no
  // service needs to fail against the checked list.
  d.roster = validateRoster(d.roster, d.services as Service[]);

  // Validate optional shards array
  if (d.shards !== undefined) {
    if (!Array.isArray(d.shards)) throw new Error("registry: shards must be an array");
    for (const shard of d.shards as Record<string, unknown>[]) {
      if (!shard.hostId) throw new Error("shard missing hostId");
      if (!shard.port) throw new Error("shard missing port");
      if (!hostIds.has(shard.hostId as string)) {
        throw new Error(`shard: hostId "${shard.hostId}" references nonexistent host`);
      }
      if (shard.scheme !== undefined && !isScheme(shard.scheme)) {
        throw new Error(`shard ${shard.hostId}: scheme must be "http" or "https", got ${JSON.stringify(shard.scheme)}`);
      }
      const shardHostname = hostMap.get(shard.hostId as string)!;
      shard.endpoint = `${shard.scheme ?? defaultScheme(shardHostname)}://${shardHostname}:${shard.port}`;
    }
  }

  return data as Registry;
}

// Reads the file and syncs it with the registry schema. The synced file is
// written back when `write` names a lock mode and the sync changed it and the
// file is not from newer code; warnings go to the log.
async function readSyncedRegistry(path: string, write: "none" | "locked" | "held"): Promise<Record<string, unknown>> {
  const raw = JSON.parse(await readFile(path, "utf-8"));
  const result = syncDocument(raw, registrySpec);
  for (const w of result.warnings) console.warn(`registry: ${w}`);
  if (result.changed && result.writable && write !== "none") {
    const text = JSON.stringify(result.doc, null, 2) + "\n";
    if (write === "locked") await writeFileAtomic(path, text);
    else await writeFileAtomicUnlocked(path, text);
  }
  return result.doc as Record<string, unknown>;
}

export async function loadRegistry(path: string): Promise<Registry> {
  return validateRegistry(await readSyncedRegistry(path, "locked"));
}

// ── updateService ──────────────────────────────────────────────────────────────

type NestedPatch = {
  capabilityId?: string;
  hostId?: string;
  notes?: string | null;
  permissions?: Record<string, unknown>;
  network?: Record<string, unknown>;
  lifecycle?: Record<string, unknown>;
};

export async function updateService(
  state: Registry,
  registryPath: string,
  serviceId: string,
  patch: NestedPatch
): Promise<Service> {
  // The lock spans the whole read-modify-write, not just the write. Two
  // concurrent patches both read `state.services`, and serialising only the
  // write would still let the second overwrite the first's change.
  return withFileLock(registryPath, async () => {
    const idx = state.services.findIndex(s => s.id === serviceId);
    if (idx === -1) throw new Error(`service "${serviceId}" not found`);

    // The patch applies to the service as written on disk, not to the loaded
    // copy: that copy carries values merged in from `defaults` and a derived
    // endpoint, and writing it back would pin every default into the file.
    const doc = await readSyncedRegistry(registryPath, "none") as { services: Record<string, unknown>[] };
    const rawIdx = doc.services.findIndex(s => s.id === serviceId);
    if (rawIdx === -1) throw new Error(`service "${serviceId}" not found in ${registryPath}`);
    const updated = structuredClone(doc.services[rawIdx]) as unknown as Service;

    for (const key of Object.keys(patch) as (keyof NestedPatch)[]) {
      if (PATCHABLE_TOP.has(key)) {
        const value = (patch as Record<string, unknown>)[key];
        if (value === null) {
          if (!CLEARABLE_TOP.has(key)) throw new Error(`${key} cannot be cleared`);
          delete (updated as unknown as Record<string, unknown>)[key];
        } else {
          if (typeof value !== "string") throw new Error(`${key} must be a string`);
          (updated as unknown as Record<string, unknown>)[key] = value;
        }
      } else if (key === "permissions") {
        const permPatch = (patch as Record<string, unknown>).permissions as Record<string, unknown>;
        for (const subKey of Object.keys(permPatch)) {
          if (!PATCHABLE_PERMISSIONS.has(subKey)) throw new Error(`unknown field "permissions.${subKey}"`);
        }
        if ("enabled" in permPatch && typeof permPatch.enabled !== "boolean") {
          throw new Error("permissions.enabled must be a boolean");
        }
        updated.permissions = { ...updated.permissions, ...permPatch } as typeof updated.permissions;
      } else if (key === "network") {
        const networkPatch = patch.network!;
        for (const subKey of Object.keys(networkPatch)) {
          if (!PATCHABLE_NETWORK.has(subKey)) throw new Error(`unknown field "network.${subKey}"`);
        }
        if ("port" in networkPatch && networkPatch.port !== undefined && networkPatch.port !== null && typeof networkPatch.port !== "number") {
          throw new Error("network.port must be a number");
        }
        if ("tailscaleServe" in networkPatch && networkPatch.tailscaleServe !== undefined && typeof networkPatch.tailscaleServe !== "boolean") {
          throw new Error("network.tailscaleServe must be a boolean");
        }
        if ("scheme" in networkPatch && networkPatch.scheme !== undefined && !isScheme(networkPatch.scheme)) {
          throw new Error(`network.scheme must be "http" or "https", got ${JSON.stringify(networkPatch.scheme)}`);
        }
        updated.network = applyGroupPatch(
          updated.network as unknown as Record<string, unknown>,
          networkPatch,
          CLEARABLE_NETWORK,
          "network"
        ) as unknown as typeof updated.network;
      } else if (key === "lifecycle") {
        const lifecyclePatch = patch.lifecycle!;
        for (const subKey of Object.keys(lifecyclePatch)) {
          if (!PATCHABLE_LIFECYCLE.has(subKey)) throw new Error(`unknown field "lifecycle.${subKey}"`);
        }
        if ("idleTimeout" in lifecyclePatch && lifecyclePatch.idleTimeout !== undefined && lifecyclePatch.idleTimeout !== null && typeof lifecyclePatch.idleTimeout !== "number") {
          throw new Error("lifecycle.idleTimeout must be a number");
        }
        if ("loadStrategy" in lifecyclePatch && lifecyclePatch.loadStrategy !== undefined && !["startup", "demand"].includes(lifecyclePatch.loadStrategy as string)) {
          throw new Error('lifecycle.loadStrategy must be "startup" or "demand"');
        }
        if ("startupTime" in lifecyclePatch && lifecyclePatch.startupTime !== undefined && lifecyclePatch.startupTime !== null && typeof lifecyclePatch.startupTime !== "number") {
          throw new Error("lifecycle.startupTime must be a number");
        }
        if ("serveRetryAttempts" in lifecyclePatch && lifecyclePatch.serveRetryAttempts !== undefined && lifecyclePatch.serveRetryAttempts !== null) {
          if (!Number.isInteger(lifecyclePatch.serveRetryAttempts) || (lifecyclePatch.serveRetryAttempts as number) < 1) {
            throw new Error("lifecycle.serveRetryAttempts must be an integer >= 1");
          }
        }
        if ("serveRetryDelay" in lifecyclePatch && lifecyclePatch.serveRetryDelay !== undefined && lifecyclePatch.serveRetryDelay !== null && typeof lifecyclePatch.serveRetryDelay !== "number") {
          throw new Error("lifecycle.serveRetryDelay must be a number");
        }
        updated.lifecycle = applyGroupPatch(
          (updated.lifecycle ?? {}) as unknown as Record<string, unknown>,
          lifecyclePatch,
          CLEARABLE_LIFECYCLE,
          "lifecycle"
        ) as unknown as typeof updated.lifecycle;
      } else {
        throw new Error(`unknown field "${key}"`);
      }
    }

    doc.services[rawIdx] = updated as unknown as Record<string, unknown>;
    // Validated as a whole before anything is written, so a patch that would
    // leave the file unloadable is refused here rather than at the next start.
    const loaded = validateRegistry(structuredClone(doc));
    const merged = loaded.services.find(s => s.id === serviceId)!;
    if (state.services[idx].state) merged.state = state.services[idx].state;
    state.services[idx] = merged;

    await writeFileAtomicUnlocked(registryPath, JSON.stringify(doc, null, 2));
    return merged;
  });
}

export async function setEnabled(
  state: Registry,
  registryPath: string,
  serviceId: string,
  enabled: boolean
): Promise<Service> {
  return updateService(state, registryPath, serviceId, { permissions: { enabled } });
}

// ── reloadRegistry ────────────────────────────────────────────────────────

export type RegistryReloadResult =
  | { ok: true; warnings: ReloadWarning[] }
  | { ok: false; error: string };

/** True when a shard list changed. Order matters; `endpoint` is excluded
 *  because it's derived, not independently editable. */
function shardsChanged(before: Registry["shards"], after: Registry["shards"]): boolean {
  const strip = (shards: Registry["shards"]) =>
    (shards ?? []).map(s => ({ hostId: s.hostId, port: s.port, scheme: s.scheme }));
  return JSON.stringify(strip(before)) !== JSON.stringify(strip(after));
}

/** Other modules hold `live` or its arrays by reference from startup, so
 *  every array is refilled with `splice`, never replaced. Takes the same
 *  file lock as `updateService`, so a reload can't land mid-write. A
 *  malformed file leaves `live` untouched. */
export async function reloadRegistry(
  path: string,
  live: Registry,
  isRunning: (serviceId: string) => boolean
): Promise<RegistryReloadResult> {
  return withFileLock(path, async () => {
    let fresh: Registry;
    try {
      fresh = validateRegistry(await readSyncedRegistry(path, "held"));
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    const warnings: ReloadWarning[] = [];

    // A service removed while still running keeps running; the warning is
    // the only trace it's still alive.
    const freshIds = new Set(fresh.services.map(s => s.id));
    for (const svc of live.services) {
      if (!freshIds.has(svc.id) && isRunning(svc.id)) {
        warnings.push({
          kind: "service-removed",
          serviceId: svc.id,
          message: `service "${svc.id}" was removed from the registry while running — it keeps running until stopped by hand`,
        });
      }
    }

    // A model server reads its roster section once, at startup, so the
    // reload can only name a changed provider, not make it take effect.
    const liveRoster = live.roster ?? emptyRoster();
    const freshRoster = fresh.roster ?? emptyRoster();
    const providerIds = new Set([...Object.keys(liveRoster.providers), ...Object.keys(freshRoster.providers)]);
    for (const serviceId of providerIds) {
      const before = liveRoster.providers[serviceId];
      const after = freshRoster.providers[serviceId];
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        warnings.push({
          kind: "provider-changed",
          serviceId,
          message: `provider "${serviceId}"'s roster section changed — restart it to pick up the edit`,
        });
      }
    }

    // A server handed the registry reads the models and voices at startup too.
    // The shard and the control plane resolve from `live`, so a change reaches
    // them with this reload; a handed-the-registry server needs a restart.
    const modelsById = (roster: NodeRoster) => new Map([...(roster.ttsModels ?? []), ...(roster.sttModels ?? [])].map(m => [m.id, JSON.stringify(m)]));
    const liveModels = modelsById(liveRoster);
    const freshModels = modelsById(freshRoster);
    const changedModels = new Set([...liveModels.keys(), ...freshModels.keys()].filter(id => liveModels.get(id) !== freshModels.get(id)));
    const voicesChanged = JSON.stringify(liveRoster.voices) !== JSON.stringify(freshRoster.voices);
    const liveProvides = new Map(live.services.map(s => [s.id, JSON.stringify(s.provides)]));
    for (const svc of fresh.services) {
      const runner = svc.runner as { main?: string } | undefined;
      if (!runner?.main?.includes("{registry}")) continue;
      const servesChanged = [liveRoster, freshRoster].some(r => r.providers[svc.id]?.serves.some(s => changedModels.has(s.model)));
      const voicesReachIt = voicesChanged && svc.capabilityId === "tts" && freshRoster.providers[svc.id] !== undefined;
      const providesChanged = liveProvides.has(svc.id) && liveProvides.get(svc.id) !== JSON.stringify(svc.provides);
      if (!servesChanged && !voicesReachIt && !providesChanged) continue;
      if (warnings.some(w => w.kind === "provider-changed" && w.serviceId === svc.id)) continue;
      const what = servesChanged ? "the roster's models" : voicesReachIt ? "the roster's voices" : "the provisions";
      warnings.push({
        kind: "provider-changed",
        serviceId: svc.id,
        message: `${what} changed — restart "${svc.id}" to pick up the edit`,
      });
    }

    // The shard poller builds its cache at startup; a changed list is only
    // reported, never applied — live.shards is not touched below.
    if (shardsChanged(live.shards, fresh.shards)) {
      warnings.push({
        kind: "shards-changed",
        message: "the shards list changed — restart to pick up the edit; the running list is unchanged",
      });
    }

    // The loops read their intervals at startup, so a change is reported and
    // live.intervals is left as it was.
    if (JSON.stringify(live.intervals ?? {}) !== JSON.stringify(fresh.intervals ?? {})) {
      warnings.push({
        kind: "intervals-changed",
        message: "intervals changed — restart to pick up the edit; the running loops are unchanged",
      });
    }

    // Carry state across by id, or idle eviction and health checks stop
    // seeing a demand-loaded service already running.
    const liveStateById = new Map(live.services.map(s => [s.id, s.state]));
    for (const svc of fresh.services) {
      const state = liveStateById.get(svc.id);
      if (state) svc.state = state;
    }

    live.services.splice(0, live.services.length, ...fresh.services);
    live.hosts.splice(0, live.hosts.length, ...fresh.hosts);
    live.capabilities.splice(0, live.capabilities.length, ...fresh.capabilities);

    if (!live.roster) live.roster = emptyRoster();
    for (const key of Object.keys(live.roster.providers)) delete live.roster.providers[key];
    Object.assign(live.roster.providers, freshRoster.providers as Record<string, Provider>);
    live.roster.voices.splice(0, live.roster.voices.length, ...freshRoster.voices);
    live.roster.ttsModels = freshRoster.ttsModels;
    live.roster.sttModels = freshRoster.sttModels;

    live.version = fresh.version;
    live.type = fresh.type;
    if (fresh.servicesRoot !== undefined) live.servicesRoot = fresh.servicesRoot;
    else delete live.servicesRoot;
    if (fresh.defaults !== undefined) live.defaults = fresh.defaults;
    else delete live.defaults;
    // live.shards is deliberately left as it was — a changed list only
    // warns, per shardsChanged above.

    return { ok: true, warnings };
  });
}
