import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { withFileLock, writeFileAtomicUnlocked } from "./atomic-write";
import { validateRoster, emptyRoster } from "./roster";
import type { Registry, Service, ReloadWarning, Provider } from "../../../shared/types";

// ── Patch allowlists ──────────────────────────────────────────────────────────

const PATCHABLE_TOP = new Set(["capabilityId", "hostId", "notes"]);
const PATCHABLE_NETWORK = new Set(["port", "healthPath", "listenAddress", "tailscaleServe", "scheme"]);
const PATCHABLE_LIFECYCLE = new Set(["loadStrategy", "autoStart", "idleUnload", "idleTimeout", "startupTime", "restartOnCrash", "maxRestarts", "restartBackoff", "serveRetryAttempts", "serveRetryDelay"]);
const PATCHABLE_PERMISSIONS = new Set(["enabled"]);
const PATCHABLE_GROUPS = new Set(["permissions", "network", "lifecycle"]);

// ── Clearable fields ───────────────────────────────────────────────────────────

// `null` in a patch means "remove this field", and only these fields accept it.
// Everything else is required by validateRegistry — `port`, `healthPath`,
// `hostId`, `capabilityId` — and removing one writes a registry that throws on
// the next load. updateService writes to disk without re-validating, so a patch
// that clears a required field is not caught until a restart.
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

function validateRegistry(data: unknown): Registry {
  const d = data as Record<string, unknown>;

  // Version check (must be first)
  if (d.version !== 2) throw new Error(`registry: unsupported version (expected 2, got ${d.version ?? "undefined"})`);

  // Type check
  if (d.type !== "control" && d.type !== "shard") throw new Error(`registry: invalid type (expected "control" or "shard", got "${d.type}")`);

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
        if ("scheme" in group && group.scheme !== "http" && group.scheme !== "https") throw new Error('defaults.network.scheme must be "http" or "https"');
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

    validateInstall(svc);

    // A process runner's command string carries its own --port, independent of
    // network.port: the former is what the service binds, the latter is what we
    // health-check and route to. Nothing keeps them in sync, so a one-sided edit
    // silently yields a service that starts fine and is then polled on the wrong
    // port. We can't inject the value (runner.main is spawned verbatim, split on
    // spaces), so warn rather than fail — an intentional mismatch is legal, e.g.
    // a service behind a local proxy.
    if (runnerType === "process" && net.port) {
      const portFlag = /(?:^|\s)--port[=\s]+(\d+)/.exec(runner.main as string);
      if (portFlag && portFlag[1] !== String(net.port)) {
        console.warn(
          `[registry] service "${svc.id}": runner.main starts it on port ${portFlag[1]} ` +
          `but network.port is ${net.port}. Health checks and the derived endpoint ` +
          `will use ${net.port}. Update both if this was meant to be one port.`
        );
      }
    }

    // Derive the endpoint. `scheme` alone decides the protocol, defaulting to
    // http. Anything can be https — a reverse proxy, a self-signed cert, any TLS
    // terminator — so nothing else infers it.
    //
    // Deliberately NOT derived from tailscaleServe: that flag means "register
    // with Tailscale Serve on start", a lifecycle concern. Letting it imply
    // https would make a tailnet the assumed deployment, which this platform
    // does not require for either shard connectivity or service access. A
    // tailnet user sets scheme once in the registry's `defaults.network` block.
    //
    // The scheme used to key off listenAddress, which conflated "which address"
    // with "which protocol": a service without one got an https endpoint that
    // nothing could ever answer.
    //
    // Managed runners never get a derived endpoint, even if network.port is set
    // for reference — they have no HTTP health surface, and a synthesized
    // endpoint would wrongly imply one exists.
    if (net.scheme !== undefined && net.scheme !== "http" && net.scheme !== "https") {
      throw new Error(`service ${svc.id}: network.scheme must be "http" or "https", got "${net.scheme}"`);
    }
    if (net.port && runnerType !== "managed") {
      const listenAddr = net.listenAddress as string | undefined;
      const hostname = listenAddr ?? hostMap.get(svc.hostId as string);
      const scheme = (net.scheme as string | undefined) ?? "http";
      net.endpoint = `${scheme}://${hostname}:${net.port}`;
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
      if (shard.scheme !== undefined && shard.scheme !== "http" && shard.scheme !== "https") {
        throw new Error(`shard ${shard.hostId}: scheme must be "http" or "https", got "${shard.scheme}"`);
      }
      const shardHostname = hostMap.get(shard.hostId as string)!;
      // http unless told otherwise. This used to key off the hostname — anything
      // that wasn't literally localhost got https — which made a shard on a LAN
      // or at an IP address unreachable unless you happened to run a tailnet.
      const shardScheme = (shard.scheme as string | undefined) ?? "http";
      shard.endpoint = `${shardScheme}://${shardHostname}:${shard.port}`;
    }
  }

  return data as Registry;
}

