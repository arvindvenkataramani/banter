# Speech servers on Linux

This repo ships two adapters that run on Linux as they do on macOS: `stt/faster-whisper` and `tts/kokoro`. The [fluid servers](../../services/fluid/README.md) are Apple Silicon only (a Swift package targeting macOS 15+, built with `scripts/fluid-build.sh`), so a Linux install uses the adapters here or another server. This page covers the roster entry that makes a server usable, and servers known to run on Linux.

## The contract

Any server Banter talks to has to answer the routes in [speech-server-api.md](../speech-server-api.md): batch transcription or synthesis, `POST /v1/models?model_name=<id>` for TTS, a health path, and CORS. The streaming socket and the STT load calls are optional; leave `voice.stt.model` unset and the dashboard transcribes in batch without them.

## The roster entry that makes it visible

A registered service with none of this still won't show up as a selectable voice or model: `voice.tts.selection` and `voice.stt` name roster ids, and the roster is what declares which ones exist. See [voices-and-models.md](voices-and-models.md) for what a provider, model, and voice are, and [voices-and-models.md#adding-another-model-or-another-speech-server](voices-and-models.md#adding-another-model-or-another-speech-server) for the exact registry + roster shape to add one.

## Servers known to run on Linux

### faster-whisper (STT), this repo's adapter

[`stt/faster-whisper`](../../services/stt/faster-whisper/README.md) runs [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (CTranslate2) on CPU or an NVIDIA GPU. It is batch only, so leave `voice.stt.model` unset. An NVIDIA GPU also needs the CUDA 12 cuBLAS and cuDNN 9 libraries, which `pip` does not install; the adapter's README covers it. See [stt.md](stt.md#faster-whisper) for the registry snippet.

### Kokoro (TTS), this repo's adapter

[`tts/kokoro`](../../services/tts/kokoro) has no MLX or CUDA-specific dependency (`kokoro`, `fastapi`, `uvicorn`) and runs the same way on Linux as on macOS. Set up in [tts.md](tts.md#kokoro).

### NeuTTS Air (TTS), this repo's adapter

[`tts/neutts-air`](../../services/tts/neutts-air) wraps [neuphonic/neutts](https://github.com/neuphonic/neutts), which runs on CPU, CUDA, or ROCm (its own docs cover OpenBLAS on Linux CPU and ROCm/CUDA builds) — nothing here is MLX-specific. See [tts.md](tts.md#neutts-air) for the registry/config snippet.

### sherpa-onnx (STT and TTS) — Parakeet, Nemotron and Kokoro on CPU, needs an HTTP layer

[k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) is a speech inference toolkit built on ONNX Runtime, not an OpenAI-compatible HTTP server by itself — it ships WebSocket servers and bindings for a dozen languages, none in the shape Banter's dashboard calls. It runs on Linux, macOS and Windows (x64 and ARM, down to a Raspberry Pi), on CPU by default. It's the one to look at if you want a single lightweight runtime for both directions on a Linux or CPU-only machine, with no PyTorch dependency. Models are prebuilt packages on its [`asr-models`](https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models) and [`tts-models`](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models) release pages.

On the STT side, the models worth knowing about here:

- **Parakeet TDT**, batch — `sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8` (multilingual) and `-v2-int8` (English).
- **Parakeet Unified**, batch or streaming — `sherpa-onnx-nemo-parakeet-unified-en-0.6b-int8-non-streaming`, plus streaming packages at 240, 560 and 1120 ms chunks (`…-int8-streaming-560ms` and siblings). Streaming arrived in sherpa-onnx 1.13.2 ([#3575](https://github.com/k2-fsa/sherpa-onnx/pull/3575)).
- **Nemotron**, streaming — `sherpa-onnx-nemotron-speech-streaming-en-0.6b-*` and the newer `sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-*`, each at chunk sizes from 80 to 1120 ms.

On the TTS side it runs Kokoro (`kokoro-en-v0_19` English; `kokoro-multi-lang-v1_0` and `-v1_1` Chinese and English, with int8 builds), Piper/VITS voices, Matcha, KittenTTS, Pocket TTS and ZipVoice. For Kokoro on Linux that's a lighter CPU route than this repo's PyTorch-based adapter.

Using any of these with Banter means writing (or finding) an adapter that puts the contract above in front of sherpa-onnx's own API — this repo has none. [`achetronic/parakeet`](https://github.com/achetronic/parakeet) is a separate, already-OpenAI-compatible option worth checking if you specifically want Parakeet TDT: it's built directly on ONNX Runtime (not sherpa-onnx), advertises a drop-in `/v1/audio/transcriptions` endpoint including streaming, and is written in Go with no Python dependency. It has not been used with Banter; verify it meets the contract above (multipart `file` field, health path, CORS) before relying on it.

### Speaches (STT and TTS)

[speaches-ai/speaches](https://github.com/speaches-ai/speaches) (also known as `fedirz/faster-whisper-server`) describes itself as an OpenAI API-compatible server for streaming transcription and speech generation — STT via faster-whisper, TTS via Kokoro or Piper — with Docker-based CPU and GPU support and no MLX dependency. Its own docs are the source for exact endpoint and model-loading behavior; confirm it against the contract above (particularly the `/v1/models` load/unload calls) before registering it.

### Other faster-whisper servers (STT)

Speaches above is one project that wraps [faster-whisper](https://github.com/SYSTRAN/faster-whisper); [models.md](models.md#speech-to-text-models) lists others. This repo's own faster-whisper adapter is above.

### whisper.cpp (STT)

[ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp), a dependency-free C/C++ port with Metal/CUDA/ROCm/Vulkan acceleration depending on platform, runs on Linux and ships its own [`whisper-server` example](https://github.com/ggml-org/whisper.cpp/tree/master/examples/server) with an OpenAI-like transcription API. Confirm it against the contract above before registering it.
