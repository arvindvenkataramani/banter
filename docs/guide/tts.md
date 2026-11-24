# TTS setup

Registry and config snippets for each text-to-speech model in [models.md](models.md#text-to-speech-models).

Every snippet assumes the service has already been installed, following its adapter's README: [`tts/kokoro`](../../services/tts/kokoro/README.md) and [`tts/neutts-air`](../../services/tts/neutts-air/README.md) (this repo's Python adapters), `pip install mlx-audio` (Pocket TTS), or `scripts/fluid-build.sh` (fluid). See [configuration.md](../reference/configuration.md) for what each registry field means, and [voices-and-models.md](voices-and-models.md) for what a roster provider, model and voice are and how `voice.tts.selection` refers to them.

Each `roster` snippet below adds entries to what is already there: a new key in `providers`, new items in `ttsModels` and `voices`. None of it replaces the existing entries.

---

## Kokoro

This repo's adapter, [`services/tts/kokoro`](../../services/tts/kokoro/README.md): the PyTorch `KPipeline` behind an OpenAI-compatible server, on CPU or a GPU, on Linux and macOS. The example registry has an entry in this shape.

Install it by following the adapter's README: copy `server.py` and `requirements.txt` into the service's working directory, create the `logs/` folder the control plane writes to, and build the virtual environment there.

```json
{
  "id": "tts-kokoro",
  "name": "Kokoro TTS",
  "capabilityId": "tts",
  "hostId": "<your-host-id>",
  "permissions": { "enabled": true, "protected": false },
  "runner": {
    "type": "process",
    "main": ".venv/bin/uvicorn server:app --host 127.0.0.1 --port {port}"
  },
  "ops": {
    "env": {
      "workingDirectory": "~/services/tts/kokoro",
      "variables": { "KOKORO_CORS_ORIGINS": "http://localhost:4200,http://localhost:5173" }
    }
  },
  "network": { "port": 8002, "healthPath": "/health" },
  "lifecycle": { "loadStrategy": "demand", "autoStart": false, "idleUnload": true, "idleTimeout": 1800000, "startupTime": 90000, "restartOnCrash": true, "maxRestarts": 3 },
  "provides": [
    {
      "api": "openai.audio.speech",
      "omits": ["parameter:instructions", "parameter:stream_format"],
      "restricts": { "response_format": ["wav"] }
    }
  ],
  "models": {
    "loading": "required",
    "autoLoad": "always",
    "resident": "one",
    "load": { "method": "POST", "path": "/v1/models", "query": { "model_name": "{model}" } },
    "unload": { "method": "DELETE", "path": "/v1/models", "query": { "model_name": "{model}" } }
  }
}
```

`KOKORO_CORS_ORIGINS` is a comma-separated allowlist; unset, the server sends no CORS headers and the browser refuses every call. `startupTime` covers importing PyTorch, which happens before the server listens.

The server always answers `audio/wav`, so the entry's `openai.audio.speech` provision restricts `response_format` to `["wav"]`; Banter sends the first restricted value it can decode, and decodes the response as it. It omits `instructions` and `stream_format`, which the server does not implement, and declares how a model loads: a request does load a model it names, and the `load` and `unload` calls are `/v1/models` with `model_name`. The adapter builds its pipeline for American English, so the voices are the `af_` (female) and `am_` (male) presets. The roster declares the model once, the provider that serves it, and each voice as a rendering on the model, as in the example registry, trimmed:

```json
"roster": {
  "ttsModels": [{ "id": "kokoro-82m", "name": "Kokoro 82M" }],
  "providers": {
    "tts-kokoro": {
      "resolvesVoices": false,
      "serves": [{ "model": "kokoro-82m", "key": "kokoro-82m" }]
    }
  },
  "voices": [
    {
      "id": "heart",
      "name": "Heart",
      "renderings": [{ "model": "kokoro-82m", "method": "preset", "key": "af_heart" }]
    }
  ]
}
```

`resolvesVoices` is `false` because the adapter does not read the registry, so the shard on its machine turns the selected voice into the `af_heart` the server expects.

Point `voice.tts.selection` at it in `config.json`:

```json
"voice": {
  "tts": {
    "selection": { "serviceId": "tts-kokoro", "model": "kokoro-82m", "voice": "heart" }
  }
}
```

The weights download to `~/.cache/huggingface` the first time the pipeline loads. [voices-and-models.md](voices-and-models.md) shows how to add more voices.

---

## NeuTTS Air

This repo's adapter, [`services/tts/neutts-air`](../../services/tts/neutts-air/README.md). Install it by following that README: it copies `server.py` and `voices.example.yaml` into the working directory, creates `logs/` and a virtual environment, and installs NeuTTS itself from a patched clone (stock upstream rejects `max_context`).

