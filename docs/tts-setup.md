# TTS setup

Registry and config snippets for each text-to-speech model in [models.md](models.md#text-to-speech-models-recommended). Kokoro is covered in that page's [Quick start](models.md#quick-start) instead of here.

Every snippet assumes the service has already been installed: `requirements.txt` (Python services), its own `BUILD.md` (Voxtral), or `scripts/fluid-build.sh` (fluid). See [configuration.md](configuration.md) for what each registry field means, and [voices-and-models.md](voices-and-models.md) for what a roster provider, model and voice are and how `voice.tts.selection` refers to them.

Each `roster.providers` snippet below is a new key to add to that object — alongside the `fluid-tts`/`fluid-stt` entries already there if you started from the shipped registry, not replacing them.

---

## NeuTTS Air

Install:

```bash
cp -r <banter>/services/tts/neutts-air ~/services/tts/neutts-air
cd ~/services/tts/neutts-air
python -m venv .venv && .venv/bin/pip install -r requirements.txt
# then install NeuTTS itself per neuphonic/neutts upstream instructions (github.com/neuphonic/neutts)
```

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
    "main": ".venv/bin/uvicorn server:app --host 127.0.0.1 --port 8004"
  },
  "ops": { "env": { "workingDirectory": "~/services/tts/neutts-air" } },
  "network": { "port": 8004, "healthPath": "/health" },
  "lifecycle": { "loadStrategy": "demand", "idleUnload": true, "idleTimeout": 1800000 }
}
```

Then add a `roster.providers` entry for it in `registry.json`:

```json
"roster": {
  "providers": {
    "tts-neutts-air": {
      "responseFormat": "wav",
      "ttsModels": [
        {
          "id": "neuphonic/neutts-air",
          "name": "NeuTTS Air",
          "key": "neuphonic/neutts-air",
          "presetVoices": [{ "id": "example", "name": "Example" }]
        }
      ]
    }
  }
}
```

The voice ID above (`example`) is whatever's declared in `voices.yaml` alongside `server.py` — add your own reference clip and entry there, then add a matching voice ID here. NeuTTS Air's CORS is wide open by default (`allow_origins=["*"]`), as Kokoro's is — there's no environment variable to set for either. The dashboard sends `responseFormat` as the request's `response_format` and decodes the response as that format, so set it to `"wav"` or `"mp3"` — either works, `"wav"` above is just NeuTTS Air's own default.

Point `voice.tts.selection` at it in `config.json`:

```json
"voice": {
  "tts": {
    "selection": { "serviceId": "tts-neutts-air", "model": "neuphonic/neutts-air", "voice": "example" }
  }
}
```

---

## Voxtral

Build first per [`tts/mlx-voxtral-swift`'s BUILD.md](../services/tts/mlx-voxtral-swift/BUILD.md) — this one compiles a Swift binary rather than installing a pip package.

Add this entry to `registry.json`'s `services`:

```json
{
  "id": "tts-voxtral",
  "name": "Voxtral",
  "capabilityId": "tts",
  "hostId": "<your-host-id>",
  "permissions": { "enabled": true, "protected": false },
  "runner": {
    "type": "process",
    "main": "bin/VoxtralHTTPServer --model tts-4b-6bit --host 127.0.0.1 --port 8003"
  },
  "ops": { "env": { "workingDirectory": "~/services/tts/mlx-voxtral-swift" } },
  "network": { "port": 8003, "healthPath": "/health" },
  "lifecycle": { "loadStrategy": "demand", "idleUnload": true, "idleTimeout": 1800000, "startupTime": 120000 }
}
```

Then add a `roster.providers` entry for it in `registry.json`, and point `voice.tts.selection` at it in `config.json`:

```json
"roster": {
  "providers": {
    "tts-voxtral": {
      "responseFormat": "wav",
      "ttsModels": [
        {
          "id": "tts-4b-6bit",
          "name": "Voxtral 4B (6-bit)",
          "key": "tts-4b-6bit",
          "presetVoices": [{ "id": "neutralFemale", "name": "Neutral Female" }]
        }
      ]
    }
  }
}
```

Voxtral's server always returns `audio/wav`, hence `responseFormat: "wav"` above — leaving it out defaults to `mp3` and the dashboard would try to decode wav bytes as mp3.

```json
"voice": {
  "tts": {
    "selection": { "serviceId": "tts-voxtral", "model": "tts-4b-6bit", "voice": "neutralFemale" }
  }
}
```

`--model` accepts any ID in `VoxtralTTSRegistry` — `tts-4b-4bit`, `tts-4b-6bit`, `tts-4b-mlx` (bf16) among them. `tts-4b-6bit` is the one worth starting from for realtime use; bf16 is too slow for a voice conversation. The `startupTime` above gives the health check longer to wait — loading the larger variants into GPU memory can take a while.

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
    "main": ".venv/bin/mlx_audio.server --host 127.0.0.1 --port 8001 --allowed-origins http://localhost:4200"
  },
  "ops": { "env": { "workingDirectory": "~/services/tts/mlx-audio" } },
  "network": { "port": 8001, "healthPath": "/v1/models" },
  "lifecycle": { "loadStrategy": "demand", "idleUnload": true, "idleTimeout": 1800000 }
}
```

