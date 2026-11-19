# Banter documentation

## Start here

| If you want to | Read |
|---|---|
| Install Banter | [guide/install.md](guide/install.md) |
| Connect a speech server | [guide/speech-servers.md](guide/speech-servers.md) |
| Use voice from a phone or another computer | [guide/remote-access.md](guide/remote-access.md) |
| Run a deployment | [guide/operations.md](guide/operations.md) |
| Understand how the system fits together | [reference/architecture.md](reference/architecture.md) |

## Guide

Setting up and using Banter, in the order most installs need it.

| Page | What it covers |
|---|---|
| [install.md](guide/install.md) | The install script, the same steps by hand, installing as a service on each OS, where it installs, uninstalling |
| [speech-servers.md](guide/speech-servers.md) | Connecting speech servers: the example registry, CORS, adding another server, fluid as an Apple Silicon option, and servers known to run on Linux |
| [stt.md](guide/stt.md) | Registry and config snippets per speech-to-text server |
| [tts.md](guide/tts.md) | Registry and config snippets per text-to-speech server |
| [models.md](guide/models.md) | Which speech models exist, what each needs, and which servers run them |
| [voices-and-models.md](guide/voices-and-models.md) | The roster: providers, models and voices, and how to change the default voice or add a voice, a model or a server |
| [shard.md](guide/shard.md) | Adding a worker machine that runs its own control plane |
| [remote-access.md](guide/remote-access.md) | Reaching the dashboard from outside your network, and why `https`; Tailscale as one way |
| [ios.md](guide/ios.md) | Voice on iPhone and iPad |
| [operations.md](guide/operations.md) | Running a deployment: where things live, logs, restarts, backups |
| [adapting.md](guide/adapting.md) | Putting Banter's voice in front of another agent harness, or reusing the voice pipeline elsewhere |
| [plugins/openclaw.md](guide/plugins/openclaw.md) | The OpenClaw voice-mode plugin |
| [plugins/dsh-voice/](guide/plugins/dsh-voice/README.md) | The dsh voice plugin: controls, [setup](guide/plugins/dsh-voice/setup.md) and [settings](guide/plugins/dsh-voice/settings.md) |

## Reference

How it works, and what the knobs are.

| Page | What it covers |
|---|---|
| [configuration.md](reference/configuration.md) | `config.json` and `registry.json`: the minimum, services, runners, endpoints, CORS, voice settings, deployment, reloading |
| [api.md](reference/api.md) | The control plane's HTTP API, generated from the route definitions |
| [speech-server-api.md](reference/speech-server-api.md) | What a speech server must answer |
| [architecture.md](reference/architecture.md) | The three planes, and how a voice turn works end to end |
| [components/](reference/components/index.md) | One page per component: what is built and how it works, including the [control shard](reference/components/control-shard.md) and the [voice interface](reference/components/voice-interface.md) |
| [protocols/](reference/protocols/) | Agent backend protocols, one folder per vendor: `openclaw/`, `opencode/` and `dsh/` |
| [design/](reference/design/) | Why each part is shaped as it is |

The adapter servers in this repo are indexed in [services/README.md](../services/README.md), and the install and run scripts in [ops/README.md](../ops/README.md).
