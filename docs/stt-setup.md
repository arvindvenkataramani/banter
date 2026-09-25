# STT setup

Registry and config snippets for each speech-to-text model in [models.md](models.md#speech-to-text-models-recommended). `parakeet-mlx-fastapi` is covered in that page's [Quick start](models.md#quick-start) instead of here.

Every snippet assumes the service has already been installed: `requirements.txt` (Python services) or `scripts/fluid-build.sh` (fluid). See [configuration.md](configuration.md) for what each registry field means. `voice.stt.serviceId` is validated against the registry directly and needs no roster entry; a roster `sttModels` list is only how `fluid-stt` itself declares what it can load — see [voices-and-models.md](voices-and-models.md) if you're adding a model there.

---

## Parakeet via fluid-stt

The default in the shipped examples — served through `services/fluid`'s CoreML adapter (the alternative to the Quick Start's MLX-served `parakeet-mlx-fastapi`). Build first with `scripts/fluid-build.sh`; see [`services/fluid`](../services/fluid/README.md) for what the server offers and how to install it.

The `fluid-stt` entry is already in `control/control-plane/data/registry.example.json`:

```json
{
  "id": "fluid-stt",
  "name": "Fluid STT",
  "capabilityId": "stt",
  "hostId": "this-machine",
  "permissions": { "enabled": true, "protected": false },
  "runner": {
    "type": "process",
    "main": ".build/release/fluid-stt --port 8767 --registry ~/services/banter/control/control-plane/data/registry.json --provider fluid-stt"
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
  "lifecycle": { "loadStrategy": "demand", "autoStart": false, "shutdown": true, "idleUnload": true, "idleTimeout": 1800000, "restartOnCrash": true, "maxRestarts": 3 }
}
```

`--registry` and `--provider` are required — `fluid-stt` reads the `fluid-stt` provider's `sttModels` from the registry's `roster` section rather than taking a model on the command line. The shipped roster declares `parakeet-tdt-v3` (batch), `parakeet-unified-0.6b` (both batch and streaming), and `nemotron-streaming-en-0.6b` (streaming, at three chunk sizes) — see [voices-and-models.md](voices-and-models.md) for what a roster `sttModels` entry looks like and how to add or change one.

`config.example.json` already points at it:

```json
"voice": {
  "stt": { "serviceId": "fluid-stt", "model": "parakeet-unified-0.6b", "preferStreaming": true }
}
```

Replace the CORS origins with wherever the dashboard is actually reached if it isn't `localhost`.

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
