# Operations

Deployment and development workflows for the control plane (systemd, Linux) and the control shard (launchd, macOS). One machine runs one node, never both.

## Operational philosophy

**The control plane is the hub.** Every other service, the shard and the dashboard exist to support the control plane and the agents that consume it. Running peripheral services without the control plane running is not a meaningful state.

**Consequence for operations:** starting and stopping is typically an all-or-nothing action per host. You start the control plane and its dependent services together; you stop them together. Individual service start and stop through the API exists for runtime management (demand-loading, recovery), not for infrastructure bring-up or tear-down.

**Tailscale Serve, where used, is part of the service lifecycle.** A service whose registry entry sets `tailscaleServe` is only reachable over https through the Serve binding. Starting such a service without setting up its binding is incomplete, and stopping it must tear the binding down. The start and stop scripts do this; do not bypass them. Tailscale is optional: without it, endpoints are plain `http` and nothing here that mentions Serve applies. See [setup/remote-access.md](remote-access.md).

## Prerequisites

| Dependency | Purpose |
|------------|---------|
| `bun` | Runtime, package manager, build tool |
| `jq` | JSON parsing in deploy and install scripts |
| `lsof` | Optional. Finding or freeing a port: `control-dev.sh` skips its port cleanup without it, and only `control-uninstall.sh`'s fallback path needs it |

Install `jq` with `apt install jq` or `brew install jq`.

## Per-machine deploy settings

`ops/deploy-env.sh` resolves where each node deploys to, and every deploy, install, run and dev script sources it. An optional `ops/deploy.conf` overrides its defaults for one machine; copy `ops/deploy.conf.example` and uncomment what you need. The file is bash assignments, sourced; a missing file is not an error. It stays in the checkout's `ops/` because it names the deployment folder, and a deploy copies it into the deployed `ops/`, so a deploy, systemd and launchd all read the same values.

Precedence is the environment, then `deploy.conf`, then the default. The variables it may set are `BANTER_PROD`, `BANTER_UNIT`, `BANTER_LIVE_DIR`, `BANTER_REGISTRY_PATH`, `BANTER_CONFIG_PATH`, `BANTER_EVENTS_PATH`, `BANTER_STAGE_DIR`, `BANTER_SHARD_PROD`, `BANTER_SHARD_LIVE_DIR`, `BANTER_SHARD_REGISTRY_PATH` and `BANTER_SHARD_EVENTS_PATH`. Derived defaults follow the resolved values: setting only `BANTER_LIVE_DIR` moves the registry and config paths with it.

`deploy-env.sh` refuses to load, naming both values, when `BANTER_PROD` is not the default and `BANTER_UNIT` is: a deploy would write the new tree while `systemctl --user restart banter` kept acting on the old one. Every script that sources it stops.

The systemd unit is rendered at install time with the deployment path and unit name substituted in. The shard's launchd label, `com.banter.control-shard`, is fixed in `deploy-env.sh`, and its plist carries the registry path, so a non-default `BANTER_SHARD_PROD` is set in `deploy.conf` before the shard is deployed.

`service-control.sh` decides which node a machine is from the registries, not the OS: the control node when the file at `BANTER_REGISTRY_PATH` has `"type": "control"`, the shard when the file at `BANTER_SHARD_REGISTRY_PATH` has `"type": "shard"`. The install scripts reach their own node's API at `http://localhost:<port>`, with the port read from the live registry.

## Control plane (systemd)

### Deploy

```bash
bun run control-deploy
# or: bash ops/control-deploy.sh
```

Sequence:
1. Builds the dashboard (`bun run build`)
2. Merges the repo's example config and registry into the live directory (below); a conflict stops the deploy here, before anything is stopped
3. Stops the systemd service
4. Copies repo files to `$BANTER_PROD` (default `~/services/banter`)
5. Runs `bun install` to resolve workspace dependencies
6. Installs the systemd unit from `ops/systemd/` and reloads the daemon
7. Enables and starts the unit

Run this after merging. It is safe to run against a live system. `control-deploy.sh main` deploys from `main` without a prompt, and `control-deploy.sh dev` from the working tree.

