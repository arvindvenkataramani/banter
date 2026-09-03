# TTS setup

Registry and config snippets for each text-to-speech model in [models.md](models.md#text-to-speech-models-recommended). Kokoro is covered in that page's [Quick start](models.md#quick-start-kokoro-and-parakeet) instead of here.

Every snippet assumes the service has already been installed per its `BUILD.md` (Swift services) or `requirements.txt` (Python services). See [configuration.md](configuration.md) for what each registry field means and how `voice.tts` fits together.

---

## NeuTTS Air

Install:

```bash
cp -r <banter>/services/tts/neutts-air ~/services/tts/neutts-air
cd ~/services/tts/neutts-air
python -m venv .venv && .venv/bin/pip install -r requirements.txt
# then install NeuTTS itself per neuphonic/neutts upstream instructions — see BUILD.md
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

Then add this to `config.json`'s `voice.tts` block:

```json
"voice": {
  "tts": {
    "providers": [
      {
        "serviceId": "tts-neutts-air",
        "name": "NeuTTS Air",
        "models": [
          { "id": "neuphonic/neutts-air", "name": "NeuTTS Air", "voices": [{ "id": "example", "name": "Example" }] }
        ]
      }
    ]
  }
}
```

The voice ID above (`example`) is whatever's declared in `voices.yaml` alongside `server.py` — add your own reference clip and entry there, then add a matching voice ID here. NeuTTS Air's CORS is wide open by default (`allow_origins=["*"]`), as Kokoro's is — there's no environment variable to set for either.

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

Then add this to `config.json`'s `voice.tts` block:

```json
"voice": {
  "tts": {
    "providers": [
      {
        "serviceId": "tts-voxtral",
        "name": "Voxtral",
        "models": [
          { "id": "tts-4b-6bit", "name": "Voxtral 4B (6-bit)", "voices": [{ "id": "neutralFemale", "name": "Neutral Female" }] }
        ]
      }
    ]
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

Then add this to `config.json`'s `voice.tts` block:

```json
"voice": {
  "tts": {
    "providers": [
      {
        "serviceId": "tts-mlx-audio",
        "name": "mlx-audio",
        "models": [
          {
            "id": "mlx-community/pocket-tts",
            "name": "Pocket TTS",
            "voices": [
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
    ]
  }
}
```

`mlx-audio` has no dedicated health endpoint; `GET /v1/models` doubles as one, returning 2xx once it's actually ready to serve. `--allowed-origins` is `mlx-audio`'s own CORS flag — pass the dashboard's origin the same as any other service. Any other model `mlx-audio` supports can be added as another entry in the same provider's `models` array; no second registry entry or process needed.

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

Fill in `port` with whatever the server listens on, and confirm its CORS configuration allows the dashboard's origin — the browser calls this server directly. Then add this to `config.json`'s `voice.tts` block:

```json
"voice": {
  "tts": {
    "providers": [
      {
        "serviceId": "tts-yourservice",
        "name": "Your Service",
        "models": [
          { "id": "vendor/model-name", "name": "Model Name", "voices": [{ "id": "voice-id", "name": "Voice Name" }] }
        ]
      }
    ]
  }
}
```
