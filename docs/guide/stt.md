# STT setup

Registry and config snippets for each speech-to-text model in [models.md](models.md#speech-to-text-models). `parakeet-mlx-fastapi` is covered in that page's [Quick start](models.md#quick-start) instead of here.

Every snippet assumes the service has already been installed, following its adapter's README: [`stt/faster-whisper`](../../services/stt/faster-whisper/README.md) and [`stt/whisper`](../../services/stt/whisper/server.py) are Python (`requirements.txt` in a virtual environment); fluid is built with `scripts/fluid-build.sh`. See [configuration.md](../reference/configuration.md) for what each registry field means. `voice.stt.serviceId` is validated against the registry directly and needs no roster entry; a roster `sttModels` entry, with the provider's `serves` list, is only how a server that reads the roster, such as `fluid-stt`, declares what it can load. See [voices-and-models.md](voices-and-models.md) if you are adding a model there.

---

## faster-whisper

This repo's adapter, [`services/stt/faster-whisper`](../../services/stt/faster-whisper/README.md): batch transcription with [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (CTranslate2) on CPU or an NVIDIA GPU, on Linux, macOS and Windows. The example registry has an entry in this shape.

Install it by following the adapter's README: copy `server.py` and `requirements.txt` into the service's working directory, create the `logs/` folder the control plane writes to, and build the virtual environment there.

```json
{
  "id": "stt-faster-whisper",
  "name": "Faster-Whisper STT",
  "capabilityId": "stt",
  "hostId": "<your-host-id>",
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
  "lifecycle": { "loadStrategy": "demand", "autoStart": false, "idleUnload": true, "idleTimeout": 1800000, "startupTime": 180000, "restartOnCrash": true, "maxRestarts": 3 },
  "provides": [
    {
      "api": "openai.audio.transcriptions",
      "omits": [
        "parameter:languages", "parameter:keywords", "parameter:prompt", "parameter:temperature", "parameter:include",
        "parameter:timestamp_granularities", "parameter:stream", "parameter:chunking_strategy",
        "parameter:known_speaker_names", "parameter:known_speaker_references"
      ],
      "restricts": { "response_format": ["json", "text"] }
    }
  ],
  "models": { "loading": "none" }
}
```

Settings come from `ops.env.variables`:

| Variable | Default | |
|---|---|---|
| `FASTER_WHISPER_MODEL` | `turbo` | A model name faster-whisper downloads (`turbo`, `large-v3`, `distil-large-v3`, `small`, and so on), or a path to a converted model |
| `FASTER_WHISPER_DEVICE` | `auto` | `cpu`, `cuda` or `auto` |
| `FASTER_WHISPER_COMPUTE_TYPE` | `int8` on `cpu`, otherwise `auto` | `int8`, `float16`, `int8_float16`, and the other CTranslate2 types |
| `FASTER_WHISPER_CORS_ORIGINS` | none | Comma-separated origins allowed to call the server. Unset adds no CORS headers, so the browser refuses every call |

The server is batch only: it provides no streaming API and declares no loading, and the model is fixed when it starts (a `model` field in a request is ignored). Leave `voice.stt.model` unset and Banter transcribes in batch:

```json
"voice": {
  "stt": { "serviceId": "stt-faster-whisper", "preferStreaming": false }
}
```

The first start downloads the model from the Hugging Face Hub into `~/.cache/huggingface`. For `turbo` that is well over a gigabyte, and the server answers its health check only once the model has loaded, so the first start can outlast `startupTime` (180000 ms). Warm the cache once by hand, as the adapter's README shows. faster-whisper has no Metal backend, so on a Mac it runs on the CPU.

Replace the CORS origins with wherever Banter is actually reached if it is not `localhost`.

---

## Whisper (MLX)

This repo's server around `mlx-whisper`, for Apple Silicon.

Install:

```bash
mkdir -p ~/services/stt/whisper/logs
cp <banter>/services/stt/whisper/{server.py,requirements.txt} ~/services/stt/whisper/
cd ~/services/stt/whisper
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

Add this entry to `registry.json`'s `services`:

```json
{
  "id": "stt-whisper",
  "name": "Whisper",
  "capabilityId": "stt",
  "hostId": "<your-host-id>",
  "permissions": { "enabled": true, "protected": false },
  "runner": {
    "type": "process",
    "main": ".venv/bin/python server.py --model mlx-community/whisper-large-v3-turbo --port {port}"
  },
  "ops": {
    "env": {
      "workingDirectory": "~/services/stt/whisper",
      "variables": { "WHISPER_CORS_ORIGINS": "http://localhost:4200,http://localhost:5173" }
    }
  },
  "network": { "port": 8768, "healthPath": "/healthz" },
  "lifecycle": { "loadStrategy": "demand", "idleUnload": true, "idleTimeout": 1800000 },
  "provides": [
    {
      "api": "openai.audio.transcriptions",
      "omits": [
        "parameter:languages", "parameter:keywords", "parameter:prompt", "parameter:temperature", "parameter:include",
        "parameter:timestamp_granularities", "parameter:stream", "parameter:chunking_strategy",
        "parameter:known_speaker_names", "parameter:known_speaker_references"
      ],
      "restricts": { "response_format": ["json", "text"] }
    }
  ],
  "models": { "loading": "none" }
}
```

Then add this to `config.json`'s `voice.stt` block:

```json
"voice": {
  "stt": { "serviceId": "stt-whisper" }
}
```

Swap `--model` for a smaller Whisper checkpoint to trade accuracy for speed and memory.

---

## fluid-stt

An Apple Silicon option: Parakeet and Nemotron through `services/fluid`'s CoreML adapter, with streaming (an alternative to the Quick Start's MLX-served `parakeet-mlx-fastapi`). Build first with `scripts/fluid-build.sh`; see [`services/fluid`](../../services/fluid/README.md) for what the server offers and how to install it.

Its entry is in `services/fluid/registry.fluid.example.json`, which merges into your live `registry.json` by union ([speech-servers.md](speech-servers.md#fluid-an-apple-silicon-option)). It has this shape; the merge command in [`services/fluid/README.md`](../../services/fluid/README.md#registering-them) sets `hostId` and expands the `~/` in `workingDirectory`, and you edit the rest in the merged entry:

```json
{
  "id": "fluid-stt",
  "name": "Fluid STT",
  "capabilityId": "stt",
  "hostId": "this-machine",
  "permissions": { "enabled": true, "protected": false },
  "runner": {
    "type": "process",
    "main": "fluid-stt.app/Contents/MacOS/fluid-stt --port {port} --registry {registry} --provider fluid-stt"
  },
  "ops": {
    "env": {
      "workingDirectory": "~/services/fluid/fluid-stt",
      "variables": {
        "PATH": "/opt/homebrew/bin:$PATH",
        "FLUID_CORS_ORIGINS": "http://localhost:4200,http://localhost:5173"
      }
    }
  },
  "network": { "port": 8767, "healthPath": "/healthz" },
  "lifecycle": { "loadStrategy": "demand", "autoStart": false, "shutdown": true, "idleUnload": true, "idleTimeout": 1800000, "restartOnCrash": true, "maxRestarts": 3 },
  "provides": [
    { "api": "fluid.stt.stream" },
    {
      "api": "openai.audio.transcriptions",
      "omits": [
        "value:timestamp_granularities=segment", "parameter:language", "parameter:languages", "parameter:keywords", "parameter:prompt",
        "parameter:temperature", "parameter:include", "parameter:chunking_strategy", "parameter:known_speaker_names", "parameter:known_speaker_references"
      ],
      "restricts": { "response_format": ["json", "text", "verbose_json"] }
    },
    { "api": "triton.model-repository", "omits": ["field:index.version"], "extends": ["resident-slot"] }
  ],
  "models": { "loading": "required", "autoLoad": "always", "resident": "one" }
}
```

The entry shown leaves out the Deepgram and Realtime provisions the example file also declares (`deepgram.listen.prerecorded`, `deepgram.listen.live` and `openai.realtime`), which let a client written for those APIs use the server; see [speech-server-api.md](../reference/speech-server-api.md#what-the-fluid-servers-provide). `provides` is what Banter reads to choose how to call the service, and `models` says a request naming a model loads it, replacing the one resident.

`--registry` and `--provider` are required — `fluid-stt` reads the models the `fluid-stt` provider `serves` from the registry's `roster` section rather than taking a model on the command line. The fluid example declares `parakeet-tdt-v3` (batch), `parakeet-unified-0.6b` (both batch and streaming), and `nemotron-streaming-en-0.6b` (streaming, at three chunk sizes) — see [voices-and-models.md](voices-and-models.md) for what an `sttModels` entry and a `serves` entry look like and how to add or change one. The same provider block's `defaultModel` is what a request naming no model loads into an empty server, and `idleUnloadMs` (30 minutes when absent) is how long the model stays resident without work.

`config.json`'s `voice.stt` selects it by service id and model:

```json
"voice": {
  "stt": { "serviceId": "fluid-stt", "model": "parakeet-unified-0.6b", "preferStreaming": true }
}
```

Replace the CORS origins with wherever Banter is actually reached if it isn't `localhost`.

---

## Other Whisper servers

Not this repo's code, and not tested with Banter: [whisper.cpp](https://github.com/ggml-org/whisper.cpp)'s `whisper-server`, and several projects that wrap faster-whisper in an OpenAI-compatible server:

- [speaches-ai/speaches](https://github.com/speaches-ai/speaches) (also known as `fedirz/faster-whisper-server`)
- [hwdsl2/docker-whisper](https://github.com/hwdsl2/docker-whisper): Docker, CUDA, multi-arch
- [hwdsl2/whisper-install](https://github.com/hwdsl2/whisper-install): installer for the Debian, Ubuntu and RHEL families

Once one is running, the registry entry has the same shape as the ones above: `runner.main` is whatever starts that server, `network.healthPath` is whatever it exposes, and `voice.stt.serviceId` points at it:

```json
"voice": {
  "stt": { "serviceId": "stt-yourservice" }
}
```

Confirm its CORS configuration allows Banter's origin before assuming it works. The browser calls the STT server directly, so a server that answers `curl` can still fail from the page.

---

## Anything else OpenAI-compatible

Any server providing `openai.audio.transcriptions` (`POST /v1/audio/transcriptions`), a health endpoint, and Banter's origin in CORS can be registered directly. Add an entry like this to `registry.json`'s `services`, with a `provides` that lists any request field the server ignores under `omits` (an empty provision claims the full API):

```json
{
  "id": "stt-yourservice",
  "name": "Your Service",
  "capabilityId": "stt",
  "hostId": "<your-host-id>",
  "permissions": { "enabled": true, "protected": false },
  "runner": {
    "type": "process",
    "main": "<the command that starts your server>"
  },
  "ops": { "env": { "workingDirectory": "~/services/stt/yourservice" } },
  "network": { "port": 0, "healthPath": "/health" },
  "lifecycle": { "loadStrategy": "demand", "idleUnload": true, "idleTimeout": 1800000 },
  "provides": [{ "api": "openai.audio.transcriptions" }],
  "models": { "loading": "none" }
}
```

Then add this to `config.json`'s `voice.stt` block:

```json
"voice": {
  "stt": { "serviceId": "stt-yourservice" }
}
```
