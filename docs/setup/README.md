# Setup

Everything for installing Banter and configuring it, in the order most installs need it.

| Page | What it covers |
|---|---|
| [install.md](install.md) | The install script, the same steps by hand, installing as a service on each OS, where it installs, uninstalling |
| [speech-servers.md](speech-servers.md) | Connecting speech servers: the example registry, CORS, adding another server, fluid as an Apple Silicon option |
| [configuration.md](configuration.md) | `config.json` and `registry.json`: the minimum, services, runners, endpoints, CORS, voice settings, deployment, reloading |
| [stt.md](stt.md) | Registry and config snippets per speech-to-text server |
| [tts.md](tts.md) | Registry and config snippets per text-to-speech server |
| [models.md](models.md) | Which speech models exist, what each needs, and which servers run them |
| [voices-and-models.md](voices-and-models.md) | The roster: providers, models and voices, and how to change the default voice or add a voice, a model or a server |
| [linux-speech-servers.md](linux-speech-servers.md) | The contract a speech server must meet, and servers known to run on Linux |
| [shard.md](shard.md) | Adding a worker machine that runs its own control plane |
| [remote-access.md](remote-access.md) | Reaching the dashboard from outside your network, and why `https`; Tailscale as one way |
| [ios.md](ios.md) | Voice on iPhone and iPad |
| [plugin.md](plugin.md) | The OpenClaw voice-mode plugin |

Reference docs outside this folder: [speech-server-api.md](../speech-server-api.md) (what a speech server must answer), [OPERATIONS.md](../OPERATIONS.md) (running a deployment), [control-shard.md](../control-shard.md) (shard design), [adapting.md](../adapting.md) (another agent harness), and [services/README.md](../../services/README.md) (the adapter servers in this repo).
