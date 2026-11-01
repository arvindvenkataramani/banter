# Kokoro, PyTorch

PyTorch `KPipeline` from the official hexgrad repo, behind an OpenAI-compatible server. Model `hexgrad/Kokoro-82M` (~2.3 GB peak RSS). The example registry port is 8002, demand-loaded. On Apple Silicon, `fluid-tts` runs Kokoro on the Neural Engine and is the lighter route.

## Install

```bash
mkdir -p ~/services/tts/kokoro
cd ~/services/tts/kokoro

python3.12 -m venv .venv
source .venv/bin/activate

pip install -r requirements.txt
```

`requirements.txt` installs the `kokoro` package, which brings `misaki`. If the PyPI release lags the model, install both from the hexgrad repos instead:

```bash
pip install "git+https://github.com/hexgrad/misaki.git"
pip install "git+https://github.com/hexgrad/kokoro.git"
```

`server.py` uses `KPipeline(lang_code="a")` with a generator that yields audio chunks.

Test:
```bash
curl -X POST http://localhost:8002/v1/audio/speech \
     -H "Content-Type: application/json" \
     -d '{"input": "Hello from Kokoro.", "voice": "af_heart"}' \
     --output - | afplay -
```
(`afplay` is macOS; on Linux pipe to `aplay` or save to a file.)
