# NeuTTS-Air

- `server.py` and `voices.example.yaml`: an OpenAI-compatible server around the `neutts` package, which loads `neuphonic/neutts-air-q4-gguf` through llama.cpp and `neuphonic/neucodec`.
- `neutts-max-context.patch`: applies to [neuphonic/neutts](https://github.com/neuphonic/neutts) at `857bec0` and makes `max_context` a constructor argument. Upstream's fixed 2048 is too small for longer text, and `server.py` passes `max_context=2048`, which stock `neutts` rejects as an unexpected argument. The package is installed editable from a patched checkout.

Output degrades over long utterances (found in benchmarking), so this adapter suits short replies.

## Install

llama.cpp + NeuCodec, GGUF-quantized Qwen2 0.5B backbone. The example registry port is 8004, with `loadStrategy: "demand"`; give it a generous `startupTime` (120000 ms worked).

```bash
mkdir -p ~/services/tts/neutts-air
cd ~/services/tts/neutts-air

python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt     # the adapter's own dependencies
```

Then install NeuTTS from a patched clone, not stock PyPI:

```bash
git clone https://github.com/neuphonic/neutts
cd neutts
git checkout 857bec0
git apply /path/to/banter/services/tts/neutts-air/neutts-max-context.patch
pip install -e ".[llama]"
```

The `llama` extra brings in `llama-cpp-python`, which loads the GGUF backbone. At `857bec0` the install builds espeak-ng for the phonemizer and bundles it in the package (this needs git, cmake, and a C/C++ compiler); a system espeak-ng (`brew install espeak-ng` on macOS, `apt install espeak-ng` on Debian/Ubuntu) is only the fallback when the bundled library is missing.

Copy `voices.example.yaml` to `voices.yaml` beside `server.py` and point it at your reference audio.

Test:
```bash
curl -X POST http://localhost:8004/v1/audio/speech \
     -H "Content-Type: application/json" \
     -d '{"input": "Hello from NeuTTS.", "voice": "<a voice from voices.yaml>"}' \
     --output - | afplay -
```
(`afplay` is macOS; on Linux pipe to `aplay` or save to a file.)
