# Kokoro, PyTorch

PyTorch `KPipeline` from the official hexgrad repo, behind an OpenAI-compatible server. Model `hexgrad/Kokoro-82M` (~2.3 GB peak RSS). It runs on CPU or a GPU, on Linux and macOS, and is the example registry's TTS server. Banter does not install it: you create the environment below on the machine that runs it. The example registry port is 8002, with `loadStrategy: "demand"`.

## Routes

`GET /health`, `POST /v1/models` (warms the pipeline), `DELETE /v1/models` (drops it, which backs `idleUnload`), and `POST /v1/audio/speech`, which answers `audio/wav` whatever `response_format` asks for, so the roster provider declares `"responseFormat": "wav"`. The adapter builds the pipeline for American English (`lang_code="a"`), so the example roster offers only the `af_` and `am_` voices.

## Install

Python 3.12; the `kokoro` package restricts the Python versions it installs on, so check its PyPI page before using a newer one.

```bash
mkdir -p ~/services/tts/kokoro/logs
cp server.py requirements.txt ~/services/tts/kokoro/   # from this folder
cd ~/services/tts/kokoro

python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

The `logs` folder has to exist: the control plane writes the service's output there and fails to start it otherwise.

`requirements.txt` installs the `kokoro` package, which brings `misaki`. If the PyPI release lags the model, install both from the hexgrad repos instead:

```bash
.venv/bin/pip install "git+https://github.com/hexgrad/misaki.git"
.venv/bin/pip install "git+https://github.com/hexgrad/kokoro.git"
```

`kokoro` needs `espeak-ng` on the system for some words; install it with your package manager (`apt install espeak-ng`, `brew install espeak-ng`).

The weights download to `~/.cache/huggingface` the first time the pipeline loads.

## Settings

| Variable | Default | |
|---|---|---|
| `KOKORO_CORS_ORIGINS` | none | Comma-separated origins allowed to call the server. Unset adds no CORS headers, so the browser refuses every call. `scripts/install.sh` fills it in the registry it seeds |

## Registry

The example registries declare it as:

```json
{
  "id": "tts-kokoro",
  "name": "Kokoro TTS",
  "capabilityId": "tts",
  "hostId": "this-machine",
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
  "lifecycle": {
    "loadStrategy": "demand",
    "autoStart": false,
    "idleUnload": true,
    "idleTimeout": 1800000,
    "startupTime": 90000,
    "restartOnCrash": true,
    "maxRestarts": 3
  }
}
```

`startupTime` covers importing PyTorch, which happens before the server listens.

## Test

With the service running:

```bash
curl -X POST http://localhost:8002/v1/audio/speech \
     -H "Content-Type: application/json" \
     -d '{"input": "Hello from Kokoro.", "voice": "af_heart"}' \
     --output hello.wav
```

Play `hello.wav` with `afplay` on macOS or `aplay` on Linux. Run by hand with `.venv/bin/uvicorn server:app --port 8002`.
