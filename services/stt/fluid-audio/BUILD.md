# fluid-audio (stt-fluid)

> About this document: build instructions for the `stt-fluid` service, an OpenAI-compatible transcription server built on top of a vendored upstream Swift package. This directory holds only our additions (source + patch), not a full copy of the upstream repo.

## Upstream

- Repo: [FluidInference/FluidAudio](https://github.com/FluidInference/FluidAudio)
- License: Apache-2.0
- Pinned commit: `4ef33f0b64837c2943e8cd0f66940d5861176d6a`

## What's ours

- `Sources/FluidServer/` — Hummingbird-based HTTP server exposing FluidAudio's `AsrManager` over an OpenAI-compatible `/v1/audio/transcriptions` endpoint. Not part of upstream.
- `upstream.patch` — extends upstream's `Package.swift` to add the `fluidserver` executable target and its dependencies (Hummingbird, MultipartKit).

## Build steps

```bash
git clone https://github.com/FluidInference/FluidAudio.git
cd FluidAudio
git checkout 4ef33f0b64837c2943e8cd0f66940d5861176d6a

git apply /path/to/this/upstream.patch
cp -R /path/to/this/Sources/FluidServer Sources/FluidServer

swift build -c release
# binary at .build/release/fluidserver
```

## Running

```bash
.build/release/fluidserver --model-version v3 --port 8767 --host 127.0.0.1
```

`--model-version` accepts `v2`, `v3`, or `tdt-ctc-110m`.

Optional CORS: set `FLUID_CORS_ORIGINS` (comma-separated origins) before starting.

## API surface

| Method | Path | Notes |
|---|---|---|
| GET | `/healthz` | `{"status": "ok", "model": "<version>"}` |
| POST | `/audio/transcriptions` | multipart file upload |
| POST | `/v1/audio/transcriptions` | OpenAI-compatible alias; `response_format=text` for plain text, otherwise JSON |
