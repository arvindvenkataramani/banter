# Config reload

Banter's Reload config item reloads everything on every node that can change without a restart, and reports what could not. A reload is how a hand edit to `config.json` or to a node's `registry.json` takes effect, including an edit to its roster section ([model-roster.md](model-roster.md)).

---

## Roles

### The control plane's reload

**Role** — the one entry point. The dashboard calls it; it reloads the control plane's own files, then every shard's.

**Ownership** — the control plane's live `config.json` object, its live registry.

**Key logic** — it reloads `config.json` as it does today, reloads its registry, and then asks each shard to reload. After each shard answers, it polls that shard at once, so the merged services and the assembled roster reflect the edit without waiting for the next poll. Each part succeeds or fails on its own, and the response reports each one: the config, the registry, and every shard by host id. A shard that cannot be reached is a failure for that shard only.

**Relationships** — called by the dashboard; calls each shard's reload; triggers the shard poller.

### The shard's reload

**Role** — reloads the shard's registry, roster section included.

**Ownership** — the shard's live registry and the roster built from it. The roster route reads that one live object, so a reload reaches it.

**Key logic** — the same registry reload the control plane runs, reporting its result and warnings in the same shape. The shard has no `config.json`, so its reload route exists whether or not a config file does.

**Relationships** — called only by the control plane's reload.

### The dashboard

**Role** — triggers a reload and shows what happened.

**Key logic** — reads the response before refreshing the page. A failed part or a warning is shown to the person who pressed the button; a clean reload refreshes as it does now.

---

## How a registry reload works

**Validate everything, then mutate.** The fresh file is read and fully validated, roster section included, before live state is touched. A malformed file reports its validation error and leaves the running registry exactly as it was.

**Mutate in place.** The services list, the shard list and the roster are held by reference: the health loop, the shard poller and the idle evictor each keep the array they were handed at startup. Reassigning a field would leave them iterating the old one. The reload empties and refills each array, and replaces each scalar field on the same object.

**Carry runtime state across by service id.** A service's `state` exists only in memory and is stripped on every write. A reload that replaced a service with its on-disk form would lose `loadTime`, and on the shard that silently stops idle eviction and health checks for demand-loaded services, which both skip a service with no load time. The fresh entry takes the old entry's `state` wherever the id matches.

**Hold the registry's file lock.** Service edits from the dashboard hold the registry's file lock across their whole read, modify and write. The reload takes the same lock, so a reload can never read the file between an edit's change in memory and its write to disk.

---

## Warnings

A reload applies what it can and names what it cannot. It never restarts anything.

**A changed provider section.** A model server reads its roster section once, at startup. The reload compares each provider's section before and after, and names every service whose section changed as needing a restart. Restarting them automatically would mean walking the dependency tree for an edit that almost never happens; the warning is enough.

**A removed service that is still running.** Once gone from the registry it has no health checks, no idle eviction and no stop through the API. The reload names it, and the process keeps running until someone stops it.

**A changed shard list.** The shard poller builds its cache from the shard list at startup, and a shard added later would be polled against a cache entry that does not exist. A change to the shard list is reported as needing a restart and otherwise ignored.

**Changed intervals.** The health and shard-poll loops read the registry's `intervals` at startup. A change is reported as needing a restart and otherwise ignored, like the shard list.

**What is restart-only regardless.** The bind host and port, the debug gate on the voice-debug routes, and whether whole route groups exist at all: those are decided once at startup. Reload does not detect changes to them.

---

## Known gap

`config.json` writers change the live object before they take the file lock for the write, so a reload landing between the two can read the old file over a fresh edit. It needs a dashboard save and a reload within the same few milliseconds, and nothing here closes it.