Add this entry to `registry.json`'s `services`:

```json
{
  "id": "tts-neutts-air",
  "name": "NeuTTS Air",
  "capabilityId": "tts",
  "hostId": "<your-host-id>",
  "permissions": { "enabled": true, "protected": false },
  "runner": {
    "type": "process",
    "main": ".venv/bin/uvicorn server:app --host 127.0.0.1 --port {port}"
  },
  "ops": {
    "env": {
      "workingDirectory": "~/services/tts/neutts-air",
      "variables": { "NEUTTS_CORS_ORIGINS": "http://localhost:4200,http://localhost:5173" }
    }
  },
  "network": { "port": 8004, "healthPath": "/health" },
  "lifecycle": { "loadStrategy": "demand", "idleUnload": true, "idleTimeout": 1800000 },
  "provides": [
    {
      "api": "openai.audio.speech",
      "omits": ["parameter:instructions", "parameter:stream_format"],
      "restricts": { "response_format": ["wav", "mp3"] }
    }
  ],
  "models": { "loading": "none" }
}
```

Then add its model, provider and a voice to the `roster` in `registry.json`:

```json
"roster": {
  "ttsModels": [{ "id": "neuphonic/neutts-air", "name": "NeuTTS Air" }],
  "providers": {
    "tts-neutts-air": {
      "resolvesVoices": false,
      "serves": [{ "model": "neuphonic/neutts-air", "key": "neuphonic/neutts-air" }]
    }
  },
  "voices": [
    {
      "id": "example",
      "name": "Example",
      "renderings": [{ "model": "neuphonic/neutts-air", "method": "preset", "key": "example" }]
    }
  ]
}
```

The rendering's `key` (`example` above) is whatever's declared in `voices.yaml` alongside `server.py` — add your own reference clip and entry there, then add a matching voice here. `NEUTTS_CORS_ORIGINS` is a comma-separated allowlist; unset, the server sends no CORS headers and the browser refuses every call. The provision restricts `response_format` to `wav` and `mp3`, in that order, and Banter sends the first it can decode and decodes the response as that format. It declares neither `stream-flag` nor loading, because NeuTTS Air's stream ignores the format and the model is fixed when the server starts.

Point `voice.tts.selection` at it in `config.json`:

```json
"voice": {
  "tts": {
    "selection": { "serviceId": "tts-neutts-air", "model": "neuphonic/neutts-air", "voice": "example" }
  }
}
```

---

## Pocket TTS

No adapter in this repo — served through `mlx-audio`, a general-purpose runtime that can host several models behind one registry entry.

Install:

```bash
mkdir -p ~/services/tts/mlx-audio && cd ~/services/tts/mlx-audio
python -m venv .venv && .venv/bin/pip install mlx-audio
```

Add this entry to `registry.json`'s `services`:

```json
{
  "id": "tts-mlx-audio",
  "name": "mlx-audio",
  "capabilityId": "tts",
  "hostId": "<your-host-id>",
  "permissions": { "enabled": true, "protected": false },
  "runner": {
    "type": "process",
    "main": ".venv/bin/mlx_audio.server --host 127.0.0.1 --port {port} --allowed-origins http://localhost:4200"
  },
  "ops": { "env": { "workingDirectory": "~/services/tts/mlx-audio" } },
  "network": { "port": 8001, "healthPath": "/v1/models" },
  "lifecycle": { "loadStrategy": "demand", "idleUnload": true, "idleTimeout": 1800000 },
  "provides": [
    {
      "api": "openai.audio.speech",
      "omits": ["parameter:stream_format"],
      "extends": ["stream-flag", "cloning-reference"]
    }
  ],
  "models": {
    "loading": "required",
    "autoLoad": "always",
    "resident": "many",
    "load": { "method": "POST", "path": "/v1/models", "query": { "model_name": "{model}" } },
    "unload": { "method": "DELETE", "path": "/v1/models", "query": { "model_name": "{model}" } }
  }
}
```

Then add its model, provider and voices to the `roster` in `registry.json`. The model id is Banter's own (`pocket-tts`); the runtime's name for it, `mlx-community/pocket-tts`, is the serving's `key`. Voices are shown trimmed to two of the eight presets (`alba`, `marius`, `javert`, `jean`, `fantine`, `cosette`, `eponine`, `azelma`), each declared the same way:

```json
"roster": {
  "ttsModels": [{ "id": "pocket-tts", "name": "Pocket-TTS" }],
  "providers": {
    "tts-mlx-audio": {
      "resolvesVoices": false,
      "serves": [{ "model": "pocket-tts", "key": "mlx-community/pocket-tts" }]
    }
  },
  "voices": [
    { "id": "alba", "name": "Alba", "renderings": [{ "model": "pocket-tts", "method": "preset", "key": "alba" }] },
    { "id": "marius", "name": "Marius", "renderings": [{ "model": "pocket-tts", "method": "preset", "key": "marius" }] }
  ]
}
```

