# STT setup

Registry and config snippets for each speech-to-text model in [models.md](models.md#speech-to-text-models-recommended). `parakeet-mlx-fastapi` is covered in that page's [Quick start](models.md#quick-start-kokoro-and-parakeet) instead of here.

Every snippet assumes the service has already been installed per its `BUILD.md` (Swift services) or `requirements.txt` (Python services). See [configuration.md](configuration.md) for what each registry field means.

---

## Parakeet TDT via fluid-audio

The alternative to the Quick Start's `parakeet-mlx-fastapi` — same underlying model, served through this repo's CoreML adapter instead of MLX. Build first per [`stt/fluid-audio`'s BUILD.md](../services/stt/fluid-audio/BUILD.md).

Add this entry to `registry.json`'s `services`:

```json
{
  "id": "stt-fluid-audio",
  "name": "Parakeet (fluid-audio)",
  "capabilityId": "stt",
  "hostId": "<your-host-id>",
  "permissions": { "enabled": true, "protected": false },
  "runner": {
    "type": "process",
    "main": ".build/release/fluidserver --model-version v3 --host 127.0.0.1 --port 8767"
  },
  "ops": {
    "env": {
      "workingDirectory": "~/services/stt/fluid-audio",
      "variables": { "FLUID_CORS_ORIGINS": "http://localhost:4200" }
    }
  },
  "network": { "port": 8767, "healthPath": "/healthz" },
  "lifecycle": { "loadStrategy": "demand", "idleUnload": true, "idleTimeout": 1800000 }
}
```

Then add this to `config.json`'s `voice.stt` block:

```json
"voice": {
  "stt": { "serviceId": "stt-fluid-audio" }
}
```

`--model-version` accepts `v2`, `v3`, or `tdt-ctc-110m`; `v3` matches the Quick Start's MLX-served model. Replace the CORS origin with wherever the dashboard is actually reached.

---

## Whisper

This repo's server around `mlx-whisper`.

Install:

```bash
cp -r <banter>/services/stt/whisper ~/services/stt/whisper
cd ~/services/stt/whisper
python -m venv .venv && .venv/bin/pip install -r requirements.txt
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
    "main": ".venv/bin/python server.py --model mlx-community/whisper-large-v3-turbo --port 8766"
  },
  "ops": {
    "env": {
      "workingDirectory": "~/services/stt/whisper",
      "variables": { "WHISPER_CORS_ORIGINS": "http://localhost:4200" }
    }
  },
  "network": { "port": 8766, "healthPath": "/healthz" },
  "lifecycle": { "loadStrategy": "demand", "idleUnload": true, "idleTimeout": 1800000 }
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

## Whisper via faster-whisper

Not this repo's code, and not tested with Banter. Built on CTranslate2 — CPU or CUDA, not GPU-only. Several projects wrap it in an OpenAI-compatible server:

- [fedirz/faster-whisper-server](https://github.com/fedirz/faster-whisper-server)
- [hwdsl2/docker-whisper](https://github.com/hwdsl2/docker-whisper) — Docker, CUDA, multi-arch
- [hwdsl2/whisper-install](https://github.com/hwdsl2/whisper-install) — installer for Debian/Ubuntu/RHEL family

Once one is running, the registry entry looks the same shape as the ones above — `runner.main` is whatever starts that server, `network.healthPath` is whatever it exposes, and `voice.stt.serviceId` points at it:

```json
"voice": {
  "stt": { "serviceId": "stt-yourservice" }
}
```

Confirm its CORS configuration allows the dashboard's origin before assuming it works — the browser calls the STT server directly, so a server that answers `curl` fine can still fail from the page.

---

## Anything else OpenAI-compatible

Any server exposing `POST /v1/audio/transcriptions`, a health endpoint, and the dashboard's origin in CORS can be registered directly. Add an entry like this to `registry.json`'s `services`:

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
  "lifecycle": { "loadStrategy": "demand", "idleUnload": true, "idleTimeout": 1800000 }
}
```

Then add this to `config.json`'s `voice.stt` block:

```json
"voice": {
  "stt": { "serviceId": "stt-yourservice" }
}
```
