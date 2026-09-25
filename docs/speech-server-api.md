# Speech server API

What Banter's dashboard calls on a speech server. Any server that answers these routes in this shape can be registered, whatever model or runtime is behind it. The [fluid servers](../services/fluid/README.md) implement all of it; the Python adapters under [`services/`](../services/README.md) implement the batch parts.

Taken from what the dashboard actually sends, not from a general OpenAI-API description.

## The minimum

A usable server needs only:

- batch transcription (STT) or synthesis (TTS),
- `POST /v1/models?model_name=<id>` (TTS),
- a health path,
- CORS.

Everything streaming-specific is optional. The dashboard only uses the STT model-load calls and the streaming socket when `voice.stt.model` is set; with it unset, it transcribes in batch and never calls them.

A server that answers all of this still isn't selectable until the registry's `roster` section declares its models: see [voices-and-models.md](voices-and-models.md#adding-another-model-or-another-speech-server).

## Every server

**Health.** A `GET` on whatever path you register as `network.healthPath`, answering 2xx once the server is up. The control plane polls it after starting the service.

**CORS.** The browser calls speech servers directly, so each server must allow the dashboard's origin. A refused request surfaces in the browser with no useful explanation.

## Text-to-speech

### Synthesis

`POST {endpoint}/v1/audio/speech`, JSON body `{ model, input, voice, speed, stream, response_format, ...extra }` ([`playback-engine.ts`](../dashboard/src/lib/voice/system/playback-engine.ts)).

`response_format` is the roster provider's `responseFormat`, `mp3` when absent. The dashboard decodes the response as that format, so it has to match what the server returns. A server that can't produce the requested format should refuse the request rather than return another format.

### Model load and unload

`POST {endpoint}/v1/models?model_name=<id>` is called once when a voice session starts, before the first synthesis request ([`voice-service.ts`](../dashboard/src/lib/voice/voice-service.ts)). A failure here fails the session start with a "Voice failed to start" notice, so a TTS server without this route can't be used for voice.

`DELETE {endpoint}/v1/models?model_name=<id>` is sent when the selected model changes in the settings dialog, not at session end. Its failure is ignored: a server without it still works, but is never told to release the old model.

## Speech-to-text

### Batch transcription

`POST {endpoint}/audio/transcriptions`, multipart, with a `file` field carrying WAV audio ([`stt-client.ts`](../dashboard/src/lib/voice/human/stt-client.ts)). OpenAI-compatible servers usually answer under `/v1/audio/transcriptions` as well; the dashboard uses the bare path.

The response is JSON with a `text` field. `fluid-stt` also takes `response_format` (`text`, `verbose_json`) and `timestamp_granularities[]=word` for word timings, and treats an optional `model` field as an assertion: naming a model other than the loaded one is refused (409), never switched to.

### Model facts

`GET {endpoint}/v1/models`, read before loading. The OpenAI-style `data` array, where the entry whose `id` is the configured model may carry:

| Field | Meaning |
|---|---|
| `kind` | `batch`, `streaming`, or `both` — what the model can do |
| `transport` | `["http"]`, `["websocket"]`, or both — how it is reached |
| `present` | whether its weights are already on disk; a load of an absent model downloads them first |
| `params` | declared parameters, e.g. `{ "name": "chunkMs", "values": [560, 1120, 2240] }` |

Any field left out is treated as unknown, not as a default. A model of kind `both` is streamed or batched according to `voice.stt.preferStreaming`.

### Model load

`POST {endpoint}/v1/models/load`, JSON `{ model, mode?, chunkMs? }`, before the first utterance. `mode` (`batch` or `streaming`) is sent for a model of kind `both`; `chunkMs` picks a streaming latency tier where the model declares one. A server should refuse a load it can't honour (400) rather than pick for the caller, and refuse with 409 while it is busy with other work.

Once loaded, a model stays loaded until another load replaces it: a transcription or socket naming a model that isn't loaded is refused, not loaded on the fly.

## Streaming transcription

`WS {endpoint}/v1/audio/stream?model=<id>&format=<opus|pcm16>&session=<id>&takeover=1` ([`stt-socket.ts`](../dashboard/src/lib/voice/human/stt-socket.ts)). Used when the model's `kind` is `streaming` or `both` and streaming is preferred.

The model must already be loaded in a mode that serves streaming; the socket never loads one. `model` names the model the client believes is loaded.

### Audio

Binary frames carry audio; text frames carry control.

- **`opus`** (the dashboard's default where the browser can encode it) — raw Opus packets, one per frame, as WebCodecs `AudioEncoder` produces them. Not the WebM that `MediaRecorder` emits.
- **`pcm16`** (the fallback) — raw little-endian Int16, 16 kHz mono.

### Who holds the socket

One streaming session is live at a time. `session` is the client's own id, which lets a reconnect be recognised; `takeover=1` asks to displace another client.

| Holder | Newcomer | Result |
|---|---|---|
| none | any | newcomer gets the session |
| id X | id X | newcomer gets it; the old socket is closed `replaced` |
| id X | id Y, or none | refused `held`; the holder keeps it |
| id X | id Y, or none, with `takeover=1` | newcomer gets it; the holder is closed `superseded` |

### Frames

| Direction | Frame | Meaning |
|---|---|---|
| → | binary | one audio frame in the declared format |
| → | `{"type":"Finalize"}` | end of utterance: send the final transcript and stay open for the next one |
| → | `{"type":"CloseStream"}` | send the final transcript, then close |
| → | `{"type":"KeepAlive"}` | the client is still there; never answered |
| ← | `{"type":"ready","model":…,"format":…}` | session open |
| ← | `{"type":"transcript","is_final":false,"text":…}` | the whole transcript so far, sent when it changes. It may still change; render the latest |
| ← | `{"type":"transcript","is_final":true,"text":…,"words":[…]}` | after `Finalize` or `CloseStream`: settled, with word timings |
| ← | `{"type":"error","code":…,"message":…}` | followed by a close with the matching code |

One connection carries a conversation, not an utterance: `Finalize` resets the session for the next turn and leaves the socket open. The client decides when an utterance ends — Banter's VAD and turn detection make that call, and the server doesn't second-guess it.

A connection that goes quiet keeps its session for up to thirty minutes. Any frame, `KeepAlive` included, resets that clock. A dropped connection is not resumed: reconnecting starts a new session, and the words since the last `Finalize` are lost.

### Error codes

| code | close | when |
|---|---|---|
| `held` | 4001 | another session holds the socket and the connection did not ask to take over |
| `superseded` | 4002 | another client took over this session |
| `idle` | 4003 | nothing received for thirty minutes |
| `model_not_loaded` | 4004 | no model loaded, or not loaded in a streaming mode |
| `model_mismatch` | 4005 | the named model is not the loaded one |
| `busy` | 4006 | the model is busy with other work |
| `bad_format` | 4007 | unknown `format` |
| `bad_audio` | 4008 | a frame could not be decoded |
| `failed` | 4009 | transcription failed for any other reason |
| `replaced` | 4010 | the same session reconnected on a new socket (close only, no error frame) |
