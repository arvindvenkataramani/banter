# Choosing speech models

Which speech-to-text and text-to-speech models to run, and what each one needs. For ready-to-copy registry/config snippets once you've chosen, see [tts-setup.md](tts-setup.md) and [stt-setup.md](stt-setup.md); for what those registry fields mean in general, see [configuration.md](configuration.md); for the adapter code itself, see [../services/README.md](../services/README.md).

Neither the model nor the framework matters to Banter. Any server is usable if it:

1. serves the OpenAI-shaped endpoint for its kind — `/v1/audio/transcriptions` for STT, `/v1/audio/speech` for TTS;
2. answers a health path with a 2xx when ready; and
3. permits the dashboard's origin in its CORS configuration.

Anything satisfying that can be registered, health-checked, and demand-started the same as the servers in `services/`.

## Quick start: Kokoro and Parakeet

The fastest way to a working install, on Apple Silicon and Linux. Both install with pip, both download their own models on first run, and neither needs a compile step. See [Text-to-speech](#text-to-speech) and [Speech-to-text](#speech-to-text) below for what else is available and why you might pick something else.

Both sections end with a service entry to add to `registry.json` and start once by hand — `loadStrategy: "demand"` means Banter starts it on first use and unloads it after thirty minutes idle; set `"autoStart": true` instead if you would rather it came up with the control plane.

### Kokoro (TTS)

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

Then add this to `config.json`'s `voice.tts` block — `config.example.json` already carries exactly this, so this half is done if you copied it:

```json
"voice": {
  "tts": {
    "providers": [
      {
        "serviceId": "tts-kokoro",
        "name": "Kokoro",
        "models": [
          { "id": "hexgrad/Kokoro-82M", "name": "Kokoro", "voices": [{ "id": "af_heart", "name": "Heart" }] }
        ]
      }
    ],
    "selection": { "serviceId": "tts-kokoro", "model": "hexgrad/Kokoro-82M", "voice": "af_heart" }
  }
}
```

The `providers` list is what the settings dialog offers; a model missing from it cannot be selected, however well the server runs.

Start it once by hand before relying on demand-loading, so the first-run model download happens where you can see it:

```bash
cd ~/services/tts/kokoro && .venv/bin/uvicorn server:app --port 8002
```

### Parakeet (STT)

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

| Model | Served via | Notes |
|---|---|---|
| [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) | this repo's adapter ([`tts/kokoro`](../services/tts/kokoro)) | 82M parameters, small by current TTS standards. Preset voices only, no cloning. |
| [NeuTTS Air](https://huggingface.co/neuphonic/neutts-air) | this repo's adapter ([`tts/neutts-air`](../services/tts/neutts-air)) | 0.7B parameters. Voice cloning from a few seconds of reference audio. Output length for identical input text can vary run to run, and quality degrades on longer passages — sentence-level chunking helps. |
| [Voxtral](https://huggingface.co/mistralai/Voxtral-4B-TTS-2603) | this repo's adapter ([`tts/mlx-voxtral-swift`](../services/tts/mlx-voxtral-swift)) | 4B parameters. 20 preset voices across 9 languages, with voice cloning from a reference sample. Ships in several quantizations (4-bit through bf16); the 6-bit build is the pick for realtime use — full bf16 is too slow for a voice conversation. |
| [Pocket TTS](https://huggingface.co/kyutai/pocket-tts) | `mlx-audio`, or a third-party OpenAI-compatible wrapper | 100M parameters, ~30MB weights. Voice cloning from a few seconds of reference audio, plus a handful of preset voices. Sub-50ms first-chunk latency. |
| [OmniVoice](https://huggingface.co/k2-fsa/OmniVoice) | needs an adapter — none in this repo | Voice cloning and voice design (describe a voice by attributes like gender, age, or accent) across 600+ languages. Reference usage returns a complete audio array rather than a stream. |
| Anything OpenAI-compatible | either | Any server that exposes `POST /v1/audio/speech` plus a health endpoint meets the contract, whatever model it's actually running. |

**Kokoro.** [hexgrad/Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M), 82M parameters, built on StyleTTS 2 with an ISTFTNet vocoder. Covered in the [Quick start](#quick-start-kokoro-and-parakeet) above.

**NeuTTS Air.** See its `BUILD.md` for the editable-install step NeuTTS itself requires beyond `requirements.txt`.

**Voxtral.** This repo's adapter is a Swift build against MLX — see its `BUILD.md`, including which quantized variant to pass as `--model`.

**Pocket TTS.** [kyutai-labs](https://github.com/kyutai-labs/pocket-tts), CPU-first by design — the official package doesn't require a GPU build of PyTorch. Its own `serve` command exposes a web interface, not an OpenAI-compatible API, so it needs one of: `mlx-audio` (Apple Silicon), a third-party OpenAI-compatible wrapper mentioned in the project's README, or an adapter you write yourself.

**OmniVoice.** [k2-fsa](https://github.com/k2-fsa/OmniVoice), built on the Qwen3-0.6B architecture, PyTorch. Ships no server of its own, and this repo has no adapter for it — an experimental MLX conversion and runtime exist ([mlx-community/OmniVoice](https://huggingface.co/mlx-community/OmniVoice), [ailuntx/OmniVoice-MLX](https://github.com/ailuntx/OmniVoice-MLX)), but the runtime has no HTTP server either, so either path needs adapter code written before Banter can use it.

**Anything OpenAI-compatible.** The TTS contract is `POST /v1/audio/speech` plus a health endpoint. A server meeting that can be registered without any adapter code here, subject to the same CORS caveat as speech-to-text, below.

---

## Speech-to-text models recommended

One row per model, each with more than one server option. For registry/config snippets to actually set one of these up, see [stt-setup.md](stt-setup.md).

| Model | Served via | Notes |
|---|---|---|
| [Parakeet TDT](https://huggingface.co/mlx-community/parakeet-tdt-0.6b-v3) | third-party ([`parakeet-mlx-fastapi`](https://pypi.org/project/parakeet-mlx-fastapi/)) or this repo's adapter ([`stt/fluid-audio`](../services/stt/fluid-audio)) | 0.6B parameters, FastConformer/Conformer architecture. 25 languages. |
| [Whisper](https://huggingface.co/openai/whisper-large-v3-turbo) | this repo's adapter ([`stt/whisper`](../services/stt/whisper)), faster-whisper, or whisper.cpp | 809M parameters (large-v3-turbo). 99 languages. A pruned variant of large-v3 — fewer decoder layers, faster inference, slight accuracy loss. |
| Anything OpenAI-compatible | either | Any server that exposes `POST /v1/audio/transcriptions` plus a health endpoint meets the contract, whatever model it's actually running. |

**Parakeet TDT.** Two ways to run the same underlying model — `parakeet-mlx-fastapi` (third-party, pip, MLX; the Quick Start's default) or `stt/fluid-audio` (this repo's adapter, a patch against a pinned upstream commit — see its `BUILD.md`). The latter runs [FluidInference's CoreML build](https://github.com/FluidInference/FluidAudio), targeting the Apple Neural Engine rather than MLX's GPU path.

**Whisper.** [openai/whisper-large-v3-turbo](https://huggingface.co/openai/whisper-large-v3-turbo) is the checkpoint `stt/whisper` defaults to — this repo's adapter around `mlx-whisper`. Choose a different Whisper checkpoint with `--model` to trade accuracy for speed and memory.

Two other runtimes can serve the same model, neither this repo's code nor `mlx-whisper`:

- **faster-whisper**, built on CTranslate2 — CPU or CUDA, not GPU-only. Has no server of its own; several projects wrap it in an OpenAI-compatible one: [fedirz/faster-whisper-server](https://github.com/fedirz/faster-whisper-server), [hwdsl2/docker-whisper](https://github.com/hwdsl2/docker-whisper) (Docker, CUDA, multi-arch), [hwdsl2/whisper-install](https://github.com/hwdsl2/whisper-install) (installer for Debian/Ubuntu/RHEL family).
- **[whisper.cpp](https://github.com/ggml-org/whisper.cpp)**, a dependency-free C/C++ port — Mac, Linux, Windows, mobile, and more, with Metal/CUDA/ROCm/Vulkan acceleration depending on platform. Ships its own [`whisper-server` example](https://github.com/ggml-org/whisper.cpp/tree/master/examples/server) with an OpenAI-like transcription API.

**Anything OpenAI-compatible.** The STT contract is `POST /v1/audio/transcriptions` and a health endpoint. The browser calls this server directly, so its CORS allowlist must include wherever you reach the dashboard (e.g. `http://localhost:4200`) — `stt/whisper`, `stt/fluid-audio`, and `parakeet-mlx-fastapi` each take this as an env var: `WHISPER_CORS_ORIGINS`, `FLUID_CORS_ORIGINS`, `PARAKEET_CORS_ORIGINS`.

---

## Getting the models

How a model reaches disk depends on the adapter — check each one's own instructions rather than assume. The Python adapters (`tts/kokoro`, `tts/neutts-air`, `stt/whisper`) fetch from Hugging Face on first run, into `~/.cache/huggingface`; the Swift ones have their own model-loading path — see each `BUILD.md`. Either way, the first start after installing an adapter is typically slow and needs network, and every start afterwards is neither.

Two consequences worth knowing for the Hugging Face–backed adapters specifically:

- A demand-loaded service will appear to hang on its very first start while a multi-gigabyte download runs. Start it once by hand before relying on it.
- The cache is shared with everything else on the machine that uses Hugging Face, so a model may already be present.

To pre-fetch without starting a service, run the adapter once directly — the `runner.main` line from your registry works fine from a shell. [tts-setup.md](tts-setup.md) and [stt-setup.md](stt-setup.md) have that line, with the right model ID already filled in, for every model on this page.
