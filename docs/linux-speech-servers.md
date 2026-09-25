# Speech servers on Linux

The fluid servers (`services/fluid`) are Apple Silicon only — a Swift package targeting macOS 15+, built with `scripts/fluid-build.sh`. On Linux, connect a different server. This page covers the contract it needs to meet, the roster entry that makes it usable, and servers known to run on Linux.

## The contract

Taken from what the dashboard actually calls, not a general OpenAI-API description:

- **Batch transcription** — `POST {endpoint}/audio/transcriptions`, multipart with a `file` field carrying WAV audio ([`dashboard/src/lib/voice/human/stt-client.ts`](../dashboard/src/lib/voice/human/stt-client.ts)). `fluid-stt` and `stt/whisper` also answer the same route under `/v1/audio/transcriptions`; the dashboard uses the bare path.
- **Synthesis** — `POST {endpoint}/v1/audio/speech`, JSON body `{ model, input, voice, speed, stream, response_format, ...extra }` ([`dashboard/src/lib/voice/system/playback-engine.ts`](../dashboard/src/lib/voice/system/playback-engine.ts)). `response_format` comes from the roster's `responseFormat` for that provider (`mp3` if absent) — the dashboard requests that format and decodes the response as it, so the two have to agree with what the server actually returns.
- **TTS model load** — `POST {endpoint}/v1/models?model_name=<id>`, called once when a voice session starts, before the first synthesis request ([`dashboard/src/lib/voice/system/voice-system.ts`](../dashboard/src/lib/voice/system/voice-system.ts) calling [`voice-service.ts`](../dashboard/src/lib/voice/voice-service.ts)). Kokoro and NeuTTS Air (this repo's two Python TTS adapters) implement it; `tts/mlx-voxtral-swift` does not — it has no `/v1/models` route at all. A voice session's start-up call to it fails (unlike `DELETE`, this one isn't swallowed), which fails the whole session start with a "Voice failed to start" notice — worth knowing if you're adapting that server's registry entry rather than a Linux-specific one. `DELETE {endpoint}/v1/models?model_name=<id>` unloads a model, but only when you change the selected model in the dashboard's settings dialog, not automatically at session end — and its failure is swallowed rather than surfaced, so a server without `DELETE` still works, it just never gets told to release the old model.
- **STT model load, and the streaming socket, only if you set `voice.stt.model`.** Leaving it unset skips both entirely — the dashboard falls back to plain batch transcription (the `/audio/transcriptions` call above) and never calls `/v1/models/load` or opens the socket. This is the simplest way to use a server that has neither. If you do set `voice.stt.model`: `POST {endpoint}/v1/models/load` with `{ model, mode?, chunkMs? }` loads it before the first utterance, and `WS {endpoint}/v1/audio/stream?model=<id>&format=<fmt>[&session=<id>][&takeover=1]` is used when the roster model's `kind` is `"streaming"` or `"both"` and streaming is preferred. See [`services/fluid/STT.md`](../services/fluid/STT.md) for the socket's frame protocol — it's `fluid-stt`'s own documentation, but the contract in it is what any streaming-capable server has to speak, since that's what `stt-socket.ts` sends.
- **A health path** answering 2xx when ready — whatever you register in `network.healthPath`.
- **CORS.** The browser calls these servers directly, so each one's CORS configuration must allow the dashboard's origin, or requests are refused with no explanation the browser will show you.

None of this requires a specific model or runtime — only these routes, in this shape. The simplest usable server implements batch transcription, `POST /v1/audio/speech`, `POST /v1/models` for TTS, a health path, and CORS — nothing streaming-specific required.

## The roster entry that makes it visible

A registered service with none of this still won't show up as a selectable voice or model: `voice.tts.selection` and `voice.stt` name roster ids, and the roster is what declares which ones exist. See [docs/voices-and-models.md](voices-and-models.md) for what a provider, model, and voice are, and [docs/voices-and-models.md#adding-another-model-or-another-speech-server](voices-and-models.md#adding-another-model-or-another-speech-server) for the exact registry + roster shape to add one.

## Servers known to run on Linux

### Kokoro (TTS) — this repo's adapter

[`tts/kokoro`](../services/tts/kokoro) has no MLX or CUDA-specific dependency (`kokoro`, `fastapi`, `uvicorn`) and runs the same way on Linux as on macOS. Already covered in [docs/models.md](models.md#quick-start) and [docs/tts-setup.md](tts-setup.md).

### NeuTTS Air (TTS) — this repo's adapter

[`tts/neutts-air`](../services/tts/neutts-air) wraps [neuphonic/neutts](https://github.com/neuphonic/neutts), which runs on CPU, CUDA, or ROCm (its own docs cover OpenBLAS on Linux CPU and ROCm/CUDA builds) — nothing here is MLX-specific. See [docs/tts-setup.md](tts-setup.md#neutts-air) for the registry/config snippet.

### sherpa-onnx (STT) — Parakeet TDT and Nemotron, needs an HTTP layer

[k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) is a speech toolkit, not an OpenAI-compatible HTTP server by itself — it ships WebSocket/gRPC servers and language bindings, none in the shape Banter's dashboard calls. It does support the models worth knowing about here:

- **Parakeet TDT v3**, non-streaming — `sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8` and similar exports are in its supported model list.
- **Parakeet Unified**, batch only — sherpa-onnx runs `nvidia/parakeet-unified-en-0.6b` in non-streaming mode; true streaming for it is an open feature request ([#3573](https://github.com/k2-fsa/sherpa-onnx/issues/3573)), not yet supported.
- **Nemotron**, streaming — `nemotron-speech-streaming-en-0.6b` is a supported streaming model (sherpa-onnx 1.13.4+), decoding with `model_type="nemotron"`.

Using any of these with Banter means writing (or finding) an adapter that puts the contract above in front of sherpa-onnx's own API — this repo has none. [`achetronic/parakeet`](https://github.com/achetronic/parakeet) is a separate, already-OpenAI-compatible option worth checking if you specifically want Parakeet TDT: it's built directly on ONNX Runtime (not sherpa-onnx), advertises a drop-in `/v1/audio/transcriptions` endpoint including streaming, and is written in Go with no Python dependency. It has not been used with Banter; verify it meets the contract above (multipart `file` field, health path, CORS) before relying on it.

### Speaches (STT and TTS)

[speaches-ai/speaches](https://github.com/speaches-ai/speaches) (formerly `fedirz/faster-whisper-server`, which now redirects there) describes itself as an OpenAI API-compatible server for streaming transcription and speech generation — STT via faster-whisper, TTS via Kokoro or Piper — with Docker-based CPU and GPU support and no MLX dependency. Its own docs are the source for exact endpoint and model-loading behavior; confirm it against the contract above (particularly the `/v1/models` load/unload calls) before registering it.

### faster-whisper servers (STT)

[faster-whisper](https://github.com/SYSTRAN/faster-whisper) (CTranslate2, CPU or CUDA) has no server of its own; Speaches above is one wrapper. [models.md](models.md#speech-to-text-models-recommended) lists it and other wrappers.

### whisper.cpp (STT)

[ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp), a dependency-free C/C++ port with Metal/CUDA/ROCm/Vulkan acceleration depending on platform, runs on Linux and ships its own [`whisper-server` example](https://github.com/ggml-org/whisper.cpp/tree/master/examples/server) with an OpenAI-like transcription API. Confirm it against the contract above before registering it.
