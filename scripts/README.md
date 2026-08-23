# Scripts

Deployment, lifecycle, and diagnostics. Every script carries a header comment explaining what it does; this is the index of which one to reach for.

Nothing here is required to run banter — `bun run control-dev` needs none of it. These exist for installing the platform as a system service and for the moments when something has gone wrong.

## First-time setup

| Script | What it does |
|---|---|
| `install.sh` | Everything in the README's Install section up through a running control plane: dependencies, model assets, config (prompts for the OpenClaw gateway URL/token, or reads `OPENCLAW_GATEWAY_URL`/`OPENCLAW_GATEWAY_TOKEN`), and deploying as a service on Linux or macOS. Leaves `registry.json` at its shipped defaults — speech services are the next step, by hand. |

## Control plane

Run these on the always-on machine.

| Script | What it does |
|---|---|
| `control-deploy.sh` | Builds the dashboard, copies the tree to `$BANTER_PROD`, installs the systemd unit, and starts it. Runs `deploy-preflight.sh` first. Takes `main` or `dev` to pick the source. |
| `control-start.sh` | Starts the installed systemd unit. Requires a prior deploy. |
| `control-stop.sh` | Stops the unit and tears down its Tailscale Serve binding. |
| `control-uninstall.sh` | Reverses the deploy: stops and disables the unit, removes it, and deletes `$BANTER_PROD`. Without systemd, stops the `control-runner.sh` process by its registry port instead — there is no unit to remove there. |
| `control-dev.sh` | Development. Control plane on `$BANTER_DEV_CONTROL_PORT` (4201) and Vite with HMR on `$VITE_PORT` (5173), against a separate `config.dev.json` so dashboard settings changes leave the tracked config alone. Invoked by `bun run control-dev`. |

Two of these are called by the machinery rather than by you:

| Script | Called by |
|---|---|
| `control-runner.sh` | The systemd unit's `ExecStart`. Sets up Tailscale Serve, then execs bun. |
| `control-serve-off.sh` | The unit's `ExecStopPost`. Removes the Serve binding, reading the port from the registry. |
| `control-install-services.sh` | `control-deploy.sh`. Installs the control plane's own unit plus any systemd units named by registry entries. |

## Worker machine (shard)

Run these on the worker. See [../docs/shard-setup.md](../docs/shard-setup.md).

| Script | What it does |
|---|---|
| `shard-deploy.sh` | Builds the dashboard, compiles and code-signs the `shard-runner` Swift supervisor, copies everything into place, and installs the launchd agent. |
| `shard-start.sh` | Bootstraps the launchd agent. Tailscale Serve is the supervisor's job, not this script's. |
| `shard-stop.sh` | Stops and disables the agent. |
| `shard-uninstall.sh` | Removes the agent and the deployed tree. |
| `shard-dev.sh` | Development, as `control-dev.sh` but for the shard. |
| `shard-install-services.sh` | Called by `shard-deploy.sh`. Installs launchd plists named by registry entries. |

## Diagnostics and safety

| Script | What it does |
|---|---|
| `service-control.sh` | Start, stop, restart, enable, disable, or check any registered service by name, with fuzzy matching — `parakeet` finds `stt-parakeet`. Reads the deployed registry and derives the right command from each service's runner type. Works on either node. This is the backup path when the control API is unavailable; prefer the dashboard otherwise. Run it with no arguments for usage, or `service-control.sh list`. |
| `deploy-preflight.sh` | Refuses a deploy when the destination is non-empty and was not created by a previous banter deploy, or when the systemd unit name belongs to something running elsewhere. Called first by `control-deploy.sh`. Never reads stdin; override with `BANTER_DEPLOY_FORCE=1`. |
| `serve-watchdog.sh` | Re-registers Tailscale Serve entries that have dropped for services marked `tailscaleServe: true`. Intended for cron, once a minute. Only useful if you run a tailnet. |
| `branch-status.sh` | Reports whether the checkout is on the project's main line. Exit 0 on the main line, 1 off it, 2 when it cannot tell. Used by the deploy scripts to decide whether to confirm before installing unreviewed work. |

## Deploy settings

Where a deploy installs and what its systemd unit is called come from `deploy-env.sh`, which every script here sources. To change them, copy `deploy.conf.example` to `deploy.conf` and edit it — that file is untracked and per-machine, so the setting is made once rather than exported on each call.

| Setting | Default | Purpose |
|---|---|---|
| `BANTER_PROD` | `~/services/banter` | Where the control plane installs |
| `BANTER_UNIT` | `banter` | Its systemd unit name |
| `BANTER_SHARD_PROD` | `~/services/banter` | Where a shard installs |
| `BANTER_SHARD_SERVICES_DEST` | `~/services` | Where a shard puts service scripts |

Precedence is environment > `deploy.conf` > defaults, so a one-off staging deploy can still set a variable inline without editing the file.

`BANTER_PROD` and `BANTER_UNIT` must be set together — a non-default directory under the default unit name means every start and stop addresses the *other* install. `deploy-env.sh` refuses that combination rather than half-applying it.

A unit file cannot expand a shell variable, so `ops/systemd/banter.service.template` is rendered at install time with the deploy path substituted in.

See [../docs/configuration.md](../docs/configuration.md#deployment) for the rest.
