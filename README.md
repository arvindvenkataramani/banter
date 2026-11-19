# Banter

A conversational voice interface for agent harnesses, using fully private & self-hosted transcription and speech services of your choice.

It hears when you have actually meant to finish speaking, cleans your speech of fillers, replies as the words are written, and lets you cut in mid-sentence. A control plane can start a speech model when a conversation needs it and unload it when it does not, across as many machines as you point it at.

Built against [OpenClaw](https://docs.openclaw.ai/), and adaptable to other agent harnesses. A [plugin for DeepSeek Harness](docs/guide/plugins/dsh-voice/README.md) is available.

![Banter's chat interface, desktop and mobile](docs/images/screenshot.jpg)

## What it does

**Banter is designed to have fast, natural-feeling conversations, with zero effort. Speech quality is defined by the speech models you choose to run / can afford, and can be run entirely off private models hosted anywhere.**

### Features

**Thoughtful turn-taking.** Most voice interfaces wait a fixed number of milliseconds for silence, so pausing to think cuts you off. Banter runs two ONNX models in the browser: Silero VAD decides when you are speaking, and pipecat's smart-turn decides whether you have finished a thought or merely paused. "I was thinking that…" and "I was thinking that." get different treatment. The reply streams back as audio while it is still being generated, and talking over it cuts the playback and starts a new turn. All this is tunable via `config.json`

**Simultaneous text chat.** Message history, streaming responses, tool calls as expandable cards, and a session list for switching between conversations. Voice is one input mode on that page; turn it off and an ordinary text client remains. There are limitations: it is not a full replacement for a text chat, and doesn't include features like steering, response queues, or file attachments/uploads. The UI is tuned to be a voice-first interface. Unlike the Discord integrations, you get simultaneous voice and text chats, with the ability to use text mid-conversation.

**Full control over your speech and text data.** You install the speech-to-text and text-to-speech servers yourself, and the registry points at them by address, so your audio only ever reaches machines you run. The VAD and turn-detection models download once, verified against pinned SHA-256 hashes, and run in the browser from then on. You can send your audio anywhere, including ElevenLabs or OpenAI's transcription services, but Banter is built on a model where you never need to.

**Services can start when needed and unload when idle.** A service whose `lifecycle` settings say so is demand-loaded: started on first use, health-checked until ready, evicted after a timeout. One machine can then host more models than it has memory to run at once. The services page shows health for everything in the registry, with manual start and stop.

**Services can live anywhere.** A service is a registry entry with an address and a health path; the registry has no notion of what the service does. It can run on the same box, on another machine, or under something you manage yourself. Runners cover spawning a process, driving systemd or launchd, delegating to a service's own CLI, and health-checking something already running. Speech models are what this was built for, and anything answering HTTP can be registered alongside them.

**Nothing to install on client devices.** The dashboard ships a web manifest, so it can be saved to a phone's home screen and run standalone. An unattended mode enables a screen lock for hands-free use on phones.

## Requirements and constraints

- Speech servers must be OpenAI-compatible and allow CORS from the dashboard's origin; see [docs/guide/speech-servers.md](docs/guide/speech-servers.md).
- The install scripts target Linux with systemd. On macOS or Linux without systemd, run the control plane under a supervisor you provide; native Windows is not supported. See [docs/guide/install.md](docs/guide/install.md#install-as-a-service).
- There is no tool-use or action-approval UX, deliberately: a hastily built gate in a voice interface would be insecure. If your harness needs approvals, see [docs/guide/adapting.md](docs/guide/adapting.md#no-tool-approvals).

## Quick start

Needs [Bun](https://bun.sh), `jq`, `lsof` and an [OpenClaw](https://github.com/openclaw/openclaw) gateway; [docs/guide/install.md](docs/guide/install.md) has the full list.

```bash
git clone https://github.com/arvindvenkataramani/banter.git
cd banter
scripts/install.sh
```

The script installs one thing: the Banter server (the control plane), which also serves the dashboard. It prompts for your gateway URL and token, runs the server as a service, and prints its address when it finishes. Open that address (`http://localhost:4200` unless you changed the port) for the dashboard. Typing works at once.

Two steps are separate, and optional:

- **Speech servers.** Voice needs them; text chat works without. Banter installs none. Install one from its folder's README ([`services/README.md`](services/README.md) lists them), then see [docs/guide/speech-servers.md](docs/guide/speech-servers.md) for CORS and for adding your own.
- **The dsh plugin.** To use voice inside DeepSeek Harness, [docs/guide/plugins/dsh-voice/setup.md](docs/guide/plugins/dsh-voice/setup.md) builds and installs it, using the address the script printed.

An LLM or agent can follow [docs/guide/install.md](docs/guide/install.md) for you.

> **Voice needs https, or localhost.** Browsers only give the microphone to a secure page. On the machine running Banter, `http://localhost:4200` works. From any other device, a phone or another computer, a plain `http://<lan-address>` page can chat by text, but voice can't start. Serve the dashboard over https for that: [docs/guide/remote-access.md](docs/guide/remote-access.md) shows how with Tailscale. The settings dialog warns when the page can't use the microphone.

## Documentation

The [documentation index](docs/README.md) lists every page. Setup, in [docs/guide/](docs/guide/install.md):

- [install.md](docs/guide/install.md): the install script, manual setup, installing as a service on each OS, where it installs, uninstalling
- [speech-servers.md](docs/guide/speech-servers.md): connecting speech servers, checking CORS, adding another server, fluid as an Apple Silicon option
- [configuration.md](docs/reference/configuration.md): the minimum config, adding services, adding a shard
- [stt.md](docs/guide/stt.md) and [tts.md](docs/guide/tts.md): registry and config snippets per speech server
- [models.md](docs/guide/models.md): which speech models to run, and what each needs
- [voices-and-models.md](docs/guide/voices-and-models.md): the roster of providers, models and voices, and how to customise it
- [Speech servers on Linux](docs/guide/speech-servers.md#linux): the contract a speech server must meet, and servers known to run on Linux
- [shard.md](docs/guide/shard.md): adding shards on other machines
- [remote-access.md](docs/guide/remote-access.md): reaching the dashboard from outside your network, and why `https`
- [ios.md](docs/guide/ios.md): voice on iPhone and iPad
- [plugins/openclaw.md](docs/guide/plugins/openclaw.md): the OpenClaw voice-mode plugin

The dsh voice plugin, in [docs/guide/plugins/dsh-voice/](docs/guide/plugins/dsh-voice/README.md):

- [README.md](docs/guide/plugins/dsh-voice/README.md): what it is, the controls and their colours, the mic shortcut
- [setup.md](docs/guide/plugins/dsh-voice/setup.md): build, install into a dsh profile, start dsh
- [settings.md](docs/guide/plugins/dsh-voice/settings.md): the Speech, Listening and General tabs

Everything else:

- [docs/guide/operations.md](docs/guide/operations.md): running a deployment: where things live, logs, restarts, backups
- [docs/reference/architecture.md](docs/reference/architecture.md): how the system works
- [docs/reference/protocols/](docs/reference/protocols/): agent backend protocols, one directory per vendor: [OpenClaw](docs/reference/protocols/openclaw/) is what Banter speaks, [OpenCode](docs/reference/protocols/opencode/) is a second server it could attach to. The starting point for adapting this to a different agent harness
- [docs/guide/adapting.md](docs/guide/adapting.md): putting Banter's voice in front of another harness, or reusing the voice pipeline elsewhere
- [docs/reference/speech-server-api.md](docs/reference/speech-server-api.md): what a speech server must answer
- [docs/reference/api.md](docs/reference/api.md): generated HTTP API reference
- [services/README.md](services/README.md): the adapter servers in this repo
- [scripts/README.md](scripts/README.md): deployment, lifecycle, and diagnostic scripts

## Architecture

- **Control plane** — the always-on process. Serves the dashboard, holds the registry of every known service and host, runs periodic health checks, and exposes the API the dashboard uses.
- **Dashboard** — a React SPA served by the control plane. Two pages: chat (the root route) and services. The whole voice pipeline runs here, in the browser.
- **Control shard** (optional) — a full second control plane on a worker machine, so services can live on hardware that suits them. See [docs/guide/shard.md](docs/guide/shard.md).
- **`services/`** — adapter servers that put an OpenAI-compatible API in front of speech models, for example the Python adapters under [`services/stt`](services/stt/faster-whisper/README.md) and [`services/tts`](services/tts/kokoro/README.md), or the Swift servers in [`services/fluid`](services/fluid/README.md) for Apple Silicon. Nothing installs itself; you install the ones you want and register each in the registry. See [docs/guide/models.md](docs/guide/models.md) for the options and [services/README.md](services/README.md) for how to install them.
- **`plugins/openclaw/voice-mode/`** — installs into your OpenClaw gateway and tells the agent it is being spoken to rather than read, so it answers in a way that works out loud.
- **`plugins/dsh/voice/`** — an optional plugin that brings voice into the web UI of DeepSeek Harness (dsh), taking speech from a Banter server. See [docs/guide/plugins/dsh-voice/](docs/guide/plugins/dsh-voice/README.md).
- **`scripts/`** — install, deploy, and diagnostic scripts for running the control plane (and shards) as a system service, plus a few standalone tools like driving a service by hand when the API is unavailable. None of it is required for local development. See [scripts/README.md](scripts/README.md) for the index.

[docs/reference/architecture.md](docs/reference/architecture.md) has the full picture — how a voice turn works end to end, and why the control plane exists at all.

**Networking.** Any network where the machines can reach each other will do — nothing is required for control plane–shard connectivity or for reaching services. Endpoints default to plain `http`; set `scheme: "https"` per service or registry-wide when something terminates TLS, whether that's a reverse proxy, your own cert, or Tailscale Serve.

If you want the dashboard on your phone while away from home, you need some way in from outside your network. [Tailscale](https://tailscale.com/) is one answer and the one Banter has built-in support for — set `tailscaleServe` on a service and it registers with `tailscale serve` on start, giving you an HTTPS address on your tailnet without opening a port to the internet. See [docs/guide/remote-access.md](docs/guide/remote-access.md) for the actual steps. Voice on a phone needs a secure page (`https`, or `localhost`); on a LAN, plain `http` is enough for text. Any other remote-access approach works too; Banter simply has no built-in support for it.

## Hardening

This ships with defaults for one machine or a trusted network. A few things worth knowing before exposing it beyond your own machine:

- **Unauthenticated gateway on a bare deploy.** If `integrations.openclaw.gateway.token` is left as `"${OPENCLAW_GATEWAY_TOKEN}"` and the deployed service has no env file loading that variable, the placeholder resolves to nothing and the gateway connection goes unauthenticated (see [Configure it](docs/guide/install.md#configure-it)). Paste the real token for any deployed run, or confirm your env file is actually loaded.
- **CORS on STT/TTS services.** The browser calls your speech servers cross-origin from the dashboard's own origin, so each one needs its CORS origins set to match — see the "CORS" section in [docs/reference/configuration.md](docs/reference/configuration.md#cors) and [docs/guide/speech-servers.md](docs/guide/speech-servers.md#cors). Leaving these wide open lets any page in a user's browser call your speech servers.
- **Plain http.** Banter defaults to `http`, which suits one machine or a trusted home network. Beyond that, use `https`: see [Why https](docs/guide/remote-access.md#why-https).
- **Remote dev access.** The dev server (`dashboard/vite.config.ts`) only accepts `localhost` by default — reaching it from another device (e.g. over Tailscale, for testing on a phone) needs a hostname added to Vite's `allowedHosts`. Add it locally, e.g.:
  ```ts
  server: {
    host: '127.0.0.1',
    allowedHosts: ['your-host.your-tailnet.ts.net'],
    proxy: { '/api': process.env.VITE_PROXY_TARGET ?? 'http://localhost:4200' },
  },
  ```
  Don't commit a real hostname here if you plan to share the repo — it costs nothing to leak but it's still your infrastructure.

## Forking and customising

This is published as-is and only occasionally maintained; expect updates to come roughly once every six months. If you find bugs, do submit an issue or a PR, and feel free to fork it if a response is slow.

### Running against the source

```bash
bun run control-dev
```

Control plane with Vite and HMR against the dashboard source. It reads the *deployed* config and registry, so it needs a completed install first — it iterates on an installation rather than replacing one. Re-run `scripts/control-deploy.sh` to promote your changes.

```bash
cd dashboard && bun run test      # vitest
cd dashboard && bun run lint      # eslint
cd control && bun test            # control plane and shard
```

`bun test` in `control/` runs all of it; that package's own `test` script covers only the shared module.

Most of `scripts/` is maintenance and deploy tooling rather than day-to-day dev — `deploy-preflight.sh`, `branch-status.sh`, `service-control.sh`, and the rest of what a fork's own install/upgrade path would lean on. See [scripts/README.md](scripts/README.md).

### Changing the plugin

Run `bun run build` in `plugins/openclaw/voice-mode` after every change; the built `dist/` is what OpenClaw loads. [docs/guide/plugins/openclaw.md](docs/guide/plugins/openclaw.md#changing-the-plugin) has the details.

### Where to start reading

- [docs/reference/architecture.md](docs/reference/architecture.md) — the three-plane structure, and how the control plane and shard relate
- [docs/reference/design/voice-system.md](docs/reference/design/voice-system.md) and [docs/reference/components/voice-turn-taking.md](docs/reference/components/voice-turn-taking.md) — how a voice session starts and ends, and how the human, agent and system sides share the floor
- [docs/reference/protocols/](docs/reference/protocols/) — agent backend protocols, one directory per vendor: [OpenClaw](docs/reference/protocols/openclaw/) is what Banter speaks, [OpenCode](docs/reference/protocols/opencode/) is a second server it could attach to. The place to start if you want to point this at a different agent harness
- [dashboard/UI.md](dashboard/UI.md) and [dashboard/ui-design-system.md](dashboard/ui-design-system.md) — the visual system

Swapping the agent backend is the most likely large change, and the gateway docs exist for exactly that.

## Status and license

Published as-is and only occasionally maintained; no support implied. See [Forking and customising](#forking-and-customising) for what to expect if you open an issue or a PR.

**Apache-2.0** — see `LICENSE` for the terms and `NOTICE` for attribution. In short, for the code in this repository:

- **Use it** for anything, including commercially, privately, or as part of a product you sell. No fee, no permission needed, no obligation to publish what you build.
- **Change it and redistribute it**, under this license or another, provided you ship a copy of the license, keep the existing copyright and attribution notices, mark the files you modified as changed, and carry the `NOTICE` file forward — in the source, the documentation, or a display the software generates.
- **Patents**: contributors grant you a patent license for their contributions, which terminates if you sue someone alleging this software infringes a patent.
- **No warranty and no liability.** It is provided as-is; if it breaks something, that is yours to deal with.
- **No trademark rights** — the license covers the code, not the name.

That covers this repository's own code. It does **not** cover what you run underneath it — the models and some third-party service adapters are governed by their own publishers' terms, separate from this repository's.

This summary is for orientation, not legal advice; `LICENSE` is what governs.
