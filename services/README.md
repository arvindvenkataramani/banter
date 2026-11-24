# services/

For **which** models to run and what each one needs, see [../docs/guide/models.md](../docs/guide/models.md). This page is about the adapter code.

Adapter code and install docs for the STT/TTS model servers this repo ships. Banter installs none of them, and installs no Python: each adapter's README says how to install it. Once you've installed one and registered it, the control plane starts it via the service's `runner` entry in your `registry.json` (as its `lifecycle` settings say), health-gates it on `network.healthPath`, and, if the entry sets `tailscaleServe`, exposes it to the browser via `tailscale serve`.

Two kinds of entries here:

- **Ours** — adapter server code committed so you don't have to re-solve serving the OpenAI APIs from scratch. Python adapters ship the full server, which you copy into its working directory and install into a virtual environment there; `services/fluid` is Swift and you build it yourself: a full Swift package, built with `scripts/fluid-build.sh` rather than a `BUILD.md`, documented in [`services/fluid/README.md`](fluid/README.md) and, for what to check before changing the FluidAudio release it pins, [`services/fluid/verification/README.md`](fluid/verification/README.md).
- **Third-party, pip-installable** — servers we don't vendor at all, just document how to wire in.

## Ours

| Service | Capability | APIs it provides | CORS allowlist | Install |
|---|---|---|---|---|
| `stt/faster-whisper` | STT | `openai.audio.transcriptions`; health at `GET /healthz` | `FASTER_WHISPER_CORS_ORIGINS` | [`stt/faster-whisper/README.md`](stt/faster-whisper/README.md) |
| `stt/whisper` | STT | `openai.audio.transcriptions`; health at `GET /healthz` | `WHISPER_CORS_ORIGINS` | Apple Silicon (MLX). Copy `server.py` and `requirements.txt`, then `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt` |
| `tts/kokoro` | TTS | `openai.audio.speech`; loads and unloads a model at `POST` and `DELETE /v1/models` (declared under `models`); health at `GET /health` | `KOKORO_CORS_ORIGINS` | [`tts/kokoro/README.md`](tts/kokoro/README.md) |
| `tts/neutts-air` | TTS | `openai.audio.speech`; health at `GET /health` | `NEUTTS_CORS_ORIGINS` | [`tts/neutts-air/README.md`](tts/neutts-air/README.md); NeuTTS itself is editable-installed from a patched clone, not on PyPI, so there's no pip name to add to `requirements.txt` |
| `fluid` (`fluid-stt`) | STT | `fluid.stt.stream`, `openai.audio.transcriptions`, `deepgram.listen.prerecorded`, `deepgram.listen.live`, `openai.realtime` (transcription), `triton.model-repository`; health at `GET /healthz` | `FLUID_CORS_ORIGINS` | Swift: `scripts/fluid-build.sh`; see [`fluid/README.md`](fluid/README.md) |
| `fluid` (`fluid-tts`) | TTS | `openai.audio.speech`, `deepgram.speak`, `deepgram.speak.live`, `openai.realtime` (speech), `fluid.tts.stream`, `triton.model-repository`; health at `GET /healthz` | `FLUID_CORS_ORIGINS` | Swift: `scripts/fluid-build.sh`; see [`fluid/README.md`](fluid/README.md) |

An API is named by its catalog id; the paths, and how each server departs from the published spec, are in [docs/reference/speech-server-api.md](../docs/reference/speech-server-api.md). A registry entry for any of these must declare the APIs it provides and how its models load (`provides` and `models`); the example registries and [docs/guide/stt.md](../docs/guide/stt.md) and [tts.md](../docs/guide/tts.md) show them.

Every adapter reads its allowlist as a comma-separated list of origins and sends no CORS headers when it is unset, so the browser refuses every call. Set it under the service's `ops.env.variables` to the origins you open Banter from. `ops/install.sh` fills each `*_CORS_ORIGINS` variable in a fresh registry it seeds; see [docs/guide/speech-servers.md](../docs/guide/speech-servers.md#cors).

A Python adapter runs from its service's `ops.env.workingDirectory`, so the install is the same for each: create `<workingDirectory>/logs` (the control plane writes the service's output there and fails to start it otherwise), copy `server.py` and `requirements.txt` into the working directory, and create `.venv` there with `pip install -r requirements.txt`. The adapter's own README gives the exact commands and anything extra.

Registry `runner.main` forms. Python adapters run under the venv's interpreter directly; the port is written only in `network.port` and reaches the command through `{port}`:

```
.venv/bin/uvicorn server:app --host 127.0.0.1 --port {port}          # faster-whisper
.venv/bin/uvicorn server:app --host 127.0.0.1 --port {port}          # kokoro
.venv/bin/uvicorn server:app --host 127.0.0.1 --port {port}          # neutts-air
.venv/bin/python server.py --model mlx-community/whisper-large-v3-turbo --port {port}   # whisper
```

`services/fluid` builds with `scripts/fluid-build.sh`, which produces both `fluid-stt.app` and `fluid-tts.app` from the one package at `services/fluid/.build/release/`. Each takes `--registry <path> --provider <id>` rather than model flags: what it serves comes from what the `fluid-stt`/`fluid-tts` provider serves in the registry's `roster` section, not the command line (see [docs/guide/voices-and-models.md](../docs/guide/voices-and-models.md)). `services/fluid/registry.fluid.example.json` registers them as:

```
fluid-stt.app/Contents/MacOS/fluid-stt --port {port} --registry {registry} --provider fluid-stt
fluid-tts.app/Contents/MacOS/fluid-tts --port {port} --registry {registry} --provider fluid-tts
```

The example registries (`control/control-plane/data/registry.example.json` and the shard's) register `stt/faster-whisper` and `tts/kokoro` as demand-loaded process runners. Merging the fluid entries into a registry is covered in [`fluid/README.md`](fluid/README.md#registering-them).

## Third-party, pip-installable

Not vendored here — install the package, point a registry `runner.main` at its own CLI/ASGI entry point.

| Service | Package | Notes |
|---|---|---|
| Parakeet (STT) | [`parakeet-mlx-fastapi`](https://pypi.org/project/parakeet-mlx-fastapi/) | Pip-installable, MLX. |
| mlx-audio (TTS) | `mlx-audio`, run via `mlx_audio.server:app` | See the `mlx-audio` project's own docs for CLI flags. |
