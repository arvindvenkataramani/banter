# Install

How to get the control plane and dashboard running and kept running: the install script, the same steps by hand, installing as a service on each OS, where everything lands, and uninstalling. Speech servers are a separate step; see [speech-servers.md](speech-servers.md).

An LLM or agent can follow this page for you: point it here and ask it to run the steps.

The control plane needs no speech server to start. Until one is registered, voice does nothing and typing still works.

## Prerequisites

- **[Bun](https://bun.sh)**, the runtime for everything here. Developed against 1.3.x.
- **`jq`**, which `control-runner.sh` uses to read the port out of the registry and which the install script uses to seed the registry.
- **`lsof`**, which a few scripts use to find or free a port. It is not installed by default on minimal distros (Debian netinst, Alpine, most containers); everything else here is usually already present.
- **An [OpenClaw](https://github.com/openclaw/openclaw) gateway** to talk to.
- **systemd**, for the Linux path below. macOS and Linux without systemd use the fallback described under [Install as a service](#install-as-a-service).

Banter defaults to plain `http`, which suits one machine or a trusted home network. On your own network a LAN address is enough for text. Voice on a phone needs a secure page (`https`, or `localhost`), so serve the dashboard over `https` for that; [Tailscale](https://tailscale.com) is one way to get it, covered in [remote-access.md](remote-access.md).

Speech servers bring their own prerequisites. Banter needs none of them to run itself.

## Clone it

```bash
git clone https://github.com/arvindvenkataramani/banter.git
cd banter
```

## Install script

`scripts/install.sh` takes a fresh clone to a running, reachable control plane in one step: dependencies, model assets, config, and installing it as a service on Linux or macOS.

```bash
scripts/install.sh
```

Run it from the repo root. It:

1. checks that `bun` and `jq` exist, and that the OS is Linux with `systemctl` or macOS;
2. runs `bun install`, and in a git checkout enables the tracked git hooks (`core.hooksPath = scripts/git-hooks`);
3. re-verifies the browser's VAD and turn-detection model assets against their pinned hashes (`cd dashboard && bun run setup`); a failure is reported and the install continues;
4. creates `registry.json` and `config.json` at the top of the deployment folder from the shipped examples, unless either file already exists, in which case both are left as they are;
5. in the registry it seeds, expands a leading `~/` in each service's `ops.env.workingDirectory` to your home directory, and fills every `*_CORS_ORIGINS` variable it finds with `http://localhost` and `http://127.0.0.1` on the control plane's port and on Vite's `5173` (see [speech-servers.md](speech-servers.md#cors));
6. when it has just created `config.json`, prompts for your OpenClaw gateway URL and token and writes them to it, or reads them from `OPENCLAW_GATEWAY_URL` and `OPENCLAW_GATEWAY_TOKEN` for a non-interactive run;
7. deploys: on Linux it enables linger and runs `scripts/control-deploy.sh`; on macOS it runs `control-deploy.sh`, whose systemd step is expected to fail, then starts `control-runner.sh` in the background with its output in `$BANTER_PROD/install-run.log` (that process does not survive a reboot or logout; see [macOS, or Linux without systemd](#macos-or-linux-without-systemd));
8. waits for `/api/health` on the control plane's port, then prints the dashboard address and the gateway origin to allow.

The script installs no speech servers and no Python packages. Each speech server's own README says how to install it; see [speech-servers.md](speech-servers.md).

Your OpenClaw gateway refuses browser origins it does not list. Add `http://localhost:PORT` to `gateway.controlUi.allowedOrigins` in the gateway's config, plus every other origin you open the dashboard from (an `https://…ts.net` name, a LAN address), then restart the gateway. See [configuration.md](configuration.md#cors).

The rest of this page is the same steps by hand, for anything the script does not cover for your setup or when something goes wrong and you want to see where.

## Manual setup

### Set up the control plane

Run these on the control-plane machine.

```bash
bun install
```

The browser's VAD and turn-detection model assets are committed to the repo, so there is nothing to download here. `cd dashboard && bun run setup` re-verifies them against their pinned hashes.

### Configure it

`scripts/install.sh` creates the two live config files at the top of the deployment folder (`~/services/banter` by default). To create them by hand:

```bash
mkdir -p ~/services/banter
cp control/control-plane/data/registry.example.json ~/services/banter/registry.json
cp control/control-plane/data/config.example.json    ~/services/banter/config.json
```

Edit `~/services/banter/config.json` to point at your OpenClaw gateway (`integrations.openclaw.gateway.url` and `token`). The example `registry.json` is enough to get the control plane itself running; speech services are added after the control plane is up. [configuration.md](configuration.md) covers the minimum needed and how to add more.

The token may be written as `"${OPENCLAW_GATEWAY_TOKEN}"` rather than pasted in, in which case it is read from the environment at the point of use. The deployed service loads no environment file, so a placeholder there resolves to nothing and the gateway goes unauthenticated. Paste the value for a deployed run. Only `control-dev` reads an environment file, `$BANTER_PROD/.env.secrets`, which lives outside the repo.

Hand-copying skips the two things the install script does to a fresh registry: expanding `~/` in working directories (nothing downstream expands it) and filling the `*_CORS_ORIGINS` variables. Do both by hand, or run the script's `jq` step from `scripts/install.sh`.

## Install as a service

This is the only step that differs by OS.

### Linux with systemd

```bash
loginctl enable-linger $USER   # once per machine: keeps the service running
                               # when you are not logged in
scripts/control-deploy.sh
```

`control-deploy.sh` builds the dashboard, installs a systemd **user** unit, and starts it. Afterwards `scripts/control-start.sh` and `control-stop.sh` control it, and re-running `control-deploy.sh` picks up code changes.

### macOS, or Linux without systemd

This path is untested. The deployed tree is a plain directory that starts from one script, so the steps below follow from the scripts, but the supervisor is yours to set up.

`control-deploy.sh` builds, copies, and installs dependencies portably, then calls `systemctl --user` to register and start the unit. Without systemd it fails there, at its own `daemon-reload`, `enable` and `restart` calls, after `control-install-services.sh` has finished. That script skips its own systemd calls when `systemctl` is absent, so the deployed tree and any installed service artifacts are in place. So let the deploy run, then supervise the result yourself:

```bash
scripts/control-deploy.sh || true   # expected to fail at the systemd step
~/services/banter/scripts/control-runner.sh   # foreground, to check it serves
```

`scripts/install.sh` does the same on macOS and then starts `control-runner.sh` in the background with `nohup`.

`control-runner.sh` reads the port from the registry, registers with Tailscale Serve if Tailscale is present (skipped silently otherwise), and execs bun. Ctrl+C stops it. To keep it running across logouts and reboots, point a supervisor at that script: a launchd agent on macOS, or whatever you use elsewhere. It reads the `deploy.conf` that a deploy copies beside it, so a custom `BANTER_PROD` needs nothing set in its environment.

`ops/systemd/banter.service.template` is the systemd unit before rendering; `__PROD__` and `__UNIT__` are substituted at install time. It is a reference for what a launchd plist needs to do.

### Windows

Every script here is bash calling `systemctl`, `loginctl` and `lsof`, so native Windows needs all of that replaced. WSL2 with systemd enabled (`systemd=true` in `/etc/wsl.conf`) is Linux with systemd, so the Linux path applies there.

The dashboard is served over HTTP to a browser, so the client can be any OS no matter where the control plane runs.

## Where it installs

The deploy tree defaults to `~/services/banter` and is a **copy**: the repo is the source, and that tree is what runs. `config.json`, `registry.json`, `shipped/` and `state/` sit at the top of the folder, and a deploy never replaces them: it merges the repo's `*.example.json` into the live files field by field, keeping what you or the dashboard changed and stopping, with the fields named, if both sides changed the same one. See [configuration.md](configuration.md#deployment).

To install somewhere else, set it once in a config file:

```bash
cp scripts/deploy.conf.example scripts/deploy.conf
```

Uncomment `BANTER_PROD` and `BANTER_UNIT` there and every script picks them up: deploy, start, stop, uninstall. `deploy.conf` is untracked, so the setting is yours. It stays in the checkout's `scripts/` because it names the folder, and each deploy copies it into the deployed `scripts/`. Set both together: a second install on one machine needs its own directory *and* its own unit name, or `systemctl --user restart banter` acts on whichever one holds the name. A custom directory with the default unit name `banter` is refused rather than half-applied; a custom unit name with the default directory is allowed.

### Which files to edit

Registry and config edits go in the two files in the *deployed* folder, not in the repo you cloned:

```
~/services/banter/registry.json
~/services/banter/config.json
```

That folder is what runs; the repo is only its source. Editing the repo's `*.example.json` files changes nothing until you deploy, and a deploy merges them into the deployed files rather than overwriting them. If you set `BANTER_PROD` in `scripts/deploy.conf`, use that path instead. A server that runs on a shard machine has its entry in that shard's own `registry.json`, at the top of the shard's deployment folder; see [shard.md](shard.md).

[scripts/README.md](../../scripts/README.md) indexes the rest of the scripts, including `service-control.sh` for driving services by hand when the control API is not available.

## Uninstalling

```bash
scripts/control-uninstall.sh
```

This reverses what `control-deploy.sh` installed: it tears down the Tailscale Serve binding, stops and removes the systemd unit (without systemd, it stops the running `control-runner.sh` process directly, since there is no unit to remove), and deletes the deployment folder `$BANTER_PROD`, including `config.json`, `registry.json` and `state/`. Copy them out first to keep them. `scripts/shard-uninstall.sh` does the same for a shard's folder. Run `control-deploy.sh` again afterward to reinstall.

## Next

- [speech-servers.md](speech-servers.md): connect speech servers.
- [configuration.md](configuration.md): the minimum config and every field.
- [ios.md](ios.md): voice on iPhone and iPad.
- [plugin.md](plugin.md): the OpenClaw voice-mode plugin.
