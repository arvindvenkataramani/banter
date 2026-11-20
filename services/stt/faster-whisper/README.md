# faster-whisper (STT)

Batch speech-to-text with [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (CTranslate2), behind the same OpenAI-compatible routes as [`stt/whisper`](../whisper/server.py). It runs on CPU or an NVIDIA GPU, on Linux, macOS and Windows. It is the example registry's STT server. Banter does not install it: you create the environment below on the machine that runs it.

faster-whisper has no Metal backend, so on a Mac it runs on the CPU. On Apple Silicon, `stt/whisper` (MLX) or the fluid servers are faster.

## Routes

| Route | |
|---|---|
| `GET /healthz` | `{"status": "ok", "model": "<name>"}`, once the model is loaded |
| `POST /audio/transcriptions` and `POST /v1/audio/transcriptions` | multipart `file`, plus optional `language` and `response_format` |

`response_format` `text` returns plain text. Every other value, `verbose_json`, `srt` and `vtt` included, returns JSON with `text`, `language` and, where faster-whisper reports it, `duration`. The model is fixed when the server starts: a `model` field in the request is accepted and ignored. There are no streaming or `/v1/models` routes, so leave `voice.stt.model` unset and the dashboard transcribes in batch ([speech-server-api.md](../../../docs/reference/speech-server-api.md)).

## Install

Needs Python 3.10 or newer (faster-whisper itself supports 3.9; 3.12 is the version this adapter is written against).

```bash
mkdir -p ~/services/stt/faster-whisper/logs
cp server.py requirements.txt ~/services/stt/faster-whisper/   # from this folder
cd ~/services/stt/faster-whisper

python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

The `logs` folder has to exist: the control plane writes the service's output there and fails to start it otherwise.

faster-whisper bundles FFmpeg's libraries (through PyAV), so no system FFmpeg is needed. For an NVIDIA GPU it also needs the CUDA 12 cuBLAS and cuDNN 9 libraries, which `pip` does not install; see faster-whisper's own README for the options.

The first start downloads the model from the Hugging Face Hub into `~/.cache/huggingface`. For `turbo` that is well over a gigabyte, and the server only answers its health check once it has loaded, so the first start can outlast the registry's `startupTime` (180000 ms). Warm the cache once by hand to avoid that:

```bash
.venv/bin/python -c "from faster_whisper import WhisperModel; WhisperModel('turbo')"
```

## Settings

Read from the environment, which the registry sets under `ops.env.variables`. When run as `python server.py`, the matching flags (`--model`, `--device`, `--compute-type`, `--host`, `--port`) win.

| Variable | Default | |
|---|---|---|
| `FASTER_WHISPER_MODEL` | `turbo` | A model name faster-whisper downloads (`turbo`, `large-v3`, `distil-large-v3`, `small`, and so on), or a path to a converted model |
| `FASTER_WHISPER_DEVICE` | `auto` | `cpu`, `cuda` or `auto` |
| `FASTER_WHISPER_COMPUTE_TYPE` | `int8` on `cpu`, otherwise `auto` | `int8`, `float16`, `int8_float16`, and the other CTranslate2 types |
| `FASTER_WHISPER_CORS_ORIGINS` | none | Comma-separated origins allowed to call the server. Unset adds no CORS headers, so the browser refuses every call. `ops/install.sh` fills it in the registry it seeds |

On a machine with no GPU, `FASTER_WHISPER_DEVICE=cpu` with the default `int8` is the CPU setting. With `auto` on a CPU-only machine the compute type is left to CTranslate2.

## Registry

The example registries declare it as:

```json
{
  "id": "stt-faster-whisper",
  "name": "Faster-Whisper STT",
  "capabilityId": "stt",
  "hostId": "this-machine",
  "permissions": { "enabled": true, "protected": false },
  "runner": {
    "type": "process",
    "main": ".venv/bin/uvicorn server:app --host 127.0.0.1 --port {port}"
  },
  "ops": {
    "env": {
      "workingDirectory": "~/services/stt/faster-whisper",
      "variables": {
        "FASTER_WHISPER_MODEL": "turbo",
        "FASTER_WHISPER_DEVICE": "auto",
        "FASTER_WHISPER_CORS_ORIGINS": "http://localhost:4200,http://localhost:5173"
      }
    }
  },
  "network": { "port": 8766, "healthPath": "/healthz" },
  "lifecycle": {
    "loadStrategy": "demand",
    "autoStart": false,
    "idleUnload": true,
    "idleTimeout": 1800000,
    "startupTime": 180000,
    "restartOnCrash": true,
    "maxRestarts": 3
  }
}
```

The control plane starts it when the dashboard first needs it and stops it after `idleTimeout` of no use. Its roster provider is `stt-faster-whisper` with one batch model, `faster-whisper`.