**Live directory.** The control plane's live configuration is `$BANTER_LIVE_DIR` (default `$BANTER_PROD`, the deployment folder itself). A deploy replaces only the code folders, never these files. It holds `config.json`, `registry.json`, `shipped/` (what the last deploy shipped, the merge base) and `state/state.json` (last agent and last session per agent). `BANTER_REGISTRY_PATH` and `BANTER_CONFIG_PATH` default to the files inside it. Dev runs against the same folder.

**Deploy merge.** The deploy merges `shipped/<file>` (base), the live file and the repo's example field by field, and services by id. A field changed only in the repo takes the repo's value, one changed only on the node keeps the node's, and one changed on both to different values stops the deploy with the conflicting fields named. There is no prompt and no reset flag: resolve a conflict by editing the live file or the example and deploying again. A node with no `shipped/` copy takes the example as the base, so every live value is kept and only what the example adds arrives. The merged registry must pass the registry's validation. See [design/live-config.md](../reference/design/live-config.md).

**Preflight.** `control-deploy.sh` runs `deploy-preflight.sh` first. It refuses when the destination is non-empty and was not created by a previous banter deploy, or when the unit name belongs to something running elsewhere. Override deliberately with `BANTER_DEPLOY_FORCE=1`.

### Dev

```bash
bun run control-dev
# or: bash scripts/control-dev.sh
```

