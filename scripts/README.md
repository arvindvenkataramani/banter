# Scripts

Deployment, lifecycle, and diagnostics. Every script carries a header comment explaining what it does; this is the index of which one to reach for.

Nothing here is required to run banter — `bun run control-dev` needs none of it. These exist for installing Banter as a system service and for the moments when something has gone wrong.

## First-time setup

| Script | What it does |
|---|---|
| `install.sh` | Everything in the README's Install section up through a running control plane: dependencies, model assets, config (prompts for the OpenClaw gateway URL/token, or reads `OPENCLAW_GATEWAY_URL`/`OPENCLAW_GATEWAY_TOKEN`), and deploying as a service on Linux or macOS. Writes `registry.json` and `config.json` at the top of `$BANTER_PROD` from the example files, filling in the gateway URL and token. Registering speech services is a separate step; see the README. |

## Control plane

Run these on the always-on machine.

| Script | What it does |
|---|---|
| `control-deploy.sh` | Builds the dashboard, merges the repo's example config and registry into the live files at the top of `$BANTER_PROD` (stopping on a conflict, before anything is stopped), copies the code to `$BANTER_PROD`, installs the systemd unit, and starts it. Runs `deploy-preflight.sh` first. Takes `main` or `dev` to pick the source. |
| `control-start.sh` | Starts the installed systemd unit. Requires a prior deploy. |
| `control-stop.sh` | Stops the unit and tears down its Tailscale Serve binding. |
| `control-uninstall.sh` | Reverses the deploy: stops and disables the unit, removes it, and deletes the deployment folder `$BANTER_PROD`, including `config.json`, `registry.json` and `state/`. Without systemd, stops the `control-runner.sh` process by its registry port instead — there is no unit to remove there. |
| `control-dev.sh` | Development. Control plane on `$BANTER_DEV_CONTROL_PORT` (4201) and Vite with HMR on `$VITE_PORT` (5173), against the deployed folder's live `config.json` and `registry.json`, so new code is tried on real settings. Invoked by `bun run control-dev`. |

Two of these are called by the machinery rather than by you:

| Script | Called by |
|---|---|
| `control-runner.sh` | The systemd unit's `ExecStart`. Sets up Tailscale Serve, then execs bun. |
| `control-serve-off.sh` | The unit's `ExecStopPost`. Removes the Serve binding, reading the port from the registry. |
| `control-install-services.sh` | `control-deploy.sh`. Installs the control plane's own unit plus any systemd units named by registry entries, then the built artifacts each service declares in `ops.install`. Nothing else under `services/` is copied. |

## Worker machine (shard)

Run these on the worker. See [../docs/shard-setup.md](../docs/shard-setup.md).

| Script | What it does |
|---|---|
| `shard-deploy.sh` | Builds the dashboard, compiles and code-signs the `shard-runner` Swift supervisor, copies everything into place, and installs the launchd agent. |
| `shard-start.sh` | Bootstraps the launchd agent. Tailscale Serve is the supervisor's job, not this script's. |
| `shard-stop.sh` | Stops and disables the agent. |
| `shard-uninstall.sh` | Removes the agent and the deployment folder `$BANTER_SHARD_PROD`, including the live `registry.json` and `state/`. |
| `shard-dev.sh` | Development: the shard alone, API-only, with `--watch`. Stops the production agent while it runs and restores it on exit. |
| `shard-install-services.sh` | Called by `shard-deploy.sh`. Installs launchd plists named by the shard's live registry (the one the shard reads, `registry.json` at the top of `$BANTER_SHARD_PROD`; fails if there is none) and the built artifacts each service declares in `ops.install`. Nothing else under `services/` is copied. |

## Diagnostics and safety

| Script | What it does |
|---|---|
| `service-control.sh` | Start, stop, restart, enable, disable, or check any registered service by name, with fuzzy matching — a fragment such as `whisper` finds `stt-whisper`. Reads the deployed registry and derives the right command from each service's runner type. Works on either node. This is the backup path when the control API is unavailable; prefer the dashboard otherwise. Run it with no arguments for usage, or `service-control.sh list`. |
| `deploy-preflight.sh` | Refuses a deploy when the destination is non-empty and was not created by a previous banter deploy, or when the systemd unit name belongs to something running elsewhere. Called first by `control-deploy.sh`. Never reads stdin; override with `BANTER_DEPLOY_FORCE=1`. |
| `serve-watchdog.sh` | Re-registers Tailscale Serve entries that have dropped for services marked `tailscaleServe: true`. Intended for cron, once a minute. Only useful with Tailscale Serve. |
| `branch-status.sh` | Reports whether the checkout is on the project's main line. Exit 0 on the main line, 1 off it, 2 when it cannot tell. Used by the deploy scripts to decide whether to confirm before installing unreviewed work. |

## Deploy settings

Where a deploy installs and what its systemd unit is called come from `deploy-env.sh`, which every script here sources. To change them, copy `deploy.conf.example` to `deploy.conf` and edit it — that file is untracked and per-machine, so the setting is made once rather than exported on each call. It stays in the checkout's `scripts/`; a deploy copies it into the deployed `scripts/`.

| Setting | Default | Purpose |
|---|---|---|
| `BANTER_PROD` | `~/services/banter` | Where the control plane installs |
| `BANTER_UNIT` | `banter` | Its systemd unit name |
| `BANTER_SHARD_PROD` | `~/services/banter` | Where a shard installs (one node per machine, so the same default) |

Precedence is environment > `deploy.conf` > defaults, so a one-off staging deploy can still set a variable inline without editing the file.

A non-default `BANTER_PROD` under the default `BANTER_UNIT` is refused: every start and stop would address the *other* install, so set both.

A unit file cannot expand a shell variable, so `ops/systemd/banter.service.template` is rendered at install time with the deploy path substituted in.

See [../docs/configuration.md](../docs/configuration.md#deployment) for the rest.
