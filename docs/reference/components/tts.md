# Text to speech

What turns the agent's reply into audio. Voice mode's active service, model and voice are `voice.tts.selection` in `config.json`, changed through `PATCH /api/voice/selection`, never by editing the file. A TTS service is any registry entry with `capabilityId: "tts"` that answers `/v1/audio/speech`; the roster in the registry says which models and voices it offers.

The repo contains these adapters, which you can register:

| Service | Models | Role |
|---|---|---|
| `fluid-tts` | Pocket-TTS, Kokoro (ANE), LuxTTS | Swift server from the `services/fluid` package, CoreML/ANE |
| `tts-kokoro` | Kokoro-82M | PyTorch server in `services/tts/kokoro`, which runs on Linux |
| `tts-neutts-air` | NeuTTS-Air | PyTorch server in `services/tts/neutts-air`, with voice cloning |

All of them expose OpenAI-compatible `/v1/audio/speech`, so switching between them needs no client change. Install and registry snippets are in [`../setup/tts.md`](../../guide/tts.md) and [`speech-servers.md`](../../guide/speech-servers.md#linux); the registry holds the service definitions, and each entry's `lifecycle` settings say whether it starts at boot or on first use.

`fluid-tts` listens on the port in its entry's `network.port`. It is built against a FluidAudio fork carrying Banter's Pocket-TTS patches, see `services/fluid/patches/README.md`. An upgrade that skips reapplying the patches is silent: the service starts and serves degraded output.

Kokoro-82M measured as the fastest engine and the cheapest to keep resident, which suits it to high-volume output where voice identity does not matter. Cloned voices go to engines that support cloning, such as Pocket-TTS or NeuTTS-Air.

## Voices

Preset voices come with the model. Cloned voices are conditioned on reference clips, held as WAV plus transcript pairs in the directory the registry's roster names, the same set across every cloning engine so quality is comparable between them. [`../setup/voices-and-models.md`](../../guide/voices-and-models.md) describes how a voice, a model and a provider relate.

Kokoro also carries generated voice tensors, converted to `.safetensors` and installed locally. They are not clones: the generator produces a voice embedding directly.

## A trap

**A missing `model` field routes to whichever model is loaded** on a server that hosts several. No error, just the wrong voice answering.

## Request shapes

Request and response shapes are in [`../speech-server-api.md`](../speech-server-api.md).