Runs the control plane on port **4201** and Vite on **5173**; `BANTER_DEV_CONTROL_PORT` and `VITE_PORT` override them. Vite proxies `/api` to the control plane. These are separate from the production port (4200, from the registry's `control` entry) so both can run on the same machine at once. Dev reads the deployed folder's live `config.json` and `registry.json`, and `$BANTER_PROD/.env.secrets` if present.

On startup, kills any process holding the dev ports. Stop with Ctrl+C.

### Start and stop

```bash
bash ops/control-start.sh      # systemctl start
bash ops/control-stop.sh       # stop and tear down any Tailscale Serve binding
bash ops/control-uninstall.sh  # disable, remove the unit, delete the deployment folder
```

`control-uninstall.sh` deletes `$BANTER_PROD`, including the live `config.json`, `registry.json` and `state/`. Copy them out first to keep them.

### What runs

One systemd unit, `banter.service` (named by `BANTER_UNIT`), runs `control-runner.sh`, which:

1. Reads the control port from the live registry
2. Tears down any stale Tailscale Serve binding on that port, if Tailscale is present
3. Sets up Tailscale Serve for the port, if Tailscale is present
4. Execs the control plane (`bun run src/index.ts`), which serves both the API and the dashboard's static files

`ExecStopPost` runs `control-serve-off.sh`, which removes the binding.

---

## Control shard (launchd)

### Deploy

```bash
bun run shard-deploy
# or: bash ops/shard-deploy.sh
```

Sequence:
1. Compiles and ad-hoc signs `shard-runner` (Swift supervisor binary)
2. Merges the example shard registry into the shard's live directory (see below); a conflict stops the deploy before anything is stopped
3. Stops the launchd agent if running
4. Copies repo files to `$BANTER_SHARD_PROD` (default `~/services/banter`)
5. Runs `shard-install-services.sh`: the artifacts each service declares in `ops.install`, the launchd plists the registry references, and `logs/` directories
6. Runs `bun install`
7. Installs the launchd plist to `~/Library/LaunchAgents/`
8. Bootstraps the agent (which starts `shard-runner`)
9. Calls `shard-start.sh` to ensure the agent is running

The shard is API-only: no dashboard is built or deployed. A deploy from `main` deploys the shard only, and its git archive holds no builds, so step 5 skips built artifacts.

**Live directory.** The shard's live files are in `$BANTER_SHARD_LIVE_DIR` (default `$BANTER_SHARD_PROD`): `registry.json` and `shipped/registry.json` (the merge base). `BANTER_SHARD_REGISTRY_PATH` defaults to the registry inside it. The deploy merges the example registry into it exactly as on the control plane, and a process runner's `{registry}` is filled with that path. The shard's live directory is read only by the shard's machine and written only by a deploy run on it.

### Installing a compiled service

Building and installing are separate. Each package has its own build script; `shard-install-services.sh` installs whatever the registry declares under a service's `ops.install.artifacts`, each a `from` path in the source tree and a `to` path in the service's working directory. For the fluid servers:

```bash
scripts/fluid-build.sh && ops/shard-install-services.sh
```

A service whose artifacts match what is installed is left alone, and one whose artifact has not been built is reported and skipped. A changed service is stopped through the control API if it is running, its files swapped in by rename, and restarted. Each install writes `SOURCE-COMMIT.txt` in the working directory and appends a `service.installed` event to the shard's event log, carrying the commit and each artifact's sha256. Install runs only as a script on the machine, never through the control API. Design: [design/service-install.md](../reference/design/service-install.md).

`fluid-build.sh` first checks for Apple Silicon, macOS 15 or later, a Swift 6 toolchain, Homebrew and libopus, and stops naming the install command for whatever is missing.

`scripts/fluid-smoke.sh` checks `fluid-stt` as built, installed and running without touching a live server. It installs into a scratch directory under `/var/tmp` with a control URL that points at nothing, re-stamps the bundle with a throwaway identifier so the server's startup cleanup cannot reach a live server's temp files, runs it on `FLUID_SMOKE_PORT` (default 18767), and checks `/healthz`, a transcription of a sentence spoken with `say`, and an unload. Everything it created is removed on exit; `--keep` leaves it. It never downloads a model. Exit 0 is a pass, 1 a failure, 3 a skip for a missing model or `say`.

### Dev

```bash
bun run shard-dev
# or: bash scripts/shard-dev.sh
```

Dev runs the shard on `BANTER_SHARD_PORT` (default 4200), the same as production; the registry's `control-shard` port must match it. `shard-dev.sh` reads that registry port only to manage Tailscale Serve. The script stops production before starting dev, and restores it on exit.

Startup:
1. Calls `shard-stop.sh`, which stops the launchd agent unconditionally
2. Starts the shard via `bun run --watch`
3. Sets up Tailscale Serve for the port, if Tailscale is present

Shutdown (Ctrl+C or SIGTERM):
1. Tears down Tailscale Serve
2. Kills the bun processes
3. If the plist is installed, calls `shard-start.sh` to restore production

If the terminal is killed uncleanly, the trap does not run and Tailscale Serve may be left pointing at a dead process. This self-heals on the next startup: both `shard-dev.sh` and the Swift runner clear any stale binding before setting up their own.

### Start and stop

```bash
bash ops/shard-start.sh      # bootstrap the agent if not loaded
bash ops/shard-stop.sh       # launchctl disable and bootout, then Serve off on the shard's port
bash ops/shard-uninstall.sh  # remove the agent and delete the deployment folder
```

`shard-uninstall.sh` deletes `$BANTER_SHARD_PROD`, including the live `registry.json` and `state/`. Copy them out first to keep them.

### What runs

One launchd agent, `com.banter.control-shard`, runs the compiled `shard-runner` Swift binary, which:

1. Tears down any stale Tailscale Serve binding on the shard's port
2. Spawns the shard (`bun run src/index.ts`), API only
3. Sets up Tailscale Serve for the port
4. Restarts the shard on crash
5. On SIGTERM: kills children, tears down Tailscale Serve, exits

### Building shard-runner

Source: `control/control-shard/ops/shard-runner.swift`, a single-file Swift program with no SPM package. It reads the shard's port from the registry only to manage Tailscale Serve (the shard itself listens on `BANTER_SHARD_PORT`, default 4200, which the registry's `control-shard` port must match), spawns `bun run src/index.ts` as a child process, and owns Tailscale Serve for that port (see below). It is not meant to be run directly; launchd invokes it as the plist's sole `ProgramArguments` target.

`shard-deploy.sh` compiles and ad-hoc signs it on every deploy; the binary is never committed, only the source. See the script for the exact `swiftc` and `codesign` invocation.

---

## Tailscale Serve ownership

Where Tailscale Serve is used, exactly one owner manages each binding.

**Production shard:** the Swift runner (`shard-runner`) owns Serve for the shard's port. It clears any stale binding on startup and tears it down on SIGTERM. `shard-start.sh` only talks to launchctl. `shard-stop.sh` runs launchctl disable and bootout, then turns Serve off on the shard's registry port (4200 if the registry has none).

**Production control plane:** `control-runner.sh` sets up the binding and `control-serve-off.sh` removes it.

**Dev:** `control-dev.sh` and `shard-dev.sh` own the binding directly, since the production runners are not involved. They set it up on startup and tear it down in the trap.

**Services:** service lifecycle registers a service's own port with Serve on start, and removes it on stop, only when the service sets `network.tailscaleServe`. `serve-watchdog.sh` re-registers entries that have dropped.

