# Speech server API

Which APIs Banter calls a speech server through, and which the fluid servers provide. Banter calls a service through the APIs its registry entry declares in `provides`, by catalog id, and nothing else; no path or field is inferred from the service's capability or id. Any server that serves one of these APIs, and declares it, can be registered, whatever model or runtime is behind it. The [fluid servers](../../services/fluid/README.md) provide all of what follows, and the Python adapters under [`services/`](../../services/README.md) provide the batch parts.

An API is identified by an id in the catalog, `shared/apis/catalog.json`, which pins the published spec it refers to. A provision lists only how a service departs from that spec; the registry reference is [registry.md](components/registry.md#provides), and the reasoning is in [service-apis.md](design/service-apis.md).

## What Banter calls

Banter calls a fixed set of operations. Each is performed over whichever declared API has an adapter for it.

| Operation | Used for | APIs Banter has an adapter for |
|---|---|---|
| `synthesize` | speaking the agent's reply | `openai.audio.speech` |
| `transcribe` | batch transcription of a whole utterance | `openai.audio.transcriptions` |
| `transcribeStream` | live transcription, where the client decides where an utterance ends | `fluid.stt.stream`, `deepgram.listen.live`, `openai.realtime` |
| `loadModel`, `unloadModel` | bringing a model up or releasing it | `triton.model-repository`, or a call declared under the service's `models` |

A service a roster provider names must provide an API for what it is called for, or the registry does not load. Among streaming APIs Banter prefers one that accepts Opus, when `voice.stt.encodings` puts Opus first, and then one that supports taking over a held session.

## The minimum

A usable server provides:

- `openai.audio.speech` (TTS) or `openai.audio.transcriptions` (STT),
- a way to load a model, if it needs one: `triton.model-repository`, or a `load` call declared under `models` (a model that loads on first request needs neither),
- a health path,
- CORS.

Everything streaming-specific is optional. The dashboard calls `transcribeStream` only when `voice.stt.model` names a model the roster declares as streaming, or as both with streaming preferred.

A server that provides all of this still isn't selectable until the registry's `roster` section declares its models: see [setup/voices-and-models.md](../guide/voices-and-models.md#adding-another-model-or-another-speech-server).

## Every server

**Health.** A `GET` on whatever path you register as `network.healthPath`, answering 2xx once the server is up. The control plane polls it after starting the service.

**CORS.** The browser calls speech servers directly, so each server must allow the dashboard's origin. A refused request surfaces in the browser with no useful explanation.

**Failures.** A non-2xx answer is shown with the server's own text: the body's `error` (a string, or `error.message`), or the raw body when it is not JSON, after the status. A refused load fails the voice start with that text.

## The APIs and their adapters

### `openai.audio.speech`

`POST <base>/audio/speech`, JSON, where `<base>` is the provision's `basePath` or `/v1`. The body is the serving's request parameters first, then `model` (the resolution's), `input`, `voice` and `speed`, and `response_format`.

- `response_format` is always sent: the first value the provision accepts, in its order, that the browser decodes (`mp3`, `aac` or `wav`); without a restriction, the first of those three. The browser decodes the response as that format. A provision that accepts none of them is refused before any request, naming what the service accepts.
- `speed` and `voice` are sent only when the provision implements them.
- A cloned voice is sent as `ref_audio` (a path on the service's machine) and `ref_text`, only to a provision that declares `cloning-reference`; otherwise the request is refused before it is made.
- `stream: true` is sent only with `stream-flag`, when the playback engine wants audio as it renders.

### `openai.audio.transcriptions`

`POST <base>/audio/transcriptions`, multipart: `file` (WAV), `model` when the caller names one, and `response_format`, always: the first of `json` and `verbose_json` the provision accepts. A provision that accepts neither is refused before any request. The answer's `text` is the transcript.

### `fluid.stt.stream`

`WS <base>/v1/audio/stream?model=<key>&format=<opus|pcm16>&chunkMs=<ms>&session=<id>&takeover=1`, the protocol in [`services/fluid/STT.md`](../../services/fluid/STT.md#streaming). `chunkMs` is sent when the provision implements it; `session` is sent when the provision holds take-over and the caller has a session, and `takeover=1` only when the caller asks to take over. Opus is raw packets, one per frame, as WebCodecs produces them; `pcm16` is little-endian Int16 at 16 kHz mono.

One connection carries a conversation, not an utterance: `Finalize` settles the turn and leaves the socket open. The client decides when an utterance ends. A connection that goes quiet keeps its session for thirty minutes, and a dropped one is not resumed. A close in 4001 to 4010 names why:

| code | close | when |
|---|---|---|
| `held` | 4001 | another session holds the socket and the connection did not ask to take over |
| `superseded` | 4002 | another client took over this session |
| `idle` | 4003 | nothing received for thirty minutes |
| `model_not_loaded` | 4004 | no model loaded, or not loaded in a streaming mode |
| `model_mismatch` | 4005 | the named model is unknown, or the roster refuses how it is asked for |
| `busy` | 4006 | the model is busy with other work |
| `bad_format` | 4007 | unknown `format` |
| `bad_audio` | 4008 | a frame could not be decoded |
| `failed` | 4009 | transcription failed for any other reason |
| `replaced` | 4010 | the same session reconnected on a new socket (close only, no error frame) |

Who holds the socket:

| Holder | Newcomer | Result |
|---|---|---|
| none | any | newcomer gets the session |
| id X | id X | newcomer gets it; the old socket is closed `replaced` |
| id X | id Y, or none | refused `held`; the holder keeps it |
| id X | id Y, or none, with `takeover=1` | newcomer gets it; the holder is closed `superseded` |

### `deepgram.listen.live`

`WS <base>/v1/listen`, Deepgram's live channel. Banter connects with `encoding` (`opus` or `linear16`), `sample_rate`, `channels=1`, `interim_results=true` and `endpointing=false` (it never relies on a server's default), and `model` when the provision implements it. It sends `Finalize`, `KeepAlive` and `CloseStream`. Each `Results` is accumulated into the utterance so far, which goes out as a partial, and exactly one final is answered for each `Finalize`. Where the provision declares `finalize-answered` it settles on the result marked `from_finalize`; otherwise on the first such result or after 3000 ms. It sends `session` and `takeover` only with `session-claim`, and Opus only with `opus-packets`.

### `openai.realtime`

`WS <base>/realtime?intent=transcription`, where `<base>` is the provision's `basePath` or `/v1`. The adapter sends `session.update` for a transcription session with turn detection off and 24 kHz PCM input (resampled from the engine's 16 kHz), or 48 kHz Opus input where the provision declares `opus-input`. A finalize is `input_audio_buffer.commit`; one with no audio since the last commit is answered empty without a commit. Deltas are accumulated per item, and finals are released in commit order. Realtime sessions do not load the model they name.

### `triton.model-repository`

`POST <base>/v2/repository/models/{name}/load` with `{"parameters": {...}}` carrying `mode` and `variant` when given and the provision declares `resident-slot`, `POST .../unload`, and `POST <base>/v2/repository/index`. A 200 is success, and a failure is a status with `{"error": ...}`. `{name}` is the serving's key for transcription and for a synthesis runtime that does not resolve voices, and the roster id for one that does.

### A declared call

A service whose load and unload follow no published spec states them under `models.load` and `models.unload` in its registry entry: a method, a path, and query and body templates in which `{model}` stands for the name on the wire.

## What the fluid servers provide

The fluid servers read their own registry entry at startup and refuse to start when it claims an API, or a part of one, that their build does not serve. The provisions below are those in `services/fluid/registry.fluid.example.json`; the file is the source of truth for the exact omissions.

**`fluid-stt`**

| API | Departures |
|---|---|
| `fluid.stt.stream` | none |
| `openai.audio.transcriptions` | omits the request fields it ignores; `response_format` restricted to `json`, `text` and `verbose_json` |
| `deepgram.listen.prerecorded` | omits every query parameter but `model`, `encoding` and `sample_rate`; `encoding` restricted to `linear16` and `flac` |
| `deepgram.listen.live` | omits the parameters and messages it ignores; `encoding` restricted to `opus` and `linear16`; `endpointing` defaults to 700; extends `session-claim`, `finalize-answered`, `endpointing-off` and `opus-packets` |
| `openai.realtime` | only the transcription subset of the client and server events; extends `opus-input` |
| `triton.model-repository` | extends `resident-slot` |

**`fluid-tts`**

| API | Departures |
|---|---|
| `openai.audio.speech` | omits `instructions`; `response_format` restricted to `aac`, `wav` and `pcm`, defaulting to `aac`; extends `cloning-reference` |
| `deepgram.speak` | omits the query parameters it ignores; `encoding` restricted to `aac` and `linear16`; extends `voice-param` and `cloning-reference` |
| `deepgram.speak.live` | `encoding` restricted to `linear16`; extends `voice-param`, `cloning-reference` and `session-claim` |
| `openai.realtime` | only `session.update`, `response.create` and `response.cancel`, in 24 kHz PCM; extends `verbatim-speech` |
| `fluid.tts.stream` | none; the protocol is in [`services/fluid/TTS-STREAM.md`](../../services/fluid/TTS-STREAM.md) |
| `triton.model-repository` | extends `resident-slot` |

Both declare `models: { loading: "required", autoLoad: "always", resident: "one" }`: a request naming a model that is not resident loads it, replacing the one that was.

**Known gaps** in what they claim:

- Deepgram's own model names are not served. `model` is a serving's key (listen) or a roster id (speak).
- A listen answer to an empty `Finalize` is marked `from_finalize` but not `is_final`.
- Deepgram's deprecated `Error.code` is not sent.
- A Realtime speech session that names no model speaks with the resident model, else the roster's first.
- On `fluid-tts` a socket's claim covers the connection, while synthesis takes the resident slot per span, so a load that would change the model waits behind a streaming response and is refused with 409 at the slot's deadline.
- The index of `triton.model-repository` sends no `version`.
- A `timestamp_granularities` value of `segment` is not implemented, and is omitted in the provision.

The Banter adapters for `deepgram.speak`, `deepgram.speak.live`, `openai.realtime` speech and `fluid.tts.stream` are not built; Banter does not call those routes.
