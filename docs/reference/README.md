# Developer guide

How to run Banter from source, test it, change a plugin, and find your way around the repository. Install Banter first ([install](../guide/install.md)): the dev scripts work on an installation rather than replacing one.

The commands below run from the repository root unless a `cd` says otherwise. Dependencies are installed with `bun install` at the root, which covers every workspace.

## Running from source

```bash
bun run control-dev
```

Runs the control plane on port 4201 and Vite with HMR on port 5173, in the foreground; Ctrl+C stops both. Vite proxies `/api` to the control plane. Override the ports with `BANTER_DEV_CONTROL_PORT` and `VITE_PORT`. The script is `scripts/control-dev.sh`.

It reads the deployed config and registry, so it needs a completed install first. It writes its own event log (`control/control-plane/data/events.dev.jsonl`), so dev health checks do not change what a deployment reports. If `.env.secrets` exists in the deployed folder it is loaded, so gateway features work. Otherwise they are unavailable.

Promote changes to the installation by re-running `ops/control-deploy.sh`. The install and deploy scripts are indexed in [ops/README.md](../../ops/README.md), and the dev tools in [scripts/README.md](../../scripts/README.md); neither is needed for day-to-day work beyond `bun run control-dev`.

To work on the shard, `scripts/shard-dev.sh` (`bun run shard-dev`) runs it alone, API only, with `--watch`. It needs a deployed shard registry, and it stops the production shard agent while it runs and restores it on exit. See [shard](../guide/shard.md).

To try a branch end to end, speech servers included, without deploying it, run a [test environment](test-environment.md): the branch's control plane and fluid servers from a scratch directory, reusing the models on disk.

To reach the dev server from another device, Vite's `allowedHosts` needs a hostname added; see [Hardening](../../README.md#hardening).

## Tests

Which tests cover which change, and which changes need a human review, is in [CONTRIBUTING.md](../../CONTRIBUTING.md). These are the commands.

**Dashboard and voice engine**, in `dashboard/`:

```bash
bun run test      # vitest
bun run lint      # eslint
bunx tsc -b       # typecheck
```

`bun run test` also runs the voice engine's tests (`voice-engine/src/`): the dashboard's `vitest.config.ts` includes them and supplies the DOM environment (jsdom) and setup file they need. Running vitest inside `voice-engine/` on its own fails for lack of a DOM environment, so run it through the dashboard.

**Control plane and shard**, in `control/`:

```bash
bun test
```

This runs every test under `control/`. The package's own `test` script runs only the shared module (`bun test --cwd shared`).

**The dsh plugin**, in `plugins/dsh/voice/`:

```bash
bun run test
bun run lint
bunx tsc -p .
```

**Fluid servers** (Swift, Apple Silicon) have their own tests and smoke check; see [services/fluid/DEVELOPING.md](../../services/fluid/DEVELOPING.md).

## Changing a plugin

**OpenClaw voice-mode.** Run `bun run build` in `plugins/openclaw/voice-mode` after every change. The built `dist/` is what OpenClaw loads. [Changing the plugin](../guide/plugins/openclaw.md#changing-the-plugin) has the details.

**dsh voice.** Run `bun run build` in `plugins/dsh/voice` to rebuild the package into `dist/package`. `ops/dsh-plugin-install.sh <banter-url>` builds it and installs it into your dsh profiles (`--link` to link this checkout's build instead of a copy). [Setting up the dsh voice plugin](../guide/plugins/dsh-voice/setup.md) walks through the install, including what it writes to the profile.

## Releasing

Banter has one version, `version` in the root `package.json`, numbered with [semantic versioning](https://semver.org): the patch number for fixes, the minor number for features and for anything a person updating should read about first; it stays below 1.0. The dsh plugin's package carries the same version.

To release, set the new version in the root `package.json`, commit, and push a matching tag:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

The tag runs `.github/workflows/release.yml`: it refuses a tag that does not match the version, runs the dsh plugin's tests, and creates a GitHub release with notes generated from the commits since the last one and the dsh plugin built from the tagged commit (`banter-dsh-voice-<version>.tgz`).

## Repository layout

| Folder | What it holds |
|---|---|
| `control/` | The Banter server: `control-plane/` (the API, registry, health checks, service lifecycle, and serving the web app), `control-shard/` (the optional worker-machine server), `shared/` (code both use), `probe/` and `scripts/`. |
| `dashboard/` | The web app: a React single-page app with the chat and services pages. |
| `voice-engine/` | The browser voice loop: microphone, speech detection, turn-taking, playback. Used by the web app and the dsh plugin. |
| `shared/` | Types shared across the workspaces. |
| `services/` | Adapter servers that put an OpenAI-compatible API in front of speech models: `stt/`, `tts/` and the Swift `fluid/` servers. See [services/README.md](../../services/README.md). |
| `plugins/` | `openclaw/voice-mode` and `dsh/voice`. |
| `ops/` | Install, deploy, start, stop and uninstall scripts, and the systemd and launchd templates. |
| `scripts/` | Development tools, including `control-dev.sh`, `shard-dev.sh`, the fluid build and smoke scripts, and the git hooks. |
| `schemas/` | The JSON schema for the configuration contracts, starting with the model roster. |
| `dev/` | Working material: specs, design notes, plans, analysis and probes. |
| `docs/` | This documentation; see the [index](../README.md). |

The config templates are in `control/control-plane/data/` (`config.example.json`, `registry.example.json`, and `config.md`, a pointer to the [configuration reference](configuration.md)), and the shard's in `control/control-shard/data/registry.example.json`. The fluid servers' registry entries are in `services/fluid/registry.fluid.example.json`. These are the tracked source that deploy merges into the live files; they are never read at runtime.

## Where to start reading

- [architecture.md](architecture.md): the three planes, and how the control plane and shard relate.
- [ops/](../../ops/README.md): what a deployment needs outside the build, including `service-control.sh` for driving a service by hand when the API is unavailable.
- [scripts/](../../scripts/README.md): development tools: running the control plane or shard from source, building and smoke-testing the fluid servers, regenerating the API reference.
- [design/voice-system.md](design/voice-system.md) and [components/voice-turn-taking.md](components/voice-turn-taking.md): how a voice session starts and ends, and how the human, agent and system sides share the floor.
- [protocols/](protocols/): agent backend protocols, one directory per vendor. [OpenClaw](protocols/openclaw/) is what Banter speaks, [OpenCode](protocols/opencode/) is a second server it could attach to, and [dsh](protocols/dsh/) is the DeepSeek Harness web protocol. Start here to point Banter at a different agent harness; swapping the agent backend is the most likely large change.
- [dashboard/UI.md](../../dashboard/UI.md) and [dashboard/ui-design-system.md](../../dashboard/ui-design-system.md): the visual system.

### This folder

| Page | What it covers |
|---|---|
| [components/](components/index.md) | One page per component: what is built and how it works. |
| [protocols/](protocols/) | Agent backend protocols, one folder per vendor. |
| [design/](design/) | Why each part is shaped as it is. |
| [configuration.md](configuration.md) | Every field of `config.json` and `registry.json`. |
| [api.md](api.md) | The control plane's HTTP API, generated from the route definitions. |
| [speech-server-api.md](speech-server-api.md) | What a speech server must answer. |
| [architecture.md](architecture.md) | The three planes, and how a voice turn works end to end. |
| [test-environment.md](test-environment.md) | Running a branch's control plane and fluid servers beside an install, and pointing the dsh plugin at them. |