---

## Port layout

| Port | Purpose |
|------|---------|
| 4200 | Control plane (serves API and dashboard) or control shard (API only); the control plane's port comes from the registry's `control` entry, and `BANTER_CONTROL_PORT` overrides it; the shard's port is `BANTER_SHARD_PORT` (default 4200), and the registry's `control-shard` port must match it |
| 4201 | Control plane dev |
| 5173 | Vite dev server (HMR) |

A service's port is whatever its registry entry's `network.port` says.

---

## Troubleshooting

### Checking service logs

User-unit logs are in the system journal. Query with:

```bash
# Recent logs
journalctl _SYSTEMD_USER_UNIT=banter.service --no-pager -n 50

# Logs since last boot
journalctl _SYSTEMD_USER_UNIT=banter.service -b

# Follow live
journalctl _SYSTEMD_USER_UNIT=banter.service -f
```

`journalctl --user -u banter.service` may return empty; use the `_SYSTEMD_USER_UNIT=` filter instead. The user service keeps running after logout only when lingering is on (`loginctl enable-linger $USER`).

### The dashboard is unreachable from another machine

The control plane binds to `localhost` by default, so another machine needs either a proxy such as Tailscale Serve in front or `BANTER_CONTROL_HOST` set to listen on another interface. If the dashboard loads locally but not from elsewhere:

```bash
# With Tailscale: is Serve pointing at the right port?
tailscale serve status

# If missing or wrong, restart the service (the runner re-establishes Serve)
bash ops/control-start.sh
```

Voice on a phone also needs a secure page (https, or localhost); a plain `http://<lan-ip>` page can chat by text but cannot use the microphone. See [setup/remote-access.md](remote-access.md#why-https).

### Voice fails on a healthy service

Almost always CORS: the browser calls speech servers directly, so each needs the dashboard's origin in its allowlist, and the gateway needs it in `gateway.controlUi.allowedOrigins`. See [setup/configuration.md](../reference/configuration.md#cors).

### Service won't stop, or a deploy is stuck at "Stopping"

If `systemctl --user stop banter` hangs, the wrapper may not be forwarding SIGTERM to bun:

```bash
# Force kill
systemctl --user kill -s SIGKILL banter

# Then restart
bash ops/control-start.sh
```

---

## Registry as source of truth

All service configuration, meaning ports, endpoints, start and stop commands and health paths, lives in `registry.json`. Changing a service's port means changing it in the registry; scripts read from it rather than hardcoding values. The shard's own listening port is the exception: it is `BANTER_SHARD_PORT` (default 4200), and the registry's `control-shard` port must be changed to match.

| File | Node | Purpose |
|------|------|---------|
| `$BANTER_PROD/registry.json` | Control plane | Its services and hosts, and the shard list |
| `$BANTER_SHARD_PROD/registry.json` | Shard | The services the shard manages |

Both default to `~/services/banter/registry.json`. The repo's `control/*/data/registry.example.json` files are what a deploy merges into them. See [components/registry.md](../reference/components/registry.md).

## Adding a new service

1. Add an entry to the node's `registry.json` with `id`, `capabilityId`, `hostId`, `runner`, `network` (`port` and `healthPath`) and `lifecycle`. See [setup/configuration.md](../reference/configuration.md#adding-a-service).
2. Install the service on the node that runs it.
3. For a `process` runner, write `main` so it starts the process directly (it must exec, not background), with the port as `{port}`.
4. If the service needs Tailscale Serve, set `network.tailscaleServe`; otherwise the service is reached over its plain endpoint.
5. If it is built from this repo, declare its built files under `ops.install.artifacts` and give it a build script; see [Installing a compiled service](#installing-a-compiled-service).
6. Reload the registry (`POST /api/config/reload`) and, for a roster change, restart the provider. See [setup/voices-and-models.md](voices-and-models.md#applying-an-edit).

## Event log

Health state is derived from the event log, never stored directly. `service.installed` is the one event that does not bear on health: it records what an install placed on disk, and derivation skips it.

```bash
# Live events
tail -f ~/services/banter/logs/events.jsonl | jq .

# Most recent event per service
jq -s 'group_by(.subjectId) | map(sort_by(.timestamp) | last)' \
  ~/services/banter/logs/events.jsonl
```

See [components/event-log.md](../reference/components/event-log.md).
