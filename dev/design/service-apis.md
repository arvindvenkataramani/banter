# Service APIs: how Banter knows how to call a service

Banter knows how to call a service from declarative information stored explicitly in the service registry, and from nothing else. Every fact a client uses to choose an adapter and build a call (which API the service serves, where, and how the service departs from that API's published spec) is readable from the service's registry entry and the API declarations that entry references. Nothing is inferred from `capabilityId`, from a service's id, or from a convention the registry does not state.

Banter here means the voice-chat client and everything in it that calls a speech or model service: the `voice-engine` package, the dashboard, and the shard's media jobs. The control plane resolves voices for a runtime on its own host and sends that runtime nothing.

Research behind this record: [`dev/analysis/service-api-binding.md`](../analysis/service-api-binding.md).

## Requirements

Set by Arvind; every section below answers to them.

**An API declaration is an id and a pinned reference to the API's published spec, and nothing that restates it.** "This service provides this API, whose reference is here" is the whole of the declaration; the adapter implements the API from its spec. Which APIs our servers ship is an upstream decision. Fluid's own `openapi.yaml` is generated in order to implement those APIs, and is never the reference for them.

**Defaults are the spec's; a provision records deviations.** Our servers behave as the published spec says unless they declare otherwise. A provision lists only how its service departs from the API's spec: omissions (parts not implemented), restrictions (narrower accepted values) and extensions (additions beyond the spec). A provision listing none claims full conformance. Banter detects every deviation from the declarations alone.

**Facts and preferences are declared outright and reasoned about.** Model facts stay on the model in the roster: an STT model's `kind`, a serving's `streaming` and `realtime`, cloning. A service declares whether its models need loading and whether it loads a model a request names by itself; a declaration that loading is needed tells Banter to find the load call among the service's declared APIs, which are ordinary APIs with references and no special family. Preloading is a Banter preference, weighed against those declarations to choose between loading explicitly and letting the service load on first use.

**Streaming is a conjunction of declared facts.** The model can stream (roster), the service provides a streaming API (provision), and that API's behaviour on this service is the spec's default or a declared deviation, including whether it segments on its own. Banter's `preferStreaming` chooses when both streaming and batch are possible.

**The voice loop calls abstract operations only.** The adapter is chosen from the declarations. Today's streaming socket client becomes the adapter for fluid's own protocol, beside adapters for the standard APIs.

**Fluid supports the standard APIs, batch and streaming, out of the box, and drops nothing.**

| | OpenAI batch | OpenAI streaming | Deepgram batch | Deepgram streaming | Fluid's own |
|---|---|---|---|---|---|
| `fluid-stt` | `/v1/audio/transcriptions` | `/v1/audio/transcriptions` with `stream=true`; Realtime in transcription mode | `POST /v1/listen` | WebSocket `/v1/listen`, conforming to Deepgram's spec | `/v1/audio/stream`, declared |
| `fluid-tts` | `/v1/audio/speech` | `/v1/audio/speech` streamed and `stream_format=sse`; Realtime TTS, speaking `response.create` input verbatim as Kokoro-FastAPI does | `POST /v1/speak` | WebSocket `/v1/speak` | `/v1/audio/stream`, declared |

Realtime is implemented as a declared subset on each server; the conversational mode, which runs a model, is not.

**Opus is preserved.** Opus input matters for home setups. Fluid's own protocol and the Deepgram live route carry it; on Realtime it is a declared extension. Banter's preference for Opus selects among provisions that accept it.

**Process.** Formal: design approval, then tests, plan, build, separate verification. Mac-side work is handed to the Mac's Claude Code as steps; the record states dependencies, and the build order is settled in the plan.

## What is there now

A service entry records what the service does (`capabilityId`), where it listens (`network`) and how it is run. The interface is inferred from the capability. The browser engine posts synthesis to `/v1/audio/speech` on whichever TTS runtime is selected, posts batch transcription to `/audio/transcriptions` with no version prefix, and opens `/v1/audio/stream` for streaming transcription, a socket protocol only `fluid-stt` serves. The shard's media jobs post to `/v1/audio/speech`. The dashboard loads models through `POST /v1/models?model_name=` for synthesis and `POST /v1/models/load` for transcription, and calls `/v1/chat/completions` from a client written for LM Studio alone.

Three partial declarations exist. The roster's providers carry `responseFormat` and `sessions`, which describe how a runtime departs from an unstated base API. `shared/types.ts` defines `TtsOperation` and `TtsServiceInfo` for a service's `/info` route, which the control plane and shard proxy and nothing reads. And the speech request is built in OpenAI's field names on the server (`buildSpeechRequest`) and served to the browser as `selection.request`, so the wire shape is fixed before any client code runs.

Several calls sent to "OpenAI-compatible" routes are not OpenAI's. `stream: true` on a speech request is mlx-audio's flag; OpenAI's route streams its bytes unasked and offers `stream_format` for SSE. `ref_audio` and `ref_text` are cloning fields no vendor defines. Each is sent to every runtime on the strength of the capability alone.

The fluid servers serve more than Banter calls. `fluid-stt` answers Deepgram's `/v1/listen` over POST and WebSocket, written against a third-party client's parser; `fluid-tts` has a `/v1/audio/stream` socket no client uses.

## The model

| Thing | What it is | Declared in |
|---|---|---|
| **Operation** | Something Banter does with a service, stated without wire detail | Banter's code: a fixed set |
| **API** | A named interface with a published spec | The API catalog: an id and a pinned reference |
| **Provision** (service × API) | This service serves this API, with these departures from its spec | The service's `provides` list in the registry |
| **Adapter** | The code that performs operations over one API, written from that API's spec | Banter's code: one per API id |
| **Preference** | What Banter would rather have where the declarations leave a choice | `config.json` |

A caller holds an operation, a service id and Banter's preferences. It reads the service's provisions, keeps those whose API has an adapter that performs the operation, drops any whose declared deviations remove something the call needs, ranks the rest by preference, and hands the winner's provision to its adapter. A service left with no provision is refused, with a message naming the service, the operation and what the service declares.

## Operations

**Role**: Banter's own vocabulary for what it asks of a service. The voice loop, the playback engine and the media jobs call these and never a path.

**Ownership**: the set of operations, each one's inputs and outputs in Banter's terms, and the guarantees a caller may rely on whichever API serves it.

| Operation | Capability | In | Out | Called by |
|---|---|---|---|---|
| `synthesize` | `tts` | text, model, a resolved voice, speed, an audio format | audio in that format, delivered as it renders where the declarations allow | the playback engine, the shard's media jobs |
| `transcribe` | `stt` | a whole recording, optionally a model | the transcript | the batch STT transport |
| `transcribeStream` | `stt` | a session: audio frames, finalize, keep-alive, close | the utterance so far whenever it changes; one settled transcript per finalize, in order, including an empty one; a coded close | the streaming STT transport |
| `synthesizeStream` | `tts` | a session: text spans, flush, clear, close | audio frames, flush and clear acknowledgements | nothing yet |
| `chat` | `llm` | messages, model, sampling parameters | a completion | the dashboard's LM Studio client |
| `loadModel`, `unloadModel` | any | a model, and for `loadModel` its mode or variant | done, or a refusal | the voice system |

A resolved voice is what the voice resolution rule in [`docs/design/model-roster.md`](../../docs/design/model-roster.md) returns: the model as the runtime knows it, and either a voice name or a recording with an optional transcript. Cloning is a form of `synthesize`'s voice input. Listing voices and models is not an operation, since the roster declares both.

The guarantees are the adapter's to produce. `transcribeStream` promises the whole utterance in each partial and exactly one final per finalize; where an API sends incremental deltas, or settles text in segments on its own schedule, its adapter accumulates and answers the finalize once.

The agent conversation is outside this set. It travels through the OpenClaw gateway, which is not a registry service.

## The API catalog

**Role**: the list of interfaces a service can be said to provide.

**Ownership**: each API's id, its name, and the reference to its published spec. Nothing else: no path, field, message or enumeration is written here, because the spec states them and a copy would be a second statement of the same fact.

```
id          deepgram.listen.live
name        Deepgram live transcription
reference   { document, revision, part }
```

`document` is the spec's address, `revision` what pins it, and `part` the operation, channel or section within it. A spec kept in a repository is pinned by commit. One that is regenerated in place or published only as pages, as Deepgram's served documents and OpenAI's Realtime reference are, is pinned by its address, the date read and a hash of the content, so a later change is detectable without keeping a copy. Deepgram's AsyncAPI document as read for this record is `https://developers.deepgram.com/asyncapi.yaml` on 2026-11-24, SHA-256 `d3bdcf2771c450d70a2610fffe001c0cf1e9110787fbfee211f53ff59fdda73f`.

**Key logic**: the catalog is one data file in the shared package, beside `shared/types.ts`, so the browser engine, the control plane and the shard read the same ids and the engine's import boundary holds. It ships with the adapters because an adapter and the revision it was written from change together. The catalog holds the APIs of services Banter calls. A service Banter does not call declares nothing, and nothing in this design describes its interface.

An API is the unit one adapter implements and one service can serve apart from any other. OpenAI's speech route and its transcription route are two APIs; Deepgram's `/v1/listen` over a WebSocket and over POST are two.

| API id | Reference | Performs |
|---|---|---|
| `openai.audio.speech` | `openai/openai-openapi`, `createSpeech` | `synthesize` |
| `openai.audio.transcriptions` | `openai/openai-openapi`, `createTranscription` | `transcribe` |
| `openai.chat.completions` | `openai/openai-openapi`, chat completions | `chat` |
| `openai.realtime` | OpenAI's Realtime client-event and server-event reference pages | `transcribeStream`, `synthesizeStream` |
| `deepgram.listen.prerecorded` | `deepgram/deepgram-api-specs`, OpenAPI `POST /v1/listen` | `transcribe` |
| `deepgram.listen.live` | `deepgram/deepgram-api-specs`, AsyncAPI channel `/v1/listen` | `transcribeStream` |
| `deepgram.speak` | `deepgram/deepgram-api-specs`, OpenAPI `POST /v1/speak` | `synthesize` |
| `deepgram.speak.live` | `deepgram/deepgram-api-specs`, AsyncAPI channel `/v1/speak` | `synthesizeStream` |
| `fluid.stt.stream` | `services/fluid/STT.md`, Streaming | `transcribeStream` |
| `fluid.tts.stream` | a protocol reference in `services/fluid`, written from the socket's source | `synthesizeStream` |
| `triton.model-repository` | Triton's model repository extension to the Open Inference Protocol, `docs/protocol/extension_model_repository.md` in `triton-inference-server/server` | `loadModel`, `unloadModel` |

The last column is a fact about Banter's adapters, held with them and repeated here for reading.

An id's first part names whoever established the interface, as `triton.model-repository` names the project whose extension other servers copy. No entry names a runtime registered here: a runtime appears in its own registry entry and nowhere else.

### Extensions

An extension is an addition beyond an API's spec that more than one service may share. It is declared as an API is, by an id and a reference to where it is described, and a provision names it.

| Extension | Adds | Reference |
|---|---|---|
| `session-claim` | `session` and `takeover` query parameters at connect, and close codes 4001 to 4010 naming why a connection was refused or displaced | `services/fluid/STT.md`, Streaming |
| `cloning-reference` | `ref_audio`, a path on the service's own machine, and `ref_text` | a section of this record's successor in `docs/design/` |
| `stream-flag` | `stream: true` on a speech request asks for audio as it renders | mlx-audio's server |
| `opus-input` | on Realtime, an Opus input format: each `input_audio_buffer.append` carries one raw Opus packet, base64-encoded as the spec encodes PCM | a section of this record's successor |
| `voice-param` | a `voice` parameter at connect, where the spec selects a voice through `model` alone | a section of this record's successor |
| `verbatim-speech` | on Realtime, `response.create` speaks the text of its `input_text` parts as written and runs no model | Kokoro-FastAPI's Realtime router |
| `finalize-answered` | every `Finalize` is answered by exactly one result marked as answering it, including an empty one | `services/fluid/STT.md` |
| `endpointing-off` | `endpointing=false` stops the server closing utterances on its own | `services/fluid/STT.md` |
| `opus-packets` | with `encoding=opus`, each binary message is one raw Opus packet | `services/fluid/STT.md`, Audio formats |
| `resident-slot` | on the model repository API: `mode` and `variant` as load parameters; a load of what is already resident changes nothing; a load replaces the one resident model; a load that would change the model, and an unload, are refused while a session holds it | `services/fluid/STT.md`, Models |

**Behaviour a spec leaves unstated, and Banter relies on, is a declared extension.** A spec's silence is not a default to assume. `finalize-answered`, `endpointing-off` and `opus-packets` each name something Deepgram's document does not say and the voice loop needs; a service that does not declare one is not relied on for it.

## Provisions

**Role**: a service's statement of which APIs it serves and how it departs from each.

**Ownership**: for one service and one API, where the API sits if not where its spec puts it, the three kinds of deviation, and any default the service sets differently from the spec.

```
services[].provides   [ { api, basePath?, omits?: [name], only?: [name], restricts?: { parameter → [values] },
                          defaults?: { parameter → value }, extends?: [extension id] } ]
```

**Key logic**: a provision of `{ api }` alone claims the service behaves as the reference says, at the path the reference gives. Everything else is a departure.

- `basePath` is stated only when the service mounts the API somewhere other than the path of the spec's own server address, which is `/v1` for OpenAI's REST routes and the root for Deepgram's.
- `omits` names parts of the spec the service does not implement, in the spec's own spelling and qualified by kind: a parameter, a parameter value, a client or server message, a field of one, a session mode. `only` states the same thing by complement where a service implements a small subset, as every Realtime server does: the client messages or modes listed are implemented and every other is omitted.
- `restricts` narrows a parameter to the values this service accepts, in its order of preference.
- `defaults` gives the value the service uses for a parameter a client leaves out, where that differs from the spec's default. It stands beside the three kinds of deviation as a fourth thing a provision may state.
- `extends` lists extension ids.

**A declared default is the setting, for a server the platform builds.** The server reads its own provisions at startup and takes each `defaults` value as its default for that parameter, holding none in its source. `fluid-stt`'s listen route declares `defaults: { endpointing: 700 }` against the 10 in Deepgram's document, which is too short a silence for a local model, and changing the number in the registry entry changes the server's behaviour at its next start. The declaration and the configuration are one entry, so they cannot disagree. It lives in the registry because it is a fact about the service process. For a runtime the platform does not build, `defaults` is the platform's statement of what that runtime does.

The names in `omits`, `only` and `restricts` point into the reference and restate nothing: they say which of the spec's parts are missing and leave what those parts are to the spec.

**How Banter detects a deviation.** Each adapter states, beside its code, the parts of its API it requires for each operation and the parts it uses when present. A provision that omits a required part, or restricts a required parameter to values the call cannot use, is not a candidate for that operation. One that omits an optional part is a candidate, and the adapter does without.

**What an API offers is declared by its adapter, never read off its id.** Selection asks questions of a candidate: does the client decide where an utterance ends, can a session be taken over, is Opus accepted, does audio arrive as it renders, does a request naming a model load it. Each adapter declares its answers as capabilities, and for each capability the part of the reference or the extension it rests on. The `fluid.stt.stream` adapter declares take-over resting on the `session` and `takeover` parameters its reference defines; the `deepgram.listen.live` adapter declares it resting on `session-claim`. A capability holds for a provision when the part it rests on is neither omitted nor restricted away, or the extension is declared. No rule anywhere names an API or a service.

A requirement may be an extension. The `openai.realtime` adapter requires `verbatim-speech` for `synthesizeStream`, because the spec's `response.create` runs a model and a service conforming in full would answer the text instead of reading it; such a service is no candidate for that operation. An extension the adapter does not know changes nothing, and one it knows is used only when declared: `ref_audio` goes to no service that does not declare `cloning-reference`, and a resolved voice that is a recording is refused before any request where no candidate declares it.

**A provision belongs to the service entry, not to the roster.** The roster declares models, voices and which runtime serves which; an interface is a fact about the process whatever models it holds, and it applies to services the roster never mentions.

**The registry is the only declaration.** A service does not also announce its APIs at a route of its own, since a second source can disagree with the first and an external runtime cannot be made to serve one. The servers the platform builds read their own registry entry at startup, as they already read their roster section, and refuse to start when it claims more than their build implements: an API they do not serve, or a part they lack that the entry does not list as omitted.

**Relationships**: the shard and the control plane serve `provides` with each service in `/api/services`. `GET /api/voice` carries the provisions of every TTS provider and STT option, which is how the browser engine learns them, with the catalog it already imports. A shard service bound to loopback is reached by the browser through the shard's `/svc/<id>` route, so a provision's base path is appended to that endpoint, and every WebSocket route a provision declares passes through the shard's forwarder with its query parameters and close codes intact. A registry reload that changes a running fluid server's `provides` reaches it only on restart, and the reload's warnings name the server, as they do for a roster change.

## Model loading

**Role**: the declared facts from which Banter decides whether to load a model itself.

### What a service declares

A service entry states its loading facts under `models`:

```
models   { loading: required | none,
           autoLoad: always | never,
           resident: one | many,
           load?:   { method, path, query?, body? },
           unload?: { method, path, query?, body? } }
```

- `loading` is `required` when a model must be resident before it can work, and `none` when the service has nothing to load.
- `autoLoad` is what a request naming a model that is not resident does. `always` loads it. `never` leaves loading to an explicit call.
- `resident` is how many models the service holds. With `one`, a load replaces what was resident. With `many`, models accumulate until each is unloaded.
- `load` and `unload` declare the explicit calls of a runtime that publishes no spec for them, as data: a method, a path, and query and body templates in which `{model}` stands for the runtime's own key for the model, the serving's `key`. One generic adapter runs a declared call. This states a call nobody else has written down; it restates no spec, since there is none to reference. A service whose explicit calls follow a published spec declares none here and provides that API instead.

### The servers the platform builds

The fluid servers load on request, and say so. Both declare `always` and `one`: a call that names a model the server does not hold loads it, with no explicit call first, and the model that was resident is replaced.

For `fluid-tts` that is the whole rule. For `fluid-stt` it meets the session, which holds the server exclusively:

- A request loads the model it names in the mode its route needs: batch for a transcription, streaming for a session. A model resident in one mode gains the other when a request needs it. A request naming no model uses the resident one, or loads the roster's `defaultModel` into an empty server.
- With another model resident and no session open, a request naming a different one replaces it. Requests run one at a time, so the replacing load starts only after work already in flight has finished.
- While a session holds the server, every other request is refused at once, whatever model it names, as is an explicit load that would change the model, and an unload. Nothing displaces a session's model while the session lasts. A take-over is the only way in: it ends the holder's session, and the newcomer's model then loads as any request's would.
- A model with variants, a latency tier, loads on a request only when the request names the variant; the server never chooses one. Fluid's own stream protocol carries it. No vendor API has a field for it, so over those such a model is loaded explicitly first.

This changes `fluid-stt`, which refuses a request naming a model other than the resident one. The work is on the Mac, and [`docs/components/stt.md`](../../docs/components/stt.md) and [`docs/design/fluid-stt-on-demand-load.md`](../../docs/design/fluid-stt-on-demand-load.md) are updated when it ships.

Explicit load and unload stay, for bringing a model up before it is needed and for freeing memory. Both fluid servers provide them as `triton.model-repository` with `resident-slot`: `POST /v2/repository/models/{name}/load`, with `mode` and `variant` in the request's `parameters` object, `POST /v2/repository/models/{name}/unload`, and `POST /v2/repository/index` for what is resident. These take the place of the load and unload routes the servers answer now.

The Open Inference Protocol and this extension, as read on 2026-11-24:

- The Open Inference Protocol is KServe's v2 inference protocol, maintained in `kserve/open-inference-protocol` with a prose REST specification, an OpenAPI document and a gRPC definition (read at commit `d49cc23`). Triton, Seldon MLServer, OpenVINO Model Server, TorchServe and AMD's inference server are listed as adopters.
- The core protocol covers liveness, readiness, server and model metadata, and tensor inference. It has no load or unload. Its only word on loading is the model-ready probe, `GET /v2/models/{name}/ready`, which answers whether the model is loaded and able to serve. It says nothing of loading on demand.
- Of extensions the core says "Currently, no standard extensions are defined. Individual inference servers may define and document their own." The model repository routes are Triton's extension, which a server advertises as `model_repository` in its metadata. Triton's document is prose, read at commit `81794dd`. MLServer serves the same three routes and publishes an OpenAPI document for them whose descriptions are Triton's text; its load route takes no body.
- A load request's body is `{"parameters": {…}}`, key and value pairs, of which Triton defines `config` and `file:` entries. A load of a loaded model reloads it. Success is a 200 and failure a status with `{"error": …}`. The index returns each model's `name`, `state` and `reason`.
- No speech or LLM server among those the analysis examined was found to implement it. That was not searched further.

It fits as fluid's explicit load API because it is the one load and unload interface published with more than one implementation, and its `parameters` object is where a mode and a variant can travel. It does not fit unmodified, which is what `resident-slot` declares: fluid's parameters are its own, and a load of what is resident is a no-op where Triton reloads, since a reload costs about thirteen seconds and voice mode on a second device loads before it takes over. The tensor inference routes of the core protocol are not served, and the catalog entry references the extension alone.

### Runtimes the platform cannot change

`tts-mlx-audio` and `lm-studio` publish no spec for loading, so their entries declare the calls.

```
tts-mlx-audio   models { loading: required, autoLoad: always, resident: many,
                         load:   { method: POST,   path: /v1/models, query: { model_name: "{model}" } },
                         unload: { method: DELETE, path: /v1/models, query: { model_name: "{model}" } } }
lm-studio       models { loading: required, autoLoad: always, resident: one,
                         load:   { method: POST, path: /api/v1/models/load,   body: { model: "{model}" } },
                         unload: { method: POST, path: /api/v1/models/unload, body: { instance_id: "{model}" } } }
```

mlx-audio loads a model a request names and keeps the one it held, which is why it is `many`. LM Studio's documentation describes just-in-time loading and auto-evict, both on by default: a request naming a model loads it and unloads the one loaded that way before. Both are settings in the LM Studio app, so the entry states how this install is set.

### When Banter makes an explicit call

`voice.preload` in `config.json` is Banter's preference for bringing a model up when voice starts, before the first utterance needs it. A load call is available on a service when a provision's adapter performs `loadModel` or the entry declares `load`. From those and the declarations above:

| Declared | Banter loads explicitly |
|---|---|
| `loading: none` | never |
| `autoLoad: never` | always, before first use of a model |
| `autoLoad: always` | when `voice.preload` is on; otherwise the first request loads |
| the model's roster entry declares variants | always, naming the variant, unless the selected API's adapter declares that it carries one |
| the selected API's adapter declares that a session does not load | always, before the session opens |

Banter unloads explicitly in one case: on changing model on a service that declares `resident: many` and an unload call, it unloads the model it is leaving. On a `one` service the load that follows replaces it.

An adapter's declaration governs its own API where the API's reference speaks of loading. The reference for `fluid.tts.stream` has a connection assert the model it names and never load one, and its adapter declares that a session does not load.

## Streaming

Whether a turn is transcribed as a stream, and whether speech plays as it renders, is the conjunction the requirements state. Each term is read from one place.

For transcription: the selected model's `kind` is `streaming` or `both` (roster); the service has a candidate provision for `transcribeStream`; and the candidate holds the capability that the client decides where an utterance ends. Each adapter declares what that capability rests on in its own reference. For `fluid.stt.stream` it is the protocol as specified, which never segments. For `deepgram.listen.live` it is `endpointing-off`, under which the adapter sends `endpointing=false`; a provision that does not declare the extension does not hold the capability. For `openai.realtime` it is `turn_detection: null`. Where the model is `both` and a batch candidate also exists, `voice.stt.preferStreaming` chooses.

For synthesis over `synthesize`: the serving's `streaming` flag is set (roster), and the candidate holds the capability that audio arrives as it renders. The `openai.audio.speech` adapter declares that capability twice over: resting on the spec's default response, and resting on `stream-flag` for a provision that declares the extension, where it sends the flag.

Among candidates that pass, preferences rank, each against a declared capability. `voice.stt.encodings` in `config.json` is Banter's ordered preference for audio sent to a transcription service, with Opus first; a candidate holding the Opus capability outranks one that takes only PCM. `voice.takeover` already states what a session does when a server is held, and a candidate holding the take-over capability outranks one without it. Remaining ties fall to the order of the service's `provides` list.

## Adapters

**Role**: perform operations over one API.

**Ownership**: everything the spec states about the wire: paths, fields, message types, the order of messages, close codes. Also the work that turns that wire into the operation's guarantees.

**Key logic**: an adapter is registered under an API id and under nothing else. It never reads a service id, a capability id or a service name. It is written from the reference at the catalog's pinned revision, and its paths are the spec's, prefixed by the provision's base path. It sends an extension's fields only when the provision names the extension, and requests only a value the provision accepts.

**An adapter never relies on a server's default for a parameter it depends on. It sends the value.** The voice loop's `deepgram.listen.live` adapter sends `endpointing=false` on every connection, and the speech adapter sends the format it will decode. No adapter's behaviour therefore turns on a server's default. A default that differs from the spec's is still declared, under the provision's `defaults`, so that the difference is stated for any client that does lean on it.

Adapters live in the shared package beside the catalog. The HTTP adapters run unchanged in the browser and under Bun, so the playback engine and the shard's media jobs share one `openai.audio.speech` adapter in place of two hand-written requests. `stt-socket.ts` becomes the `fluid.stt.stream` adapter with its behaviour unchanged, and the streaming transport above it holds whichever adapter selection returned.

Banter needs an adapter only for an API it selects. Today's calls are carried by `openai.audio.speech`, `openai.audio.transcriptions`, `openai.chat.completions`, `fluid.stt.stream`, `triton.model-repository` and the generic adapter for declared load calls. The `deepgram.listen.live` and `openai.realtime` adapters for `transcribeStream` are what make Banter usable against a transcription server that is not fluid. Adapters for `synthesizeStream` have no caller until the voice loop streams text; they bring a raw PCM playback path to the playback engine, since Deepgram's speak socket and Realtime both deliver PCM and the engine decodes mp3, AAC and WAV.

**Voice resolution returns Banter's terms.** `buildSpeechRequest` and `POST /api/voices/resolve` return a resolved voice and the serving's `requestParams`, and `GET /api/voice` serves that as the selection's resolution; the adapter encodes it. The resolution rule and its shared cases are untouched, as is its Swift twin, which resolves inside the server.

A serving's `requestParams` stay in the roster and are passed through as written: they are declared per runtime and model, in the runtime's vocabulary.

## What the fluid servers provide

Each cell of the requirements' matrix is a provision. The deviations below are what each would declare, from the source as it stands and the specs as read; the build confirms each against the pinned reference.

### `fluid-stt`

| API | Declared deviations |
|---|---|
| `fluid.stt.stream` | none; it is the reference's own implementation |
| `openai.audio.transcriptions` | omissions for the request fields it ignores; `stream=true` is implemented |
| `openai.realtime` | `only` the transcription session mode with `turn_detection: null`, and the client events that mode uses; `opus-input` |
| `deepgram.listen.prerecorded` | omissions for the query parameters it ignores |
| `deepgram.listen.live` | omissions for the query parameters and messages it ignores (`diarize`, `keywords`, `Configure` and others); `restricts` `encoding` to `opus` and `linear16`; `defaults` `endpointing` to 700; `session-claim`, `finalize-answered`, `endpointing-off`, `opus-packets` |
| `triton.model-repository` | `resident-slot` |

Deepgram's AsyncAPI document settles less than the design needs, because it describes shapes and almost no behaviour:

- **Opus.** `encoding` lists `opus` and `ogg-opus` as separate values, and audio is "raw binary WebSocket messages". Raw Opus is therefore a value of the spec's own. The document does not say how packets map onto messages; fluid takes one packet per message, as WebCodecs emits them, and declares that as `opus-packets`.
- **Endpointing.** The parameter is typed as any value with a default of `10`, and neither `false` nor any other value is described. `is_final` and `speech_final` are optional booleans with one-line descriptions.
- **Finalize.** The message has a type and nothing else. `Results` carries an optional `from_finalize`. The document does not say that a `Finalize` is answered, what answers it when no audio is buffered, or whether a server may hold settled text until one arrives.
- **Unlisted messages.** The server's messages are a closed list of seven, and the document says nothing of how a client treats another.
- **Errors.** "Fatal failures close the socket with a close frame and send no `Error` message"; an `Error` message is for a client message the server could not parse, and leaves the stream open.

Two consequences follow. `session-claim` on this route refuses and displaces by close code alone, which is the pattern the spec gives for fatal failures, and adds no message. And the three behaviours the voice loop needs and the document does not state are each a declared extension: `finalize-answered`, `endpointing-off` and `opus-packets`. Against a service that does not declare `finalize-answered`, the adapter settles a finalize on the first result marked `from_finalize` or after a bounded wait.

The route today refuses any encoding but `linear16`, requires `endpointing` to be a positive integer, ignores `model`, claims with a generated session and no take-over, sends nothing for an empty utterance, and refuses a connection with fluid's own lowercase `error` frame before the close. What changes is that it accepts `opus`, accepts `endpointing=false`, honours `model` as the stream socket does, answers every `Finalize`, and refuses by close code with no frame the spec does not list. Its 700 ms default for a client that sends no `endpointing` stays, read from the provision's `defaults` where it is a constant in the server now.

For Realtime the analysis records what the transcription mode does, and the adapter meets `transcribeStream`'s guarantees over it in three ways. Completed transcripts for different turns may arrive out of order, so the adapter matches each to its commit by `item_id` and releases finals in commit order. Committing an empty buffer is an error, so a finalize with no audio sent since the last commit is answered by the adapter with an empty final and no commit. Deltas are incremental, so the adapter accumulates them into the utterance so far. OpenAI's client-event and server-event reference pages have not been read for this record; the adapter is written from them.

### `fluid-tts`

| API | Declared deviations |
|---|---|
| `fluid.tts.stream` | none |
| `openai.audio.speech` | `restricts` `response_format` to what it encodes; `cloning-reference`. Audio streams as it renders without a flag, and `stream_format=sse` is implemented |
| `openai.realtime` | `only` `session.update`, `response.create` and `response.cancel`; `verbatim-speech` |
| `deepgram.speak` | `restricts` `encoding` to what it encodes; `voice-param`, `cloning-reference` |
| `deepgram.speak.live` | `voice-param`, `cloning-reference`, `session-claim` |
| `triton.model-repository` | `resident-slot` |

On Deepgram's `/v1/speak` channel the AsyncAPI document settles the open details. The client's text message is named `SpeakV1Text` in the schema and its `type` on the wire is `Speak`. The server sends `Metadata` after the handshake, binary audio, `Flushed` and `Cleared` with a `sequence_id`, and `Warning` with a `description` and `code`; there is no error message on this channel. `encoding` is `linear16`, `mulaw` or `alaw`, described as the streaming-compatible encodings. `/v2/speak` is a separate channel with its own messages, including an error message and per-turn events, and is not part of `deepgram.speak.live`.

Deepgram names a voice through `model`. Fluid's `model` is a synthesis model and the voice is separate, which is what `voice-param` declares. AAC is not available on this channel within the spec, so a client wanting compressed audio over a socket selects `fluid.tts.stream`.

### Other services

`tts-mlx-audio` provides `openai.audio.speech` with `stream-flag` and `cloning-reference`, and an omission for `stream_format`. `tts-piper` provides `openai.audio.speech` restricted to `wav`. `stt-whisper` provides `openai.audio.transcriptions`. `lm-studio` provides `openai.chat.completions`. The load and unload calls of `tts-mlx-audio` and `lm-studio` are declared under `models` on their entries, as Model loading shows. Each of these provisions is checked against the running service when it is written.

Every other registered service (`control`, `control-shard`, `embedding`, `searxng`, `paseo`, `zotero-mcp`, `pdf-ocr`) is one Banter does not call. It declares nothing and validation asks nothing of it.

## What leaves

`Provider.responseFormat` and `Provider.sessions` leave the roster. The first is a `restricts` entry on the service's speech provision; the second is the take-over capability, which a provision holds through `session-claim` or through the parts of its API's reference that define take-over. Both go in the same change that adds `provides`, with every reader of them. Neither Swift roster reader decodes either field.

`Provider.resolvesVoices` stays: it says who applies the resolution rule, the runtime or the node beside it. `cloning.requiresText` stays on the synthesis model, `kind` on the STT model, and `streaming`, `realtime`, `concurrency` and `requestParams` on the serving. `defaultModel` and `idleUnloadMs` stay on the provider.

`TtsOperation`, `TtsServiceInfo` and the model and voice types beside them leave `shared/types.ts`, with `GET /api/services/:id/info` and its shard proxy.

The dashboard's `loadTtsModel`, `loadSttModel` and `unloadTtsModel` give way to `loadModel` and `unloadModel` through adapters, and its LM Studio client calls `chat` in place of a path. That client finds its service by the id `lm-studio` written in its source; the id becomes a selection in `config.json`, so that which service answers `chat` is declared as the speech services are. The voice settings page offers take-over from the selected provisions' take-over capability, where it reads `sessions` now. The media jobs' own speech request goes, replaced by `synthesize` through the shared adapter; a media job's candidate accepts `wav` and, for a cloned voice, declares `cloning-reference`.

## Validation at registry load

Shape belongs to the registry schema and meaning to the checks that run after it.

**A service lists an API once.** Otherwise two entries disagree and order decides silently.

**A base path, where stated, begins with `/` and does not end with one.**

**`omits` and `only` are not both given for the same kind of part.** Otherwise the provision says a part is both implemented and missing.

**A provision names a declared API and declared extensions.** An API id or extension id the catalog lacks stops the load. Otherwise a provision claims an interface nobody has described.

**A deviation names a part of its API's spec.** Each API with an adapter carries an index of its spec's part names, generated from the pinned document where that is machine-readable and listed from the reference where it is prose. A name in `omits`, `only`, `restricts` or `defaults` that the index lacks stops the load, since a misspelt omission is a deviation Banter cannot detect. A provision of an API with no index states no deviations.

**A service declaring `loading: required` and `autoLoad: never` has a load call.** So does a service serving a model whose roster entry declares variants, unless a candidate API's adapter carries one. A load call is a provision whose adapter performs `loadModel`, or a declared `models.load`; a service has one or the other and never both. Otherwise a model can never become resident, or two declarations say how to load it.

**A declared load or unload call is well formed.** It has a method and a path beginning with `/`, and its templates use no placeholder but `{model}`.

**A service Banter calls has a candidate provision for what it is called for.** A service is one Banter calls when a roster provider names it or a selection in `config.json` does. A synthesis provider's service needs a candidate for `synthesize`; one serving a `streaming` STT model needs a candidate for `transcribeStream`, one serving a `batch` model a candidate for `transcribe`, and one serving a `both` model either. A provider without one stops the load, as a provider naming no registered service does. Otherwise the roster offers a model no caller can reach.

Every failure above is fatal at startup, as the registry's other checks are.

Deliberately unchecked: that a service implements what an empty provision claims. For a server the platform builds, the server's own startup check and its conformance tests hold that; for any other, the claim is the platform's, and a wrong one fails at the request.

**No load writes a provision the file does not state.** The schema sync adds no `provides` and no repair rule derives one. Deriving a provision from a capability would be the inference this design removes, written to disk.

The schema change is a clean break. The registry and configuration schemas, the templates, the roster's two departing fields and every reader of them change together, and both nodes are deployed together; a registry without `provides` for a service Banter calls does not load. `schemas/platform.schema.json` gains `provides` and `models`, and loses the two provider fields. The configuration schema gains `voice.preload` and `voice.stt.encodings`.

Both registries carry the new fields, the Pi's and the Mac's, and each reaches its node through that node's deploy. The deploy merge treats `services` by id and every other array as one value, so a service's `provides` list merges whole, and a live edit and a repo edit to the same list is a conflict the deploy stops on.

## Dependencies

Work on the fluid servers and anything else that runs on the Mac is handed to the Mac's Claude Code as steps and verified there. These are the orderings the work itself imposes:

- A provision declares a route only once the server's build serves it as declared, since the server's startup check refuses an entry that claims more than the build has. `fluid-tts` streams a speech response only when the request carries `stream: true`, so its `openai.audio.speech` provision claims conformance only with the build that streams unasked; claiming it sooner would give the voice loop whole-utterance responses with no error.
- The `deepgram.listen.live` adapter is verified against `fluid-stt`'s conforming listen route, and the `openai.realtime` adapter against each server's Realtime subset. Neither can be verified before that server work exists.
- The `fluid.tts.stream` catalog entry needs its protocol reference written, from the socket's source, before it can point at one.
- The index of part names for each API comes from the pinned reference, so a pin is chosen before provisions naming deviations can be validated.
- The fluid servers serve the model repository routes before the voice system's loads move onto them, and the routes they answer now go in the same change.
- The fluid servers read `defaults` from their provisions before the registry entry is the only place the listen route's 700 ms is written.
- The raw PCM playback path is needed by the first `synthesizeStream` adapter and by nothing before it.

## Object model entry

Proposed additions to [`docs/information-architecture.md`](../../docs/information-architecture.md).

Under Object Model, after Service:

> ### API
> A named interface a service can provide, identified by its published spec: the thing a caller must know to make a call, as a Capability is the thing a consumer asks for. The platform ships a catalog of the APIs its voice client calls. A service that client does not call states no API.
> - `id` — `{origin}.{resource}`, with a mode where one path serves two protocols (e.g. `openai.audio.speech`, `deepgram.listen.live`)
> - `name` — human label
> - `reference` — the published spec, pinned to a revision
>
> A Service lists the APIs it provides. Each provision states only how the service departs from the API's spec: what it omits, what it restricts, which declared extensions it adds, and any default it sets differently.

Under Service, two fields:

> - `provides[]` — the APIs this service serves, each with its deviations from the API's spec
> - `models` — whether the service's models need loading, what a request naming an unloaded model does, how many models it holds at once, and its load and unload calls where no published spec describes them

Under Relationships:

```
Service >──< API                (a service provides many APIs; an API is provided by many services)
```

Under Naming conventions:

> - APIs use `{origin}.{resource}[.{mode}]`, the origin being whoever established the interface: `openai.audio.speech`, `deepgram.listen.live`, `triton.model-repository`
