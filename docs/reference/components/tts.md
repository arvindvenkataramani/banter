# Text to speech

What turns the agent's reply into audio. Voice mode's active service, model and voice are `voice.tts.selection` in `config.json`, changed through `PATCH /api/voice/selection`, never by editing the file. A TTS service is any registry entry with `capabilityId: "tts"` whose `provides` lists an API Banter can synthesize through (`openai.audio.speech`); the entry says how the service departs from that API ([`provides`](registry.md#provides)), and the roster in the registry says which models and voices it offers.

The repo contains these adapters, which you can register:

| Service | Models | Role |
|---|---|---|
| `fluid-tts` | Pocket-TTS, Kokoro (ANE), LuxTTS | Swift server from the `services/fluid` package, CoreML/ANE |
| `tts-kokoro` | Kokoro-82M | PyTorch server in `services/tts/kokoro`, which runs on Linux |
| `tts-neutts-air` | NeuTTS-Air | PyTorch server in `services/tts/neutts-air`, with voice cloning |

All of them serve `openai.audio.speech`, each declaring its departures (the formats it encodes, whether it clones from a reference recording, whether it needs a flag to stream), so switching between them needs no client change. Install and registry snippets are in [`../setup/tts.md`](../../guide/tts.md) and [`speech-servers.md`](../../guide/speech-servers.md#linux); the registry holds the service definitions, and each entry's `lifecycle` settings say whether it starts at boot or on first use.

`fluid-tts` listens on the port in its entry's `network.port`. It is built against an exact upstream FluidAudio release, 0.18.4. A FluidAudio change in Pocket-TTS fails silently: the service starts and serves degraded output, so `services/fluid/verification/README.md` lists what to check before the version changes. It reads the roster from the registry itself (`resolvesVoices: true`), serves Kokoro as the model `kokoro-82m` under the key `kokoro-ane`, and answers `response_format` of `aac` (the default its entry declares), `wav` or `pcm` (headerless 16-bit mono, 24 kHz). It streams every response that can stream, with no flag, and sends the same audio as server-sent events for `stream_format: "sse"`.

Kokoro-82M measured as the fastest engine and the cheapest to keep resident, which suits it to high-volume output where voice identity does not matter. Cloned voices go to engines that support cloning, such as Pocket-TTS or NeuTTS-Air.

## Voices

Preset voices come with the model: a voice's preset rendering carries the model's own key for her. Cloned voices are conditioned on a voice's recordings, held as audio plus transcript pairs the registry's roster names, the same set across every cloning engine so quality is comparable between them; a clone rendering links a voice to each model that should use them. [`../setup/voices-and-models.md`](../../guide/voices-and-models.md) describes how a voice, a model and a provider relate.

Kokoro also carries generated voice tensors, converted to `.safetensors` and installed locally. They are not clones: the generator produces a voice embedding directly.

## A trap

**A missing `model` field routes to whichever model is loaded** on a server that hosts several. No error, just the wrong voice answering.

## Calling a service

The speech call is the `synthesize` operation through the speech adapter. It sends the resolution the control plane served for the selection (the model as the runtime names it, the voice by name or by recording, the serving's request parameters) and the first audio format the provision accepts that the browser decodes (mp3, aac or wav). A cloned voice goes as a reference recording only to a service that declares `cloning-reference`, and `stream: true` only to one that declares `stream-flag`. Request and response shapes, and which APIs each built server provides, are in [`../speech-server-api.md`](../speech-server-api.md).

`fluid-tts` also provides `deepgram.speak` and `deepgram.speak.live`, Realtime speech (`openai.realtime`, which speaks the text of a `response.create` as written and runs no model) and its own socket, `fluid.tts.stream`. Banter calls none of them yet. A `model` parameter on a Deepgram speak route is a roster model id and the voice is a separate `voice` parameter; a Realtime session with no model named speaks with the resident model, else the roster's first. On `fluid-tts` a socket's claim covers the connection while synthesis takes the resident slot per span, so a load that would change the model waits behind a streaming response and is refused with 409 at the slot's deadline, where `resident-slot` on the STT server refuses it at once while a session holds the server.
