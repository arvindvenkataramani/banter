# Choosing speech models

Which speech-to-text and text-to-speech models to run, and what each one needs. For ready-to-copy registry/config snippets once you've chosen, see [tts-setup.md](tts-setup.md) and [stt-setup.md](stt-setup.md); for what those registry fields mean in general, see [configuration.md](configuration.md); for the adapter code itself, see [../services/README.md](../services/README.md).

Most of what this repo builds and ships — the fluid servers, `stt/whisper`, and every MLX-based option (`parakeet-mlx-fastapi`, `mlx-audio`) — is Apple Silicon only. Each model and adapter below says so where it applies. For a Linux install, see [docs/linux-speech-servers.md](linux-speech-servers.md).

Neither the model nor the framework matters to Banter. Any server is usable if it:

1. serves the OpenAI-shaped endpoint for its kind — `/v1/audio/transcriptions` for STT, `/v1/audio/speech` for TTS;
2. answers a health path with a 2xx when ready; and
3. permits the dashboard's origin in its CORS configuration.

Anything satisfying that can be registered, health-checked, and demand-started the same as the servers in `services/`.

## Quick start

**On Apple Silicon**, the shipped registry and config examples already default to `fluid-stt`/`fluid-tts` — see [`services/fluid`](../services/fluid/README.md) for what they offer. `scripts/install.sh` offers to build them, or run `scripts/fluid-build.sh` yourself; nothing in this section is needed on that path. See [docs/voices-and-models.md](voices-and-models.md) to add or change a voice or model on top of it.

**On Linux**, the fluid servers don't build — the package targets macOS 15+ on Apple Silicon only. See [docs/linux-speech-servers.md](linux-speech-servers.md) for what runs there instead.