If `pocket-tts` is already declared in the registry (as it is when the fluid servers are merged in), do not declare it again: add only the provider, and any voice not yet declared. A voice that is already declared gains this runtime without any edit, since a voice is available wherever some runtime serves a model that renders her.

Point `voice.tts.selection` at whichever preset you want by default:

```json
"voice": {
  "tts": {
    "selection": { "serviceId": "tts-mlx-audio", "model": "pocket-tts", "voice": "alba" }
  }
}
```

`mlx-audio` has no dedicated health endpoint; `GET /v1/models` doubles as one, returning 2xx once it's actually ready to serve. `--allowed-origins` is `mlx-audio`'s own CORS flag — pass Banter's origin the same as any other service. Any other model `mlx-audio` supports can be added as another entry in the same provider's `serves` list, after declaring it in `ttsModels`; no second registry entry or process needed.

The provision above restricts nothing, so Banter asks for `mp3` and decodes the response as mp3, which only works if `mlx-audio` honors `response_format`. Restrict `response_format` to `["wav"]` if you'd rather it request wav. `stream-flag` lets Banter send `stream: true` for audio as it renders, and `cloning-reference` lets a cloned voice go as `ref_audio`. `mlx-audio` keeps every model it has loaded, so the entry says `resident: "many"` and declares an unload call: when the selected model changes, Banter unloads the one it is leaving.

---

## fluid-tts

An Apple Silicon option: Pocket TTS, Kokoro on the Neural Engine, and LuxTTS through `services/fluid`, with streaming audio. Its entry and roster are in `services/fluid/registry.fluid.example.json`, which merges into your registry by union ([speech-servers.md](speech-servers.md#fluid-an-apple-silicon-option)). [`services/fluid`](../../services/fluid/README.md) covers what the server offers, including voices built from reference audio.

---

## OmniVoice

This repo has no adapter for it, and no general-purpose runtime here already exposes an OpenAI-compatible endpoint for it — see [models.md](models.md#text-to-speech-models) for what exists and its gaps. Registering it means writing a server first: something exposing `POST /v1/audio/speech` and a health path in front of the model, then a registry entry following the same shape as the services above.

---

## Anything else OpenAI-compatible

Any server providing `openai.audio.speech` (`POST /v1/audio/speech`) and a health endpoint can be registered directly, no adapter needed. Add an entry like this to `registry.json`'s `services`, and list under `omits` and `restricts` where the server departs from OpenAI's API:

```json
{
  "id": "tts-yourservice",
  "name": "Your Service",
  "capabilityId": "tts",
  "hostId": "<your-host-id>",
  "permissions": { "enabled": true, "protected": false },
  "runner": {
    "type": "process",
    "main": "<the command that starts your server>"
  },
  "ops": { "env": { "workingDirectory": "~/services/tts/yourservice" } },
  "network": { "port": 0, "healthPath": "/health" },
  "lifecycle": { "loadStrategy": "demand", "idleUnload": true, "idleTimeout": 1800000 },
  "provides": [{ "api": "openai.audio.speech", "restricts": { "response_format": ["wav"] } }],
  "models": { "loading": "none" }
}
```

Fill in `port` with whatever the server listens on, and confirm its CORS configuration allows Banter's origin — the browser calls this server directly. Then add its model, provider and a voice to the `roster` in `registry.json`:

```json
"roster": {
  "ttsModels": [{ "id": "vendor/model-name", "name": "Model Name" }],
  "providers": {
    "tts-yourservice": {
      "resolvesVoices": false,
      "serves": [{ "model": "vendor/model-name", "key": "vendor/model-name" }]
    }
  },
  "voices": [
    {
      "id": "voice-id",
      "name": "Voice Name",
      "renderings": [{ "model": "vendor/model-name", "method": "preset", "key": "voice-id" }]
    }
  ]
}
```

And point `voice.tts.selection` at it in `config.json`:

```json
"voice": {
  "tts": {
    "selection": { "serviceId": "tts-yourservice", "model": "vendor/model-name", "voice": "voice-id" }
  }
}
```

A wrong serving `key` or rendering `key` fails at the request, not at load — the roster is Banter's claim about what a third-party server will accept, not something checked against it. See [voices-and-models.md](voices-and-models.md#adding-another-model-or-another-speech-server) for the full shape, including voices built from reference audio.

Restrict `response_format` in the provision to the values the server accepts, from `mp3`, `aac` and `wav`, in order of preference — Banter sends the first as the request's `response_format` and decodes the response as that format, so each must match what the server actually returns for that value. With no restriction it sends `mp3`. A restriction with none of the three is refused before any request.