export async function loadRegistry(path: string): Promise<Registry> {
  const content = await readFile(path, "utf-8");
  const data = JSON.parse(content);
  return validateRegistry(data);
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

    const updated = { ...state.services[idx] };

    for (const key of Object.keys(patch) as (keyof NestedPatch)[]) {
      if (PATCHABLE_TOP.has(key)) {
        const value = (patch as Record<string, unknown>)[key];
        if (value === null) {
          if (!CLEARABLE_TOP.has(key)) throw new Error(`${key} cannot be cleared`);
          delete (updated as Record<string, unknown>)[key];
        } else {
          if (typeof value !== "string") throw new Error(`${key} must be a string`);
          (updated as Record<string, unknown>)[key] = value;
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
        if ("scheme" in networkPatch && networkPatch.scheme !== undefined && networkPatch.scheme !== "http" && networkPatch.scheme !== "https") {
          throw new Error(`network.scheme must be "http" or "https", got "${networkPatch.scheme}"`);
        }
        updated.network = applyGroupPatch(
          updated.network as unknown as Record<string, unknown>,
          networkPatch,
          CLEARABLE_NETWORK,
          "network"
        ) as unknown as typeof updated.network;
        // Re-derive the endpoint the same way validateRegistry does, for the same
        // reasons — see the comment on that derivation. A patch that disagreed
        // with the loader would write an endpoint the next load silently replaces.
        if ("port" in networkPatch || "listenAddress" in networkPatch || "scheme" in networkPatch) {
          const host = state.hosts.find(h => h.id === updated.hostId);
          const hostname = updated.network.listenAddress ?? host?.hostname;
          const scheme = updated.network.scheme ?? "http";
          if (updated.network.port && updated.runner?.type !== "managed" && hostname) {
            updated.network = { ...updated.network, endpoint: `${scheme}://${hostname}:${updated.network.port}` };
          }
        }
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

    state.services[idx] = updated;

    // Atomic write — strip derived fields (endpoint, state)
    const servicesForDisk = state.services.map(s => {
      const { endpoint, ...networkRest } = s.network;
      const { state: _state, ...rest } = s;
      return { ...rest, network: networkRest };
    });

    // Written back only when non-empty, so a file with no roster section
    // doesn't gain one — state.roster always carries a default.
    const hasRoster = state.roster && (Object.keys(state.roster.providers).length > 0 || state.roster.voices.length > 0);

    await writeFileAtomicUnlocked(registryPath, JSON.stringify({
      version: state.version,
      type: state.type,
      ...(state.servicesRoot && { servicesRoot: state.servicesRoot }),
      ...(state.defaults && { defaults: state.defaults }),
      hosts: state.hosts,
      capabilities: state.capabilities,
      services: servicesForDisk,
      ...(state.shards && { shards: state.shards }),
      ...(hasRoster && { roster: state.roster }),
    }, null, 2));

    return updated;
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
      const content = await readFile(path, "utf-8");
      fresh = validateRegistry(JSON.parse(content));
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

    // The shard poller builds its cache at startup; a changed list is only
    // reported, never applied — live.shards is not touched below.
    if (shardsChanged(live.shards, fresh.shards)) {
      warnings.push({
        kind: "shards-changed",
        message: "the shards list changed — restart to pick up the edit; the running list is unchanged",
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
