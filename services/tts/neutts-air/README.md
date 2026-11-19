# NeuTTS-Air

- `server.py` and `voices.example.yaml`: an OpenAI-compatible server around the `neutts` package, which loads `neuphonic/neutts-air-q4-gguf` through llama.cpp and `neuphonic/neucodec`.
- `neutts-max-context.patch`: applies to [neuphonic/neutts](https://github.com/neuphonic/neutts) at `857bec0` and makes `max_context` a constructor argument. Upstream's fixed 2048 is too small for longer text, and `server.py` passes `max_context=2048`, which stock `neutts` rejects as an unexpected argument. The package is installed editable from a patched checkout.

Output degrades over long utterances (found in benchmarking), so this adapter suits short replies.

## Install

llama.cpp + NeuCodec, GGUF-quantized Qwen2 0.5B backbone. Banter does not install it: you create the environment below on the machine that runs it. The docs use port 8004 and `loadStrategy: "demand"`; give it a generous `startupTime` (120000 ms is a reasonable value).

```bash
mkdir -p ~/services/tts/neutts-air/logs
cp server.py requirements.txt voices.example.yaml ~/services/tts/neutts-air/   # from this folder
cd ~/services/tts/neutts-air

python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt     # the adapter's own dependencies
```

The `logs` folder has to exist: the control plane writes the service's output there and fails to start it otherwise.

Then install NeuTTS from a patched clone, not stock PyPI, into the same environment:

```bash
git clone https://github.com/neuphonic/neutts
cd neutts
git checkout 857bec0
git apply /path/to/banter/services/tts/neutts-air/neutts-max-context.patch
~/services/tts/neutts-air/.venv/bin/pip install -e ".[llama]"
```

The `llama` extra brings in `llama-cpp-python`, which loads the GGUF backbone. At `857bec0` the install builds espeak-ng for the phonemizer and bundles it in the package (this needs git, cmake, and a C/C++ compiler); a system espeak-ng (`brew install espeak-ng` on macOS, `apt install espeak-ng` on Debian/Ubuntu) is only the fallback when the bundled library is missing.

Copy `voices.example.yaml` to `voices.yaml` beside `server.py` and point it at your reference audio.

## Settings

| Variable | Default | |
|---|---|---|
| `NEUTTS_CORS_ORIGINS` | none | Comma-separated origins allowed to call the server. Unset adds no CORS headers, so the browser refuses every call. `scripts/install.sh` fills in any `*_CORS_ORIGINS` variable in the registry it seeds; a service added later needs it set by hand |

## Registry

```json
{
  "id": "tts-neutts-air",
  "name": "NeuTTS Air",
  "capabilityId": "tts",
  "hostId": "this-machine",
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
  "lifecycle": { "loadStrategy": "demand", "idleUnload": true, "idleTimeout": 1800000, "startupTime": 120000 }
}
```

[docs/guide/tts.md](../../../docs/guide/tts.md#neutts-air) has the matching `roster.providers` entry and `config.json` selection.

## Test

With the service running:

```bash
curl -X POST http://localhost:8004/v1/audio/speech \
     -H "Content-Type: application/json" \
     -d '{"input": "Hello from NeuTTS.", "voice": "<a voice from voices.yaml>"}' \
     --output - | afplay -
```
(`afplay` is macOS; on Linux pipe to `aplay` or save to a file.)
