# services/

For **which** models to run and what each one needs, see [docs/models.md](../docs/models.md). This page is about the adapter code.

Adapter code and install docs for the STT/TTS model servers this repo is built around. The platform doesn't install or manage these for you — it starts them (once you've installed them yourself) via each service's `runner` entry in your `registry.json`, health-gates them on `network.healthPath`, and exposes them to the browser via `tailscale serve`.

Two kinds of entries here:

- **Ours** — adapter server code we wrote, committed so you don't have to re-solve OpenAI-API-compatibility from scratch. Python adapters ship the full server; `services/fluid` is Swift and you build it yourself: a full Swift package, built with `scripts/fluid-build.sh` rather than a `BUILD.md`, documented in [`services/fluid/README.md`](fluid/README.md) and, for the vendored FluidAudio patches it pins, [`services/fluid/patches/README.md`](fluid/patches/README.md).
- **Third-party, pip-installable** — servers we don't vendor at all, just document how to wire in.

## Ours

| Service | Capability | Endpoints | Install |
|---|---|---|---|
| `stt/whisper` | STT | `GET /healthz`, `POST /audio/transcriptions`, `POST /v1/audio/transcriptions` | `python -m venv .venv && .venv/bin/pip install -r requirements.txt` |
| `tts/kokoro` | TTS | `GET /health`, `POST /v1/models`, `DELETE /v1/models`, `POST /v1/audio/speech` | `python -m venv .venv && .venv/bin/pip install -r requirements.txt` |
| `tts/neutts-air` | TTS | `GET /health`, `POST /v1/models`, `DELETE /v1/models`, `POST /v1/audio/speech` | `python -m venv .venv && .venv/bin/pip install -r requirements.txt`, then install NeuTTS itself from the patched clone described in [`tts/neutts-air/README.md`](tts/neutts-air/README.md) — it's editable-installed from source, not on PyPI, so there's no pip name to add to `requirements.txt` |
| `fluid` (`fluid-stt`) | STT | `GET /healthz`, `POST /audio/transcriptions`, `POST /v1/audio/transcriptions`, `WS /v1/audio/stream`; optional CORS via `FLUID_CORS_ORIGINS` | Swift — `scripts/fluid-build.sh` |
| `fluid` (`fluid-tts`) | TTS | `GET /healthz`, `POST /v1/audio/speech`, `WS /v1/audio/stream`; optional CORS via `FLUID_CORS_ORIGINS` | Swift — `scripts/fluid-build.sh` |

Registry `runner.main` examples (Python adapters run under a venv's interpreter directly; the port is written only in `network.port` and reaches the command through `{port}`):

```
.venv/bin/uvicorn server:app --host 127.0.0.1 --port {port}          # kokoro
.venv/bin/uvicorn server:app --host 127.0.0.1 --port {port}          # neutts-air
.venv/bin/python server.py --model mlx-community/whisper-large-v3-turbo --port {port}   # whisper
```

`services/fluid` builds with `scripts/fluid-build.sh`, which produces both `fluid-stt.app` and `fluid-tts.app` from the one package at `services/fluid/.build/release/`. Each takes `--registry <path> --provider <id>` rather than model flags — what it serves comes from the `fluid-stt`/`fluid-tts` provider in the registry's `roster` section, not the command line (see [docs/voices-and-models.md](../docs/voices-and-models.md)). The shipped example registry runs them as:

```
fluid-stt.app/Contents/MacOS/fluid-stt --port {port} --registry ~/services/banter/control/control-plane/data/registry.json --provider fluid-stt
fluid-tts.app/Contents/MacOS/fluid-tts --port {port} --registry ~/services/banter/control/control-plane/data/registry.json --provider fluid-tts
```

## Third-party, pip-installable

Not vendored here — install the package, point a registry `runner.main` at its own CLI/ASGI entry point.

| Service | Package | Notes |
|---|---|---|
| Parakeet (STT) | [`parakeet-mlx-fastapi`](https://pypi.org/project/parakeet-mlx-fastapi/) | Pip-installable, MLX. |
| mlx-audio (TTS) | `mlx-audio`, run via `mlx_audio.server:app` | See the `mlx-audio` project's own docs for CLI flags. |
