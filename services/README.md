# services/

For **which** models to run and what each one needs, see [docs/models.md](../docs/models.md). This page is about the adapter code.

Adapter code and install docs for the STT/TTS model servers this repo is built around. The platform doesn't install or manage these for you — it starts them (once you've installed them yourself) via each service's `runner` entry in your `registry.json`, health-gates them on `network.healthPath`, and exposes them to the browser via `tailscale serve`.

Two kinds of entries here:

- **Ours** — adapter server code we wrote, committed so you don't have to re-solve OpenAI-API-compatibility from scratch. Python adapters ship the full server; the Swift adapters ship only our diff against a pinned upstream commit (see each `BUILD.md`) — you build them yourself, this repo never runs `swift build` for you.
- **Third-party, pip-installable** — servers we don't vendor at all, just document how to wire in.

## Ours

| Service | Capability | Endpoints | Install |
|---|---|---|---|
| `stt/whisper` | STT | `GET /healthz`, `POST /audio/transcriptions`, `POST /v1/audio/transcriptions` | `python -m venv .venv && .venv/bin/pip install -r requirements.txt` |
| `tts/kokoro` | TTS | `GET /health`, `POST /v1/audio/speech` | `python -m venv .venv && .venv/bin/pip install -r requirements.txt` |
| `tts/neutts-air` | TTS | `GET /health`, `POST /v1/models`, `DELETE /v1/models`, `POST /v1/audio/speech` | `python -m venv .venv && .venv/bin/pip install -r requirements.txt`, then install NeuTTS itself per [neuphonic/neutts](https://github.com/neuphonic/neutts) upstream instructions — it's editable-installed from source, not on PyPI, so there's no pip name to add to `requirements.txt` |
| `stt/fluid-audio` | STT | `GET /healthz`, `POST /audio/transcriptions`, `POST /v1/audio/transcriptions`; optional CORS via `FLUID_CORS_ORIGINS` | Swift — see `BUILD.md` |
| `tts/mlx-voxtral-swift` | TTS | `GET /health`, `POST /v1/audio/speech` | Swift — see `BUILD.md` |

Registry `runner.main` examples (Python adapters run under a venv's interpreter directly; ports are whatever you choose — these match each server's own default):

```
.venv/bin/uvicorn server:app --host 127.0.0.1 --port 8002          # kokoro
.venv/bin/uvicorn server:app --host 127.0.0.1 --port 8004          # neutts-air
.venv/bin/python server.py --model mlx-community/whisper-large-v3-turbo --port 8766   # whisper
```

For the Swift adapters, build first per each `BUILD.md` — clone the pinned upstream commit, `git apply upstream.patch`, copy in our `Sources/` addition, then `swift build -c release` (fluid-audio) or the packaged `build.sh` (mlx-voxtral-swift). The resulting binary's own `--host`/`--port` flags become the registry `runner.main` line, e.g.:

```
.build/release/fluidserver --model-version v3 --port 8767 --host 127.0.0.1        # fluid-audio
./bin/VoxtralHTTPServer --model tts-4b-6bit --host 127.0.0.1 --port 8003          # mlx-voxtral-swift
```

## Third-party, pip-installable

Not vendored here — install the package, point a registry `runner.main` at its own CLI/ASGI entry point.

| Service | Package | Notes |
|---|---|---|
| Parakeet (STT) | [`parakeet-mlx-fastapi`](https://pypi.org/project/parakeet-mlx-fastapi/) | Pip-installable, MLX. |
| mlx-audio (TTS) | `mlx-audio`, run via `mlx_audio.server:app` | See the `mlx-audio` project's own docs for CLI flags. |
