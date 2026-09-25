# Fluid speech servers

`fluid-stt` and `fluid-tts` are Banter's default speech servers on a Mac: one for transcription and one for speech. Both are built from this Swift package on [FluidAudio](https://github.com/FluidInference/FluidAudio), which runs speech models through CoreML on Apple Silicon. The example registries already declare them, so on a Mac they are what a fresh install talks to.

## What they're for

Any server that meets the [speech server API](../../docs/speech-server-api.md) works with Banter. These two are the ones built for its voice loop:

- **Your words appear as you speak.** `fluid-stt` streams transcription over a WebSocket, so text arrives mid-sentence instead of after a silent pause. That makes a slow or stalled system visible: text arriving means the microphone, network, server and model are all working. Streaming costs some accuracy. On benchmark speech, Parakeet Unified streaming scored 0.051 WER against 0.033 in batch.
- **Replies start speaking quickly.** With Pocket TTS, `fluid-tts` streams audio as it's generated. How long first audio takes no longer depends on the reply's length: it's about 0.3 s with a short streaming interval, where a batch server took 0.7 s for a short line and 9 s for a long one.
- **Light on the network.** Audio goes up as Opus and comes back as AAC, about a twelfth the size of WAV. That matters for a phone on a mobile connection.
- **Memory comes back.** Each server holds one model at a time and releases it on switch or unload. That suits a control plane that starts and stops services on demand. mlx-audio, by contrast, keeps every model it has loaded.
- **Nothing to install around them.** Each is a single native binary: no Python environment, no model server.

The trade-offs:

- Apple Silicon and macOS 15 or later only. For Linux, see [linux-speech-servers.md](../../docs/linux-speech-servers.md).
- One model is resident at a time, and switching models takes around thirteen seconds.
- A model needs code in the server before the roster can offer it; the roster only chooses among models the server already supports.

## What they can do

`fluid-stt`:

| Model | Kind | Notes |
|---|---|---|
| `parakeet-tdt-v3` | batch | 25 European languages |
| `parakeet-unified-0.6b` | batch and streaming | One model with two modes; the shipped default, streaming |
| `nemotron-streaming-en-0.6b` | streaming | English. Chunk sizes of 560, 1120 or 2240 ms trade update frequency for per-call overhead |

`fluid-tts`:

| Model | Notes |
|---|---|
| `pocket-tts` | Streams. Voices come from a few seconds of reference audio |
| `kokoro-ane` | 28 preset voices, runs on the Neural Engine. The shipped default |
| `luxtts` | Voices from reference audio |

Which models each server offers comes from the `roster` section of the registry, not from the command line. [voices-and-models.md](../../docs/voices-and-models.md) covers choosing a default, adding voices, and adding a voice from reference audio.

Model weights are not bundled. The first load of each model downloads it into `~/Library/Application Support/FluidAudio/Models/`, so that load is slow and needs a network connection.

## Install

`scripts/install.sh` offers to build and install both servers on Apple Silicon. To do it yourself:

1. **Prerequisites.** macOS 15 or later on Apple Silicon, a Swift 6 toolchain (`xcode-select --install`, or Xcode 16), and `brew install opus`.
2. **Build:** `scripts/fluid-build.sh`. It checks the prerequisites first and names anything missing with the command to install it. The binaries land in `services/fluid/.build/release/`.
3. **Install:** `scripts/control-install-services.sh` on a single machine, or `scripts/shard-install-services.sh` on a [shard](../../docs/shard-setup.md). Each copies the binaries to `~/services/fluid/fluid-stt/` and `~/services/fluid/fluid-tts/`, as the registry entries declare. A server that is running is stopped for the swap and started again, and a binary that hasn't changed is left alone.

After a code change, run the same two scripts again.

The install copies everything each server needs to run into its folder: `fluid-tts` also gets `FluidAudio_FluidAudio.bundle`, the pronunciation data LuxTTS reads. Once installed, the checkout you built from can go.

FluidAudio is pinned to a fork carrying fixes for Pocket TTS; `swift build` fetches it. [patches/README.md](patches/README.md) explains what the fixes are and what to check before moving the pin.

## Running them

The control plane starts each server on demand, using the `runner.main` line in its registry entry:

```
.build/release/fluid-stt --port 8767 --registry ~/services/banter/control/control-plane/data/registry.json --provider fluid-stt
.build/release/fluid-tts --port 8769 --registry ~/services/banter/control/control-plane/data/registry.json --provider fluid-tts
```

- `--registry` and `--provider` are required: the server reads that provider's models from the registry's `roster` section, and refuses to start if it can't find or validate them. On a shard, `--registry` points at the shard's own `~/services/shard/registry.json`.
- `--bind local` (the default) listens on `127.0.0.1` only, which is what Tailscale Serve proxies to. `--bind all` listens on every interface over plain HTTP.
- `FLUID_CORS_ORIGINS` (comma-separated origins) must include the dashboard's origin, since the browser calls these servers directly. `scripts/install.sh` fills it in from the registry's control-plane port.
- Health is `GET /healthz`.

Each server starts with no model loaded. The dashboard loads the configured model when a voice session starts.

## More

- [docs/speech-server-api.md](../../docs/speech-server-api.md): the routes and streaming protocol these servers answer.
- [DEVELOPING.md](DEVELOPING.md): how the package is built, the source layout, and fluid-specific API behaviour.