Then add a `roster.providers` entry for it in `registry.json`:

```json
"roster": {
  "providers": {
    "tts-mlx-audio": {
      "ttsModels": [
        {
          "id": "mlx-community/pocket-tts",
          "name": "Pocket TTS",
          "key": "mlx-community/pocket-tts",
          "presetVoices": [
            { "id": "alba", "name": "Alba" },
            { "id": "marius", "name": "Marius" },
            { "id": "javert", "name": "Javert" },
            { "id": "jean", "name": "Jean" },
            { "id": "fantine", "name": "Fantine" },
            { "id": "cosette", "name": "Cosette" },
            { "id": "eponine", "name": "Eponine" },
            { "id": "azelma", "name": "Azelma" }
          ]
        }
      ]
    }
  }
}
```

Point `voice.tts.selection` at whichever preset you want by default:

```json
"voice": {
  "tts": {
    "selection": { "serviceId": "tts-mlx-audio", "model": "mlx-community/pocket-tts", "voice": "alba" }
  }
}
```

`mlx-audio` has no dedicated health endpoint; `GET /v1/models` doubles as one, returning 2xx once it's actually ready to serve. `--allowed-origins` is `mlx-audio`'s own CORS flag — pass the dashboard's origin the same as any other service. Any other model `mlx-audio` supports can be added as another entry in the same provider's `ttsModels` array; no second registry entry or process needed.

`responseFormat` in the roster entry above is left unset, defaulting to `mp3` — the dashboard sends that as the request's `response_format` and decodes the response as that format, so this only works if `mlx-audio` honors the field. Set `responseFormat` explicitly to `"wav"` if you'd rather it request wav.

---

## OmniVoice

This repo has no adapter for it, and no general-purpose runtime here already exposes an OpenAI-compatible endpoint for it — see [models.md](models.md#text-to-speech-models-recommended) for what exists and its gaps. Registering it means writing a server first: something exposing `POST /v1/audio/speech` and a health path in front of the model, then a registry entry following the same shape as the services above.

---

## Anything else OpenAI-compatible

Any server exposing `POST /v1/audio/speech` and a health endpoint can be registered directly, no adapter needed. Add an entry like this to `registry.json`'s `services`:

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
  "lifecycle": { "loadStrategy": "demand", "idleUnload": true, "idleTimeout": 1800000 }
}
```

Fill in `port` with whatever the server listens on, and confirm its CORS configuration allows the dashboard's origin — the browser calls this server directly. Then add a `roster.providers` entry for it in `registry.json`:

```json
"roster": {
  "providers": {
    "tts-yourservice": {
      "ttsModels": [
        {
          "id": "vendor/model-name",
          "name": "Model Name",
          "key": "vendor/model-name",
          "presetVoices": [{ "id": "voice-id", "name": "Voice Name" }]
        }
      ]
    }
  }
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

A wrong model id or voice key fails at the request, not at load — the roster is Banter's claim about what a third-party server will accept, not something checked against it. See [voices-and-models.md](voices-and-models.md#adding-another-model-or-another-speech-server) for the full shape, including voices built from reference audio.

Set the provider's `responseFormat` to `mp3`, `aac`, or `wav` — the dashboard sends this as the request's `response_format` and decodes the response as that format, so it needs to match what the server actually returns for that value. Absent means `mp3`.