The Kokoro + Parakeet pair below is worth knowing regardless of the above: Kokoro runs on Linux as well as Apple Silicon (see its Platform column below); `parakeet-mlx-fastapi` is Apple Silicon (MLX) only, same as the fluid servers. Both install with pip, both download their own models on first run, and neither needs a compile step. See [Text-to-speech](#text-to-speech-models-recommended) and [Speech-to-text](#speech-to-text-models-recommended) below for what else is available.

Both sections end with a service entry to add to `registry.json` and start once by hand — `loadStrategy: "demand"` means Banter starts it on first use and unloads it after thirty minutes idle; set `"autoStart": true` instead if you would rather it came up with the control plane.

### Kokoro (TTS) — Linux and Apple Silicon

```bash
cp -r <banter>/services/tts/kokoro ~/services/tts/kokoro
cd ~/services/tts/kokoro
python -m venv .venv && .venv/bin/pip install -r requirements.txt
```

Add this entry to `registry.json`'s `services`:

```json
{
  "id": "tts-kokoro",
  "name": "Kokoro",
  "capabilityId": "tts",
  "hostId": "<your-host-id>",
  "permissions": { "enabled": true, "protected": false },
  "runner": {
    "type": "process",
    "main": ".venv/bin/uvicorn server:app --host 127.0.0.1 --port 8002"
  },
  "ops": { "env": { "workingDirectory": "~/services/tts/kokoro" } },
  "network": { "port": 8002, "healthPath": "/health" },
  "lifecycle": { "loadStrategy": "demand", "idleUnload": true, "idleTimeout": 1800000 }
}
```

Then add a `roster.providers` entry for it in `registry.json` — alongside the `fluid-tts`/`fluid-stt` entries already there, not replacing them — naming its model and at least one preset voice, and point `config.json`'s `voice.tts.selection` at it:

```json
"roster": {
  "providers": {
    "tts-kokoro": {
      "responseFormat": "wav",
      "ttsModels": [
        {
          "id": "hexgrad/Kokoro-82M",
          "name": "Kokoro",
          "key": "hexgrad/Kokoro-82M",
          "presetVoices": [{ "id": "af_heart", "name": "Heart" }]
        }
      ]
    }
  }
}
```

Kokoro's server always returns `audio/wav`, hence `responseFormat: "wav"` above — `responseFormat` absent defaults to `mp3`, which would make the dashboard try to decode wav bytes as mp3.

```json
"voice": {
  "tts": {
    "selection": { "serviceId": "tts-kokoro", "model": "hexgrad/Kokoro-82M", "voice": "af_heart" }
  }
}
```

The roster is the catalogue the settings dialog offers; a model or voice missing from it cannot be selected, however well the server runs. See [docs/voices-and-models.md](voices-and-models.md) for what a provider, model and voice are, and how to add more.

Start it once by hand before relying on demand-loading, so the first-run model download happens where you can see it:

```bash
cd ~/services/tts/kokoro && .venv/bin/uvicorn server:app --port 8002
```

### Parakeet (STT) — Apple Silicon (MLX)

Third-party, pip-installable.

```bash
mkdir -p ~/services/stt/parakeet && cd ~/services/stt/parakeet
python -m venv .venv && .venv/bin/pip install parakeet-mlx-fastapi
```

Add this entry to `registry.json`'s `services`. Replace the CORS origin below with wherever you reach the dashboard — that is the setting people most often get wrong, and the symptom is a transcription failure that looks like the service being down.

```json
{
  "id": "stt-parakeet",
  "name": "Parakeet",
  "capabilityId": "stt",
  "hostId": "<your-host-id>",
  "permissions": { "enabled": true, "protected": false },
  "runner": {
    "type": "process",
    "main": ".venv/bin/parakeet-server --model mlx-community/parakeet-tdt-0.6b-v3 --host 127.0.0.1 --port 8765"
  },
  "ops": {
    "env": {
      "workingDirectory": "~/services/stt/parakeet",
      "variables": {
        "PARAKEET_CORS_ORIGINS": "http://localhost:4200"
      }
    }
  },
  "network": { "port": 8765, "healthPath": "/healthz" },
  "lifecycle": { "loadStrategy": "demand", "idleUnload": true, "idleTimeout": 1800000 }
}
```

Then add this to `config.json`'s `voice.stt` block — set `serviceId` to match:

```json
"voice": {
  "stt": { "serviceId": "stt-parakeet" }
}
```

Start it once by hand before relying on demand-loading:

```bash
cd ~/services/stt/parakeet && .venv/bin/parakeet-server --model mlx-community/parakeet-tdt-0.6b-v3 --port 8765
```

---

## Models vs. what serves them

Three distinct things, often confused for one:

- **Model** — weights. Nothing more.
- **Runtime** — a library that loads a model and runs inference. No HTTP.
- **Server** — the HTTP process Banter registers: answers `POST /v1/audio/...` and a health check.

A model may ship with a runtime, a server, both, or neither. Where a runtime exists but no server does, something has to add an HTTP layer before Banter can use it.

The **Served via** column below names whatever plays the server role for that model — this repo's own adapter code (see [`services/README.md`](../services/README.md)), a general-purpose runtime server, or a third-party package built for that one model. Any can be swapped for something else meeting the contract described at the top of this page.

General-purpose runtime servers worth knowing about:

| Runtime | Platform | Get it |
|---|---|---|
| mlx-audio | Apple Silicon (MLX) | [Blaizzy/mlx-audio](https://github.com/Blaizzy/mlx-audio) |
| oMLX | Apple Silicon (MLX) | [jundot/omlx](https://github.com/jundot/omlx) |
| vLLM-Omni | Linux/Windows (CUDA/ROCm/XPU) | [vllm-project/vllm-omni](https://github.com/vllm-project/vllm-omni) |
| LocalAI | Linux/Windows/macOS (CPU, CUDA, ROCm, Vulkan, and more) | [mudler/LocalAI](https://github.com/mudler/LocalAI) |

A server's platform restriction comes from what it's built on, not from the model it happens to be serving.

## Text-to-speech models recommended

One row per model, linked to its model card or source. For comparative quality/speed data across TTS models and to discover new ones suitable for you, see [5uck1ess/tts-bench](https://github.com/5uck1ess/tts-bench), a third-party benchmark suite. For registry/config snippets to actually set one of these up, see [tts-setup.md](tts-setup.md).

These models are recommended because they're suitable for realtime or near-realtime use. There are models that generate better audio but they're not usable in a voice conversation context.

| Model | Platform | Served via | Notes |
|---|---|---|---|
| [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) | Linux and macOS (no MLX/CUDA dependency) | this repo's adapter ([`tts/kokoro`](../services/tts/kokoro)) | 82M parameters, small by current TTS standards. Preset voices only, no cloning. |
| [NeuTTS Air](https://huggingface.co/neuphonic/neutts-air) | Linux and macOS — NeuTTS itself runs on CPU, CUDA, or ROCm; nothing MLX-specific in this adapter | this repo's adapter ([`tts/neutts-air`](../services/tts/neutts-air)) | 0.7B parameters. Voice cloning from a few seconds of reference audio. Output length for identical input text can vary run to run, and quality degrades on longer passages — sentence-level chunking helps. |
| [Voxtral](https://huggingface.co/mistralai/Voxtral-4B-TTS-2603) | Apple Silicon (MLX) | `mlx-audio` | 4B parameters. 20 preset voices across 9 languages, with voice cloning from a reference sample. Ships in several quantizations (4-bit through bf16); the 6-bit build is the pick for realtime use — full bf16 is too slow for a voice conversation. |
| [Pocket TTS](https://huggingface.co/kyutai/pocket-tts) | this repo's `fluid-tts` is Apple Silicon; `mlx-audio` is Apple Silicon too — see the model's own docs for other runtimes | `fluid-tts` ([`services/fluid`](../services/fluid)), `mlx-audio`, or a third-party OpenAI-compatible wrapper | 100M parameters, ~30MB weights. Voice cloning from a few seconds of reference audio, plus a handful of preset voices. Sub-50ms first-chunk latency. |
| [OmniVoice](https://huggingface.co/k2-fsa/OmniVoice) | — | needs an adapter — none in this repo | Voice cloning and voice design (describe a voice by attributes like gender, age, or accent) across 600+ languages. Reference usage returns a complete audio array rather than a stream. |
| Anything OpenAI-compatible | whatever the server runs on | either | Any server that exposes `POST /v1/audio/speech` plus a health endpoint meets the contract, whatever model it's actually running. |

**Kokoro.** [hexgrad/Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M), 82M parameters, built on StyleTTS 2 with an ISTFTNet vocoder. Covered in the [Quick start](#quick-start) above.

**NeuTTS Air.** `requirements.txt` covers the adapter's own dependencies; NeuTTS itself is installed per [neuphonic/neutts](https://github.com/neuphonic/neutts) upstream instructions, editable from source — see that project's own docs for CPU/CUDA/ROCm setup.

**Voxtral.** Not set up in this repo — listed for reference. `mlx-audio` can serve its MLX weights (`mlx-community/Voxtral-4B-TTS-2603-mlx-6bit` and siblings) if you want to try it. Apple Silicon only.

**Pocket TTS.** [kyutai-labs](https://github.com/kyutai-labs/pocket-tts), CPU-first by design — the official package doesn't require a GPU build of PyTorch. Its own `serve` command exposes a web interface, not an OpenAI-compatible API, so it needs a server in front: this repo's `fluid-tts` (Apple Silicon, CoreML — see [`services/fluid`](../services/fluid)), `mlx-audio` (Apple Silicon), a third-party OpenAI-compatible wrapper mentioned in the project's README, or an adapter you write yourself.

**OmniVoice.** [k2-fsa](https://github.com/k2-fsa/OmniVoice), built on the Qwen3-0.6B architecture, PyTorch. Ships no server of its own, and this repo has no adapter for it — an experimental MLX conversion and runtime exist ([mlx-community/OmniVoice](https://huggingface.co/mlx-community/OmniVoice), [ailuntx/OmniVoice-MLX](https://github.com/ailuntx/OmniVoice-MLX)), but the runtime has no HTTP server either, so either path needs adapter code written before Banter can use it.

**Anything OpenAI-compatible.** The TTS contract is `POST /v1/audio/speech`, `POST /v1/models?model_name=<id>` and a health endpoint — see [speech-server-api.md](speech-server-api.md). A server meeting that can be registered without any adapter code here, subject to the same CORS caveat as speech-to-text, below.

---

## Speech-to-text models recommended

One row per model, each with more than one server option. For registry/config snippets to actually set one of these up, see [stt-setup.md](stt-setup.md).

| Model | Platform | Served via | Notes |
|---|---|---|---|
| [Parakeet](https://huggingface.co/mlx-community/parakeet-tdt-0.6b-v3) | `parakeet-mlx-fastapi` is Apple Silicon (MLX); `fluid-stt` is Apple Silicon (CoreML); Linux options exist but need an adapter — see [docs/linux-speech-servers.md](linux-speech-servers.md) | third-party ([`parakeet-mlx-fastapi`](https://pypi.org/project/parakeet-mlx-fastapi/)) or this repo's adapter (`fluid-stt`, in [`services/fluid`](../services/fluid)) | 0.6B parameters, FastConformer/Conformer architecture. 25 languages. `fluid-stt` also offers streaming variants (Parakeet Unified, Nemotron) — see [`services/fluid`](../services/fluid/README.md). |
| [Whisper](https://huggingface.co/openai/whisper-large-v3-turbo) | `stt/whisper` is Apple Silicon (MLX); faster-whisper and whisper.cpp run on Linux too | this repo's adapter ([`stt/whisper`](../services/stt/whisper)), faster-whisper, or whisper.cpp | 809M parameters (large-v3-turbo). 99 languages. A pruned variant of large-v3 — fewer decoder layers, faster inference, slight accuracy loss. |
| Anything OpenAI-compatible | whatever the server runs on | either | Any server that exposes `POST /v1/audio/transcriptions` plus a health endpoint meets the contract, whatever model it's actually running. |

**Parakeet.** Two ways to run it on Apple Silicon — `parakeet-mlx-fastapi` (third-party, pip, MLX; the Quick Start's pip alternative) or `fluid-stt` (this repo's adapter, the default in the shipped registry examples; build with `scripts/fluid-build.sh`, see [`services/fluid`](../services/fluid/README.md)). The latter runs [FluidInference's CoreML build](https://github.com/FluidInference/FluidAudio), targeting the Apple Neural Engine rather than MLX's GPU path, and also serves Parakeet Unified and Nemotron's streaming variants alongside the batch model. For Linux, see [docs/linux-speech-servers.md](linux-speech-servers.md).

**Whisper.** [openai/whisper-large-v3-turbo](https://huggingface.co/openai/whisper-large-v3-turbo) is the checkpoint `stt/whisper` (this repo's adapter, built on `mlx-whisper`, Apple Silicon only) defaults to. Choose a different Whisper checkpoint with `--model` to trade accuracy for speed and memory.

Two other runtimes can serve the same model, neither this repo's code nor `mlx-whisper`, and both run on Linux:

- **faster-whisper**, built on CTranslate2 — CPU or CUDA, not GPU-only. Has no server of its own; several projects wrap it in an OpenAI-compatible one: [fedirz/faster-whisper-server](https://github.com/fedirz/faster-whisper-server), [hwdsl2/docker-whisper](https://github.com/hwdsl2/docker-whisper) (Docker, CUDA, multi-arch), [hwdsl2/whisper-install](https://github.com/hwdsl2/whisper-install) (installer for Debian/Ubuntu/RHEL family).
- **[whisper.cpp](https://github.com/ggml-org/whisper.cpp)**, a dependency-free C/C++ port — Mac, Linux, Windows, mobile, and more, with Metal/CUDA/ROCm/Vulkan acceleration depending on platform. Ships its own [`whisper-server` example](https://github.com/ggml-org/whisper.cpp/tree/master/examples/server) with an OpenAI-like transcription API.

**Anything OpenAI-compatible.** The STT contract is `POST /audio/transcriptions` and a health endpoint — see [speech-server-api.md](speech-server-api.md). The browser calls this server directly, so its CORS allowlist must include wherever you reach the dashboard (e.g. `http://localhost:4200`) — `stt/whisper`, `fluid-stt`, and `parakeet-mlx-fastapi` each take this as an env var: `WHISPER_CORS_ORIGINS`, `FLUID_CORS_ORIGINS`, `PARAKEET_CORS_ORIGINS`.

---

## Getting the models

How a model reaches disk depends on the adapter — check each one's own instructions rather than assume. The Python adapters (`tts/kokoro`, `tts/neutts-air`, `stt/whisper`) fetch from Hugging Face on first run, into `~/.cache/huggingface`; `mlx-audio` does the same for its models; `services/fluid` (`fluid-stt`, `fluid-tts`) has its own model-loading path, downloading each model on its first load — see [`services/fluid`](../services/fluid/README.md). Either way, the first start after installing an adapter is typically slow and needs network, and every start afterwards is neither.

Two consequences worth knowing for the Hugging Face–backed adapters specifically:

- A demand-loaded service will appear to hang on its very first start while a multi-gigabyte download runs. Start it once by hand before relying on it.
- The cache is shared with everything else on the machine that uses Hugging Face, so a model may already be present.

To pre-fetch without starting a service, run the adapter once directly — the `runner.main` line from your registry works fine from a shell. [tts-setup.md](tts-setup.md) and [stt-setup.md](stt-setup.md) have that line, with the right model ID already filled in, for every model on this page.
