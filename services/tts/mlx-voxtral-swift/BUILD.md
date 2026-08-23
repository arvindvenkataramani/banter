# mlx-voxtral-swift (tts-voxtral)

> About this document: build instructions for the `tts-voxtral` service, an OpenAI-compatible TTS server built on top of a vendored upstream Swift package. This directory holds only our additions (source + patch + build script), not a full copy of the upstream repo.

## Upstream

- Repo: [VincentGourbin/mlx-voxtral-swift](https://github.com/VincentGourbin/mlx-voxtral-swift)
- License: MIT
- Pinned commit: `2c71183912182a567124358cbd0eae872ad7a1e1`

## What's ours

- `Sources/VoxtralHTTPServer/VoxtralHTTPServer.swift` — Hummingbird-based HTTP server wrapping upstream's `VoxtralTTSPipeline`, exposing an OpenAI-compatible `/v1/audio/speech` endpoint. Not part of upstream.
- `upstream.patch` — extends upstream's `Package.swift` to add the `VoxtralHTTPServer` executable target and its dependencies (Hummingbird), plus a small API-compat fix in `Sources/VoxtralCore/TTS/Pipeline/VoxtralTTSPipeline.swift` (upstream's `model.generate` now returns a 3-tuple instead of 2).
- `build.sh` — builds the `VoxtralHTTPServer` scheme via `xcodebuild` and stages the binary + MLX Metal shader bundle into `bin/`.

## Build steps

```bash
git clone https://github.com/VincentGourbin/mlx-voxtral-swift.git
cd mlx-voxtral-swift
git checkout 2c71183912182a567124358cbd0eae872ad7a1e1

git apply /path/to/this/upstream.patch
cp -R /path/to/this/Sources/VoxtralHTTPServer Sources/VoxtralHTTPServer
cp /path/to/this/build.sh build.sh

./build.sh
# binary + Metal shader bundle staged at bin/
```

## Running

```bash
./bin/VoxtralHTTPServer --model tts-4b-6bit --host 127.0.0.1 --port 8003
```

`--model` accepts any model ID registered in `VoxtralTTSRegistry` (e.g. `tts-4b-4bit`, `tts-4b-6bit`, `tts-4b-mlx`).

## API surface

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | `{"status":"ok"}` |
| POST | `/v1/audio/speech` | body `{input, voice}`; `voice` maps to `VoxtralVoice`, defaults to `.neutralFemale`; returns WAV |
