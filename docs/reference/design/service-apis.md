# Service APIs: how Banter knows how to call a service

Banter knows how to call a service from declarative information stored explicitly in the service registry, and from nothing else. Every fact a client uses to choose an adapter and build a call (which API the service serves, where, and how the service departs from that API's published spec) is readable from the service's registry entry and the API declarations that entry references. Nothing is inferred from `capabilityId`, from a service's id, or from a convention the registry does not state.

Banter here means the voice-chat client and everything in it that calls a speech or model service: the `voice-engine` package, the dashboard and the dsh plugin. The control plane resolves voices for a runtime on its own host and sends that runtime nothing.

## Requirements

**An API declaration is an id and a pinned reference to the API's published spec, and nothing that restates it.** "This service provides this API, whose reference is here" is the whole of the declaration; the adapter implements the API from its spec. Which APIs the built servers ship is an upstream decision. The fluid servers' own `openapi.yaml` is generated in order to implement those APIs, and is never the reference for them.

**Defaults are the spec's; a provision records deviations.** Servers behave as the published spec says unless they declare otherwise. A provision lists only how its service departs from the API's spec: omissions (parts not implemented), restrictions (narrower accepted values) and extensions (additions beyond the spec). A provision listing none claims full conformance. Banter detects every deviation from the declarations alone.

**Facts and preferences are declared outright and reasoned about.** Model facts stay on the model in the roster: an STT model's `kind`, a serving's `streaming` and `realtime`, cloning. A service declares whether its models need loading and whether it loads a model a request names by itself; a declaration that loading is needed tells Banter to find the load call among the service's declared APIs, which are ordinary APIs with references and no special family. Preloading is a Banter preference, weighed against those declarations to choose between loading explicitly and letting the service load on first use.

**Streaming is a conjunction of declared facts.** The model can stream (roster), the service provides a streaming API (provision), and that API's behaviour on this service is the spec's default or a declared deviation, including whether it segments on its own. `voice.stt.preferStreaming` chooses when both streaming and batch are possible.

**The voice loop calls abstract operations only.** The adapter is chosen from the declarations. The socket client for the fluid stream protocol is the adapter for that protocol, beside adapters for the standard APIs.

**The fluid servers support the standard APIs, batch and streaming, out of the box.**

| | OpenAI batch | OpenAI streaming | Deepgram batch | Deepgram streaming | Fluid's own |
|---|---|---|---|---|---|
| `fluid-stt` | `/v1/audio/transcriptions` | `/v1/audio/transcriptions` with `stream=true`; Realtime in transcription mode | `POST /v1/listen` | WebSocket `/v1/listen`, conforming to Deepgram's spec | `/v1/audio/stream`, declared |
| `fluid-tts` | `/v1/audio/speech` | `/v1/audio/speech` streamed and `stream_format=sse`; Realtime TTS, speaking `response.create` input verbatim | `POST /v1/speak` | WebSocket `/v1/speak` | `/v1/audio/stream`, declared |

Realtime is implemented as a declared subset on each server; the conversational mode, which runs a model, is not.

**Opus is preserved.** Opus input matters for home setups. Fluid's own protocol and the Deepgram live route carry it; on Realtime it is a declared extension. Banter's preference for Opus selects among provisions that accept it.

## The model

| Thing | What it is | Declared in |
|---|---|---|
| **Operation** | Something Banter does with a service, stated without wire detail | Banter's code: a fixed set |
| **API** | A named interface with a published spec | The API catalog: an id and a pinned reference |
| **Provision** (service × API) | This service serves this API, with these departures from its spec | The service's `provides` list in the registry |
| **Adapter** | The code that performs operations over one API, written from that API's spec | Banter's code: one per API id |
| **Preference** | What Banter would rather have where the declarations leave a choice | `config.json` |

A caller holds an operation, a service id and Banter's preferences. It reads the service's provisions, keeps those whose API has an adapter that performs the operation, drops any whose declared deviations remove something the call needs, ranks the rest by preference, and hands the winner's provision to its adapter. A service left with no provision is refused, with a message naming the service, the operation and what the service declares, for example `fluid-stt cannot transcribeStream: it provides openai.audio.transcriptions, triton.model-repository`.

Where it lives: the catalog, the part indexes, the adapters and selection are in the shared package under `shared/apis/`, which the voice engine, the control plane and the dsh plugin import. Nothing under it imports from the control plane, the voice engine or the dashboard.

## Operations

**Role**: Banter's own vocabulary for what it asks of a service. The voice loop and the playback engine call these and never a path.

**Ownership**: the set of operations, each one's inputs and outputs in Banter's terms, and the guarantees a caller may rely on whichever API serves it.

| Operation | Capability | In | Out | Called by |
|---|---|---|---|---|
| `synthesize` | `tts` | text, a resolution, speed | audio in a format the caller decodes (mp3, aac or wav), delivered as it renders where the declarations allow | the playback engine |
| `transcribe` | `stt` | a whole recording, optionally a model | the transcript | the batch STT transport |
| `transcribeStream` | `stt` | a session: audio frames, finalize, keep-alive, close | the utterance so far whenever it changes; one settled transcript per finalize, in order, including an empty one; a coded close | the streaming STT transport |
| `loadModel`, `unloadModel` | any | a model, and for `loadModel` its mode or variant | done, or a refusal | the voice system |

`synthesizeStream` (text spans, flush, clear, close; audio frames back) is part of the vocabulary and has no adapter and no caller.

A resolution is what the voice resolution rule in [`model-roster.md`](model-roster.md) returns: the model as the runtime knows it, the voice by name or as a recording with an optional transcript, and the serving's request parameters. Listing voices and models is not an operation, since the roster declares both. The agent conversation is outside this set. It travels through the OpenClaw gateway, which is not a registry service.

The guarantees are the adapter's to produce. `transcribeStream` promises the whole utterance in each partial and exactly one final per finalize; where an API sends incremental deltas, or settles text in segments on its own schedule, its adapter accumulates and answers the finalize once.

## The API catalog

**Role**: the list of interfaces a service can be said to provide.

**Ownership**: each API's id, its name, and the reference to its published spec. Nothing else: no path, field, message or enumeration is written here, because the spec states them and a copy would be a second statement of the same fact.

```
id          deepgram.listen.live
name        Deepgram live transcription
reference   { document, revision, part }
```

`document` is the spec's address, `revision` what pins it, and `part` the operation, channel or section within it. A spec kept in a repository is pinned by commit. One published only as pages, as OpenAI's Realtime reference is, is pinned by the day it was read and a hash of each page, so a later change is detectable without keeping a copy. A document in this repository has the revision `in-repo`, which changes with the commit that holds the catalog.

The catalog is one data file, `shared/apis/catalog.json`, in the shared package, so the browser engine and the control plane read the same ids and the engine's import boundary holds. It ships with the adapters because an adapter and the revision it was written from change together. A service Banter does not call declares nothing, and nothing here describes its interface.

An API is the unit one adapter implements and one service can serve apart from any other. OpenAI's speech route and its transcription route are two APIs; Deepgram's `/v1/listen` over a WebSocket and over POST are two.

| API id | Reference | Performs |
|---|---|---|
| `openai.audio.speech` | `openai/openai-openapi`, `createSpeech` | `synthesize` |
| `openai.audio.transcriptions` | `openai/openai-openapi`, `createTranscription` | `transcribe` |
| `openai.realtime` | OpenAI's Realtime client-event and server-event reference pages | `transcribeStream` |
| `deepgram.listen.prerecorded` | `deepgram/deepgram-api-specs`, OpenAPI `POST /v1/listen` | none |
| `deepgram.listen.live` | `deepgram/deepgram-api-specs`, AsyncAPI channel `/v1/listen` | `transcribeStream` |
| `deepgram.speak` | `deepgram/deepgram-api-specs`, OpenAPI `POST /v1/speak` | none |
| `deepgram.speak.live` | `deepgram/deepgram-api-specs`, AsyncAPI channel `/v1/speak` | none |
| `fluid.stt.stream` | `services/fluid/STT.md`, Streaming | `transcribeStream` |
| `fluid.tts.stream` | `services/fluid/TTS-STREAM.md` | none |
| `triton.model-repository` | Triton's model repository extension to the Open Inference Protocol, `docs/protocol/extension_model_repository.md` in `triton-inference-server/server` | `loadModel`, `unloadModel` |

The last column is a fact about Banter's adapters, held with them and repeated here for reading. Every API in the catalog has a part index, whether or not Banter has an adapter for it, because the fluid servers declare their provisions of all of them.

An id's first part names whoever established the interface, as `triton.model-repository` names the project whose extension other servers copy. No entry names a runtime registered here: a runtime appears in its own registry entry and nowhere else.

### Part indexes

A deviation names a part of the API's spec, and the name must be in that API's index, `shared/apis/parts/<api id>.json`, which holds the revision it was read at and a list of part names. A part name is `<kind>:<name>`:

| Kind | Names | Example |
|---|---|---|
| `parameter` | a request field, query parameter or connect parameter | `parameter:stream_format` |
| `value` | one value of a parameter, as `<parameter>=<value>` | `value:response_format=opus` |
| `client-message` | a message the client sends, by its wire `type` | `client-message:Configure` |
| `server-message` | a message the server sends, by its wire `type` | `server-message:UtteranceEnd` |
| `field` | a field of a message, as `<message>.<field>` | `field:Results.speech_final` |
| `mode` | a session mode or intent | `mode:conversation` |
| `route` | a route an API defines beside its main one | `route:index` |

The indexes for the OpenAI REST APIs and the Deepgram APIs are generated from the pinned documents by `scripts/generate-api-parts.ts`, run by hand, never at build or test time. The others are written from their prose references. OpenAI's multipart field is indexed as `parameter:timestamp_granularities`, without brackets; an adapter sends it as `timestamp_granularities[]`, the form OpenAI's clients use.

### Extensions

An extension is an addition beyond an API's spec that more than one service may share. It is declared as an API is, by an id and a reference to where it is described, and a provision names it.

| Extension | Adds | Described in |
|---|---|---|
| `session-claim` | `session` and `takeover` query parameters at connect, and close codes 4001 to 4010 naming why a connection was refused or displaced | `services/fluid/STT.md`, Streaming |
| `cloning-reference` | `ref_audio`, a path on the service's own machine, and `ref_text` | [cloning-reference](#cloning-reference) |
| `stream-flag` | `stream: true` on a speech request asks for audio as it renders | [stream-flag](#stream-flag) |
| `opus-input` | on Realtime, an Opus input format: each `input_audio_buffer.append` carries one raw Opus packet, base64-encoded as the spec encodes PCM | [opus-input](#opus-input) |
| `voice-param` | a `voice` parameter at connect, where the spec selects a voice through `model` alone | [voice-param](#voice-param) |
| `verbatim-speech` | on Realtime, `response.create` speaks the text of its `input_text` parts as written and runs no model | [verbatim-speech](#verbatim-speech) |
| `finalize-answered` | every `Finalize` is answered by exactly one result marked as answering it, including an empty one | `services/fluid/STT.md`, Deepgram `/v1/listen` |
| `endpointing-off` | `endpointing=false` stops the server closing utterances on its own | `services/fluid/STT.md`, Deepgram `/v1/listen` |
| `opus-packets` | with `encoding=opus`, each binary message is one raw Opus packet | `services/fluid/STT.md`, Streaming |
| `resident-slot` | on the model repository API: `mode` and `variant` as load parameters; a load of what is already resident changes nothing; a load replaces the one resident model; a load that would change the model, and an unload, are refused while a session holds it | `services/fluid/STT.md`, Model repository |

**Behaviour a spec leaves unstated, and Banter relies on, is a declared extension.** A spec's silence is not a default to assume. `finalize-answered`, `endpointing-off` and `opus-packets` each name something Deepgram's document does not say and the voice loop needs; a service that does not declare one is not relied on for it.

#### cloning-reference

A speech request may carry `ref_audio`, the path of a recording on the service's own machine, and `ref_text`, the transcript of that recording, in place of a `voice` name. No vendor's published speech API defines either; they are the names runtimes that clone from a reference recording have settled on. The adapter sends a recording as these two fields (`ref_text` only when the resolution carries a transcript) and only to a provision that declares the extension. A resolved voice that is a recording is refused before any request where the selected provision does not declare it. The path is meaningful on the service's own machine, which is why the shard that holds the recordings resolves a voice for a runtime that cannot read the registry.

#### stream-flag

`stream: true` on a speech request asks the server to send audio as it renders. OpenAI's route streams its bytes unasked and offers `stream_format` for server-sent events, so the flag is not OpenAI's. It is the flag the mlx-audio server's speech route takes. The speech adapter sends it only to a provision that declares the extension, and only when the playback engine wants progressive audio; a service that streams unasked needs no flag and declares none.

#### opus-input

On OpenAI's Realtime transcription session, the input format is PCM at a stated rate, sent as base64 in `input_audio_buffer.append`. The extension adds an Opus format, announced as `{ "type": "audio/opus", "rate": 48000 }` in `session.update`, where each `input_audio_buffer.append` carries one raw Opus packet exactly as WebCodecs emits it, base64-encoded the way the spec encodes PCM. It carries Opus from the browser to a Realtime server without a transcode.

#### voice-param

Deepgram's speak routes choose a voice through `model`, whose values are voice names. A server whose `model` names a synthesis model, with the voice a separate choice, declares `voice-param`: a `voice` query parameter at connect, beside `model`, naming the voice. Banter calls no Deepgram speak route yet; the fluid servers declare it so a client that wants a voice can say so.

#### verbatim-speech

On Realtime, the spec's `response.create` runs a model and answers with what it generates. A server that only speaks text declares `verbatim-speech`: `response.create` speaks the text of its `input_text` parts as written, ignores `instructions` and runs no model. A server conforming in full would answer the text rather than read it, so an adapter for speech over Realtime requires this extension. The behaviour follows Kokoro-FastAPI's Realtime router (`api/src/routers/openai_realtime.py` in `remsky/Kokoro-FastAPI`), which accepts `session.update`, `response.create` and `response.cancel` and answers anything else with an `error`.

## Provisions

**Role**: a service's statement of which APIs it serves and how it departs from each.

**Ownership**: for one service and one API, where the API sits if not where its spec puts it, the three kinds of deviation, and any default the service sets differently from the spec.

```
services[].provides   [ { api, basePath?, omits?: [name], only?: [name], restricts?: { parameter → [values] },
                          defaults?: { parameter → value }, extends?: [extension id] } ]
```

**Key logic**: a provision of `{ api }` alone claims the service behaves as the reference says, at the path the reference gives. Everything else is a departure.

- `basePath` is stated only when the service mounts the API somewhere other than the path of the spec's own server address, which is `/v1` for OpenAI's REST routes and the root for the others. For OpenAI's REST routes it replaces `/v1`; for the rest it prefixes the spec's path. The caller's endpoint, which may carry a path of its own such as the dsh relay's, comes before all of it.
- `omits` names parts of the spec the service does not implement, in the spec's own spelling and qualified by kind. `only` states the same thing by complement where a service implements a small subset, as every Realtime server does: the parts of each kind it lists are implemented and every other part of that kind is omitted.
- `restricts` narrows a parameter to the values this service accepts, in its order of preference. A value named in `omits` is removed as `restricts` removes it, and an omitted parameter removes all its values.
- `defaults` gives the value the service uses for a parameter a client leaves out, where that differs from the spec's default.
- `extends` lists extension ids.

**A declared default is the setting, for a server Banter builds.** The server reads its own provisions at startup and takes each `defaults` value as its default for that parameter, holding none in its source. `fluid-stt`'s listen route declares `defaults: { endpointing: 700 }` against the 10 in Deepgram's document, which is too short a silence for a local model, and changing the number in the registry entry changes the server's behaviour at its next start. The declaration and the configuration are one entry, so they cannot disagree. For a runtime Banter does not build, `defaults` is the registry's statement of what that runtime does.

**How Banter detects a deviation.** Each adapter states, beside its code, the parts of its API it requires for each operation and the parts it uses when present. A provision that omits a required part, or restricts a required parameter to values the call cannot use, is not a candidate for that operation. One that omits an optional part is a candidate, and the adapter does without: it sends a parameter it only uses when present only when the provision neither omits nor excludes it.

**What an API offers is declared by its adapter, never read off its id.** Selection asks questions of a candidate: does the client decide where an utterance ends (`client-endpointing`), can a session be taken over (`takeover`), is Opus accepted (`opus`), does audio arrive as it renders (`renders-progressively`), does a request naming a model load it (`loads-on-request`), can a request name a model's variant (`carries-variant`), does opening a session load the named model (`session-loads`). Each adapter declares its answers as capabilities, and for each capability the part of the reference or the extension it rests on, or the reference's own guarantee. The `fluid.stt.stream` adapter declares take-over resting on the `session` parameter its reference defines; the `deepgram.listen.live` adapter declares it resting on `session-claim`. A capability holds for a provision when the part it rests on is neither omitted nor restricted away, or the extension is declared. No rule anywhere names an API or a service.

A requirement may be an extension. The `openai.realtime` adapter for speech would require `verbatim-speech`; a service conforming in full would answer the text instead of reading it, and is no candidate. An extension the adapter does not know changes nothing, and one it knows is used only when declared: `ref_audio` goes to no service that does not declare `cloning-reference`.

**A provision belongs to the service entry, not to the roster.** The roster declares models, voices and which runtime serves which; an interface is a fact about the process whatever models it holds, and it applies to services the roster never mentions.

**The registry is the only declaration.** A service does not also announce its APIs at a route of its own, since a second source can disagree with the first and an external runtime cannot be made to serve one. The servers Banter builds read their own registry entry at startup, as they read their roster section, and refuse to start when it claims more than their build implements: an API they do not serve, an extension they do not implement, or a part they lack that the entry does not list as omitted.

**Relationships**: the shard and the control plane serve `provides` and `models` with each service in `/api/services`. `GET /api/voice` carries them for every TTS provider and STT option, which is how the browser engine learns them, with the catalog it already imports. A browser reaches a service through the dsh plugin's relay, which registers a WebSocket route at each path a selected STT service's streaming provisions use (the provision's `basePath` plus the API's path) and passes query parameters and close codes 4001 to 4010 through unchanged. A registry reload that changes a running fluid server's `provides` reaches it only on restart, and the reload's warnings name the server, as they do for a roster change.

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
- `load` and `unload` declare the explicit calls of a runtime that publishes no spec for them, as data: a method, a path, and query and body templates in which `{model}` stands for the model's name on the wire. One generic adapter runs a declared call. This states a call nobody else has written down; it restates no spec, since there is none to reference. A service whose explicit calls follow a published spec declares none here and provides that API instead.

The name on the wire is the serving's `key` for transcription, for streaming sessions and for the loads of both; for synthesis it is the resolution's model, which is the roster id for a runtime that resolves voices itself and the serving's `key` otherwise. A variant travels as the roster's variant id. A fluid server maps a roster id to its runtime key itself where the two differ (`kokoro-82m` is `kokoro-ane`).

### The servers Banter builds

The fluid servers load on request, and say so. Both declare `always` and `one`: a call that names a model the server does not hold loads it, with no explicit call first, and the model that was resident is replaced.

For `fluid-tts` that is the whole rule. For `fluid-stt` it meets the session, which holds the server exclusively. The rules, and why, are in [`fluid-stt-on-demand-load.md`](fluid-stt-on-demand-load.md): a request loads the model it names in the mode its route needs; a model with variants loads on a request only when the request names the variant; while a session holds the server every other request is refused at once, as is an explicit load that would change the model, and an unload; a takeover is the only way in.

Explicit load and unload stay, for bringing a model up before it is needed and for freeing memory. Both fluid servers provide them as `triton.model-repository` with `resident-slot`: `POST /v2/repository/models/{name}/load`, with `mode` and `variant` in the request's `parameters` object, `POST /v2/repository/models/{name}/unload`, and `POST /v2/repository/index` for what is resident.

The Open Inference Protocol and this extension:

- The Open Inference Protocol is KServe's v2 inference protocol, maintained in `kserve/open-inference-protocol`, with a prose REST specification, an OpenAPI document and a gRPC definition. Triton, Seldon MLServer, OpenVINO Model Server, TorchServe and AMD's inference server are listed as adopters.
- The core protocol covers liveness, readiness, server and model metadata, and tensor inference. It has no load or unload. Its only word on loading is the model-ready probe, `GET /v2/models/{name}/ready`. It says nothing of loading on demand.
- Of extensions the core says "Currently, no standard extensions are defined. Individual inference servers may define and document their own." The model repository routes are Triton's extension, which a server advertises as `model_repository` in its metadata. MLServer serves the same three routes.
- A load request's body is `{"parameters": {…}}`, key and value pairs, of which Triton defines `config` and `file:` entries. A load of a loaded model reloads it. Success is a 200 and failure a status with `{"error": …}`. The index returns each model's `name`, `state` and `reason`.

It fits as the fluid servers' explicit load API because it is the one load and unload interface published with more than one implementation, and its `parameters` object is where a mode and a variant can travel. It does not fit unmodified, which is what `resident-slot` declares: the fluid parameters are its own, and a load of what is resident is a no-op where Triton reloads, since a reload costs about thirteen seconds and voice mode on a second device loads before it takes over. The tensor inference routes of the core protocol are not served, and the catalog entry references the extension alone.

### Runtimes Banter cannot change

A runtime that publishes no spec for loading declares the calls under `models`. The example registries do so for `tts-kokoro`, which loads a model a request names and holds one:

```
tts-kokoro   models { loading: required, autoLoad: always, resident: one,
                      load:   { method: POST,   path: /v1/models, query: { model_name: "{model}" } },
                      unload: { method: DELETE, path: /v1/models, query: { model_name: "{model}" } } }
```

A runtime that keeps every model it has loaded declares `resident: many`, and Banter unloads the model it is leaving when the selection changes.

### When Banter makes an explicit call

`voice.preload` in `config.json` (default `true`) is Banter's preference for bringing a model up when voice starts, before the first utterance needs it. A load call is available on a service when a provision's adapter performs `loadModel` or the entry declares `load`. The rows are checked top to bottom:

| Declared | Banter loads explicitly |
|---|---|
| `loading: none`, or no `models` | never |
| `autoLoad: never` | always, before first use of a model |
| the model's roster entry declares variants, and the selected API's adapter does not carry one | always, naming the variant |
| the selected API's adapter does not load the model a session names, and the call opens a session | always, before the session opens |
| `autoLoad: always` | when `voice.preload` is on; otherwise the first request loads |

Banter unloads explicitly in one case: on changing model on a service that declares `resident: many` and an unload call, it unloads the model it is leaving. On a `one` service the load that follows replaces it. The voice system performs the loads, through the adapters, in the voice engine, so every host that embeds the engine shares one implementation. A refused load fails the voice start with the server's own text.

An adapter's declaration governs its own API where the API's reference speaks of loading. The reference for `fluid.tts.stream` has a connection assert the model it names and never load one, and `openai.realtime` sessions do not load the model they name; their adapters declare no `session-loads`.

## Streaming

Whether a turn is transcribed as a stream, and whether speech plays as it renders, is the conjunction the requirements state. Each term is read from one place.

For transcription: the selected model's `kind` is `streaming` or `both` (roster, served as `stt.models`); the service has a candidate provision for `transcribeStream`; and the candidate holds the capability that the client decides where an utterance ends. Each adapter declares what that capability rests on in its own reference. For `fluid.stt.stream` it is the protocol as specified, which never segments. For `deepgram.listen.live` it is `endpointing-off`, under which the adapter sends `endpointing=false`; a provision that does not declare the extension does not hold the capability. For `openai.realtime` it is `turn_detection: null`. Where the model is `both` and a batch candidate also exists, `voice.stt.preferStreaming` chooses.

For synthesis over `synthesize`: the serving's `streaming` flag is set (roster), and the candidate holds the capability that audio arrives as it renders. The `openai.audio.speech` adapter declares that capability twice over: resting on the API's default response, and resting on `stream-flag` for a provision that declares the extension, where it sends the flag.

Among candidates that pass, preferences rank, each against a declared capability. `voice.stt.encodings` in `config.json` is Banter's ordered preference for audio sent to a transcription service: when it lists `opus` before `pcm16` (or lists `opus` alone), a candidate holding the Opus capability outranks one that takes only PCM; when `pcm16` comes first or `opus` is absent, the engine sends 16-bit PCM even to a provision that accepts Opus. A candidate holding the take-over capability then outranks one without it, and remaining ties fall to the order of the service's `provides` list.

## Adapters

**Role**: perform operations over one API.

**Ownership**: everything the spec states about the wire: paths, fields, message types, the order of messages, close codes. Also the work that turns that wire into the operation's guarantees.

**Key logic**: an adapter is registered under an API id and under nothing else. It never reads a service id, a capability id or a service name. It is written from the reference at the catalog's pinned revision, and its paths are the spec's, prefixed by the provision's base path. It sends an extension's fields only when the provision names the extension, and requests only a value the provision accepts. A non-2xx answer is an error carrying the status and the server's own text.

**An adapter never relies on a server's default for a parameter it depends on. It sends the value.** The `deepgram.listen.live` adapter sends `endpointing=false` on every connection, and the speech adapter sends the format it will decode. No adapter's behaviour therefore turns on a server's default. A default that differs from the spec's is still declared, under the provision's `defaults`, so that the difference is stated for any client that does lean on it.

Adapters live in the shared package beside the catalog, and the HTTP adapters run unchanged in the browser. Banter has adapters for `openai.audio.speech`, `openai.audio.transcriptions`, `fluid.stt.stream`, `deepgram.listen.live`, `openai.realtime` (transcription), `triton.model-repository` and the generic adapter for declared load calls. It needs an adapter only for an API it selects: the Deepgram speak APIs, Realtime speech and `fluid.tts.stream` are declared by the fluid servers and have none.

- `openai.audio.speech` sends the serving's request parameters, then `model`, `input`, `voice`, `speed` and always `response_format`: the first value the provision accepts that the browser decodes (mp3, aac or wav), which the adapter returns and the playback engine decodes by.
- `openai.audio.transcriptions` posts the recording as multipart `file`, with `model` when the caller names one and always `response_format`: the first of `json` and `verbose_json` the provision accepts.
- `fluid.stt.stream` is the fluid stream socket client. It carries one conversation per connection, holds audio captured before the socket opens, and sends `session` and `takeover` only when the provision implements them and the caller asks.
- `deepgram.listen.live` accumulates `Results` into the utterance so far and answers exactly one final per `Finalize`. Where the provision declares `finalize-answered` it settles on the result marked `from_finalize`; otherwise on that result or after 3000 ms, whichever comes first.
- `openai.realtime` opens a transcription session with turn detection off. It resamples the engine's 16 kHz audio to the 24 kHz the session declares, or sends Opus packets where `opus-input` is declared; commits on a finalize and answers a finalize with no audio since the last commit with an empty final and no commit; accumulates deltas per item; and releases finals in commit order.
- `triton.model-repository` posts to the model's load and unload routes, with `mode` and `variant` as parameters only with `resident-slot`.

**Voice resolution returns Banter's terms.** `resolveSpeech` and `POST /api/voices/resolve` return a resolution, and `GET /api/voice` serves it as the selection's `resolution`; the adapter encodes it. The resolution rule and its shared cases are in [`model-roster.md`](model-roster.md), and are unchanged by this. A serving's `requestParams` stay in the roster and are passed through as written: they are declared per runtime and model, in the runtime's vocabulary.

## What the fluid servers provide

Each cell of the requirements' matrix is a provision, declared in `services/fluid/registry.fluid.example.json` and checked against each server's build at startup. [`speech-server-api.md`](../speech-server-api.md) lists them with their deviations.

**Deepgram's AsyncAPI document settles less than the design needs**, because it describes shapes and almost no behaviour:

- **Opus.** `encoding` lists `opus` and `ogg-opus` as separate values, and audio is "raw binary WebSocket messages". Raw Opus is therefore a value of the spec's own. The document does not say how packets map onto messages; fluid takes one packet per message, as WebCodecs emits them, and declares that as `opus-packets`.
- **Endpointing.** The parameter is typed as any value with a default of `10`, and neither `false` nor any other value is described.
- **Finalize.** The message has a type and nothing else. `Results` carries an optional `from_finalize`. The document does not say that a `Finalize` is answered, what answers it when no audio is buffered, or whether a server may hold settled text until one arrives.
- **Unlisted messages.** The server's messages are a closed list of seven, and the document says nothing of how a client treats another.
- **Errors.** "Fatal failures close the socket with a close frame and send no `Error` message"; an `Error` message is for a client message the server could not parse, and leaves the stream open.

So `session-claim` on the listen route refuses and displaces by close code alone, which is the pattern the spec gives for fatal failures, and adds no message; and the three behaviours the voice loop needs and the document does not state are each a declared extension: `finalize-answered`, `endpointing-off` and `opus-packets`. Against a service that does not declare `finalize-answered`, the adapter settles a finalize on the first result marked `from_finalize` or after a bounded wait.

**Realtime.** Completed transcripts for different turns may arrive out of order, so the adapter matches each to its commit by `item_id` and releases finals in commit order. Committing an empty buffer is an error, so a finalize with no audio sent since the last commit is answered by the adapter with an empty final and no commit. Deltas are incremental, so the adapter accumulates them into the utterance so far.

**Deepgram speak.** The client's text message is named `SpeakV1Text` in the schema and its `type` on the wire is `Speak`. The server sends `Metadata` after the handshake, binary audio, `Flushed` and `Cleared` with a `sequence_id`, and `Warning` with a `description` and `code`; there is no error message on this channel. `encoding` is `linear16`, `mulaw` or `alaw`, described as the streaming-compatible encodings. Deepgram names a voice through `model`; a fluid server's `model` is a synthesis model and the voice is separate, which is what `voice-param` declares. AAC is not available on this channel within the spec, so a client wanting compressed audio over a socket selects `fluid.tts.stream`.

**Known gaps** the servers' provisions accept: Deepgram's own model names are not served; an answer to an empty `Finalize` is marked `from_finalize` but not `is_final`; Deepgram's deprecated `Error.code` is not sent; a Realtime speech session that names no model speaks with the resident one, else the roster's first; and on `fluid-tts` a socket's claim covers the connection while synthesis takes the resident slot per span, so a model-changing load waits behind a streaming response and is refused with 409 at the slot's deadline. See [`speech-server-api.md`](../speech-server-api.md#what-the-fluid-servers-provide).

### Other services

`stt-faster-whisper` and `stt-whisper` provide `openai.audio.transcriptions`, each omitting the request fields it ignores and restricting `response_format` to `json` and `text`; both declare `models: { loading: "none" }`. `tts-kokoro` provides `openai.audio.speech`, omitting `instructions` and `stream_format` and restricting `response_format` to `wav`, with the load and unload calls shown above. `tts-neutts-air` restricts `response_format` to `wav` and `mp3` and declares no loading; it declares no `stream-flag`, because its stream ignores the format.

Every other registered service (`control`, `control-shard`, and whatever else a registry lists) is one Banter does not call. It declares nothing and validation asks nothing of it.

## What a roster provider carries

A provider keeps `resolvesVoices`, which says who applies the resolution rule, the runtime or the node beside it; `defaultModel` and `idleUnloadMs`; and its `serves` list. It carries neither the audio format a runtime returns nor whether its socket takes sessions: the first is a `restricts` entry on the service's speech provision, and the second is the take-over capability, which a provision holds through `session-claim` or through the parts of its API's reference that define take-over. `cloning.requiresText` stays on the synthesis model, `kind` on the STT model, and `streaming`, `realtime`, `concurrency` and `requestParams` on the serving.

The voice settings page offers take-over when the selected STT service's streaming provision, chosen the way a session chooses it, holds the take-over capability. The TTS provider has no say.

## Validation at registry load

Shape belongs to the registry schema and meaning to the checks that run after it, in `control/shared/src/provisions.ts`, called from `validateRoster`. Every failure is fatal at startup and refused at reload.

1. **A service lists an API once.** Otherwise two entries disagree and order decides silently.
2. **A base path, where stated, begins with `/` and does not end with one.**
3. **`omits` and `only` are not both given for the same kind of part.** Otherwise the provision says a part is both implemented and missing.
4. **A provision names a declared API and declared extensions.** An API id or extension id the catalog lacks stops the load.
5. **A deviation names a part of its API's spec.** A name in `omits`, `only`, `restricts` or `defaults` that the index lacks stops the load, since a misspelt omission is a deviation Banter cannot detect. A restricted value must be in the index where the index lists values for that parameter.
6. **A service declaring `loading: required` and `autoLoad: never` has a load call.** So does a service serving a model whose roster entry declares variants, unless a candidate API's adapter carries one. A load call is a provision whose adapter performs `loadModel`, or a declared `models.load`.
7. **A service has one load call, never two.** A `loadModel` provision beside a `models.load` stops the load.
8. **A declared load or unload call is well formed.** It has a method and a path beginning with `/`, and its templates use no placeholder but `{model}`.
9. **A service Banter calls has a candidate provision for what it is called for.** A service is one Banter calls when a roster provider names it. A synthesis provider's service needs a candidate for `synthesize`; one serving a `streaming` STT model needs a candidate for `transcribeStream` where the client decides where an utterance ends, one serving a `batch` model a candidate for `transcribe`, and one serving a `both` model either.

An unknown key anywhere in a provision, in `models` or in a declared call is fatal, and `autoLoad` and `resident` are stated when `loading` is `required` and absent when it is `none`. The configuration's selections are not checked at load: a selection can name a provider on a shard, which the control plane's own roster does not hold until that shard is polled, and the selection route keeps guarding them.

Deliberately unchecked: that a service implements what an empty provision claims. For a server Banter builds, the server's own startup check and its conformance tests hold that; for any other, the claim is the registry's, and a wrong one fails at the request.

**No load writes a provision the file does not state.** The schema sync adds no `provides` and no repair rule derives one. Deriving a provision from a capability would be the inference this design removes, written to disk.

Both nodes' registries carry the new fields, and each reaches its node through that node's deploy. The deploy merge treats `services` by id and every other array as one value, so a service's `provides` list merges whole, and a live edit and a repo edit to the same list is a conflict the deploy stops on.

## What is settled, and what is out

- The shard has no `/svc/<id>` forwarder. The dsh relay is the only node-side WebSocket forwarder, and it registers a route per streaming provision.
- There is no `chat` operation and no `openai.chat.completions` entry in the catalog.
- The voice engine owns loading: it performs loads itself through the adapters, so the dashboard and the dsh plugin share one implementation.
- Every catalog API has a part index, including those with no Banter adapter.
- `stt.models` is served in `GET /api/voice`, so the engine reads no model listing from a server; the roster declares the models.
- `session-loads` on `deepgram.listen.live` rests on `parameter:model`: Deepgram's spec says nothing of loading, and whether a request actually loads still comes from the service's `autoLoad`, through the load decision.
- The `deepgram.listen.live` adapter's finalize wait is 3000 ms where the server does not declare `finalize-answered`.
