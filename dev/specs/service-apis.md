# Spec: declared service APIs in Banter

The contract for building [the service APIs design](../design/service-apis.md) in Banter. The design says what and why; this spec says where in Banter, and settles what the design leaves to Banter. Where the two disagree, this spec wins for Banter and the disagreement is recorded under [Departures from the design](#departures-from-the-design). The research is [service-api-binding.md](../analysis/service-api-binding.md).

Everything the design says about platform-only callers and services is out of scope: the shard's media jobs, the `chat` operation and `openai.chat.completions`, LM Studio, mlx-audio, piper, and the `/svc/<id>` forwarder. Banter has none of them.

## 1. Pins

Every adapter and part index is written from these revisions and no other. A document is fetched read-only from its pinned address, and nothing from it is committed except the generated part indexes.

| Reference | Pin |
|---|---|
| `openai/openai-openapi`, `openapi.yaml` | commit `373f26a9aec3608e3158f2a0d4b8ae49d13162a4` |
| `deepgram/deepgram-api-specs`, `openapi.yml` and `asyncapi.yml` | commit `0ccc6f4680b3fe5b8f9002be6a78cd50e5b32116`. Its `asyncapi.yml` has SHA-256 `d3bdcf2771c450d70a2610fffe001c0cf1e9110787fbfee211f53ff59fdda73f`, the same as `https://developers.deepgram.com/asyncapi.yaml` read on 2026-11-24 |
| OpenAI Realtime client events | `https://developers.openai.com/api/reference/resources/realtime/client-events.md`, read 2026-11-24, SHA-256 `bd09448d5c7048148616c895e965c3e280ed8b0763cee583a6e7bf0e2d158532` |
| OpenAI Realtime server events | `https://developers.openai.com/api/reference/resources/realtime/server-events.md`, read 2026-11-24, SHA-256 `e8a4ab74ee0776b94007a5d0a1db48586afb1e631f9370ac63b86433eba80ac4` |
| OpenAI Realtime transcription guide | `https://developers.openai.com/api/docs/guides/realtime-transcription.md`, read 2026-11-24, SHA-256 `514af8c931667acf5083897ab050a0b5903e60b158ce0d493db577e4d9503551` |
| Triton model repository extension | `triton-inference-server/server` commit `81794dd20032fc2504a40e6a3942ad9330ff437b`, `docs/protocol/extension_model_repository.md` |
| Open Inference Protocol | `kserve/open-inference-protocol` commit `d49cc23f89d709d87b210ef9449e273ae243984e` |
| `fluid.stt.stream` | `services/fluid/STT.md`, Streaming, in this repo |
| `fluid.tts.stream` | `services/fluid/TTS-STREAM.md`, written in this work from the socket's source (section 9) |

A page whose hash no longer matches when fetched is a brief, not a silent update.

## 2. Module layout

The catalog, part indexes, adapters and selection live in the shared package (`@platform/shared`, `shared/`), under `shared/apis/`. The voice engine imports them as `@platform/shared/apis/...`, which its boundary test already allows, and the control plane and the shard import them the same way. Nothing under `shared/apis/` imports from the control plane, the voice engine or the dashboard.

| Path | Holds |
|---|---|
| `shared/apis/catalog.json` | The API catalog and the extension list (section 3) |
| `shared/apis/parts/<api id>.json` | One part index per indexed API (section 4) |
| `shared/apis/types.ts` | `Provision`, `ModelLoading`, `DeclaredCall`, `ApiId`, `ExtensionId`, the operation types and the adapter declaration type (section 5) |
| `shared/apis/catalog.ts` | Typed access to the catalog and the indexes |
| `shared/apis/select.ts` | Candidate selection and the refusal message (section 6) |
| `shared/apis/loading.ts` | The explicit-load decision (section 7) |
| `shared/apis/adapters/<api id>.ts` | One adapter per API Banter calls (section 8), plus `declared-call.ts`, the generic adapter for `models.load` and `models.unload` |
| `shared/apis/index.ts` | The adapter registry: API id → adapter |
| `scripts/generate-api-parts.ts` | Fetches each machine-readable pinned document and writes its part index |

`shared/types.ts` loses `TtsOperation`, `TtsServiceInfo`, `TtsModelInfo` and `TtsVoiceInfo`, and `Provider` loses `responseFormat` and `sessions`. `RESPONSE_FORMATS` and `ResponseFormat` go. Every reader goes with them.

## 3. The catalog

A reference to a document in this repository has the revision `"in-repo"`: it changes with the commit that holds the catalog. Each part index's `revision` equals its catalog entry's `reference.revision`.

`catalog.json` holds two lists: `apis`, each `{ id, name, reference: { document, revision, part } }`, and `extensions`, each `{ id, adds, reference }`, with `reference` in the same shape. `revision` is a commit, or `{ read, sha256 }` for a page. No path, field or enumeration is written there.

**APIs:** `openai.audio.speech`, `openai.audio.transcriptions`, `openai.realtime`, `deepgram.listen.prerecorded`, `deepgram.listen.live`, `deepgram.speak`, `deepgram.speak.live`, `fluid.stt.stream`, `fluid.tts.stream` and `triton.model-repository`, with the references in the design's table and the pins in section 1. `openai.chat.completions` is not in Banter's catalog.

**Extensions:** the ten in the design's table, `session-claim` to `resident-slot`. The references that say "a section of this record's successor" point at `docs/reference/design/service-apis.md` (section 13), at the section with that extension's name.

## 4. Part indexes

A part name is `<kind>:<name>`. The kinds are:

| Kind | Names | Example |
|---|---|---|
| `parameter` | a request field, query parameter or connect parameter | `parameter:stream_format` |
| `value` | one value of a parameter, as `<parameter>=<value>` | `value:response_format=opus` |
| `client-message` | a message the client sends, by its wire `type` | `client-message:Configure` |
| `server-message` | a message the server sends, by its wire `type` | `server-message:UtteranceEnd` |
| `field` | a field of a message, as `<message>.<field>` | `field:Results.speech_final` |
| `mode` | a session mode or intent | `mode:conversation` |
| `route` | a route an API defines beside its main one | `route:index` |

`omits` and `only` list part names. `restricts` and `defaults` are keyed by the bare parameter name, which the index must hold as `parameter:<name>`, and a restricted value must be in the index as `value:<parameter>=<value>` wherever the index lists values for that parameter.

Each index is `{ api, revision, parts: [name...] }`. All ten indexes exist and are committed, and they are contract: a builder who needs a name the index lacks writes a brief.

- **Generated.** `openai.audio.speech`, `openai.audio.transcriptions`, `deepgram.listen.prerecorded`, `deepgram.speak`, `deepgram.listen.live` and `deepgram.speak.live` come from `scripts/generate-api-parts.ts`. The generator takes the request body or query parameters of the named operation, and each value of a closed enumeration. For the AsyncAPI channels it takes the query parameters, the client and server messages by wire `type`, and each server message's fields. A binary message is `client-message:Media` or `server-message:Audio`. The generator is run by hand, never at build or test time.
- **By hand.** `openai.realtime`, `triton.model-repository`, `fluid.stt.stream` and `fluid.tts.stream` are written from their prose references. The Realtime index names transcription-session settings by their path under `session`, for example `parameter:audio.input.format` and `value:audio.input.turn_detection=null`.

OpenAI's multipart field is indexed as `parameter:timestamp_granularities`, without brackets. An adapter sends it as `timestamp_granularities[]`, the form OpenAI's clients use.

Every API that any example provision names is indexed, whether or not Banter has an adapter for it. This settles the design's "a provision of an API with no index states no deviations": in Banter every catalog API has an index.

## 5. Declarations

### Registry

A service entry gains two optional fields:

```
provides?: Provision[]
models?:   ModelLoading

Provision    { api: ApiId, basePath?: string, omits?: string[], only?: string[],
               restricts?: { [parameter]: (string|number|boolean)[] },
               defaults?:  { [parameter]: string|number|boolean },
               extends?:   ExtensionId[] }
ModelLoading { loading: "required" | "none", autoLoad?: "always" | "never",
               resident?: "one" | "many", load?: DeclaredCall, unload?: DeclaredCall }
DeclaredCall { method: "GET"|"POST"|"PUT"|"DELETE", path: string,
               query?: { [name]: string }, body?: { [name]: string } }
```

`autoLoad` and `resident` are required when `loading` is `required`, and absent when it is `none`. An unknown key anywhere in a provision, in `models` or in a declared call is fatal. A misspelt `omits` would otherwise claim full conformance. The zod schema in `control/shared/src/live-config/schemas.ts` owns the shape; the checks in section 10 own the meaning. `schemas/platform.schema.json` gains `$defs/provision` and `$defs/modelLoading`, its `provider` loses `responseFormat` and `sessions`, and `assembledProvider` loses both and gains `provides` and `models`.

The registry `version` stays 4. Banter is not deployed, so no repair rule, migration or fallback is written.

### Config

`voice.preload: boolean`, default `true`, and `voice.stt.encodings: ("opus" | "pcm16")[]`, default `["opus", "pcm16"]`, are added to the config schema. `voice.stt.options[].sessions` goes.

### Adapters

Each adapter exports a declaration beside its code:

```
AdapterDeclaration {
  api: ApiId
  operations: Operation[]
  requires: { [operation]: string[] }      // part names or extension ids
  uses:     { [operation]: string[] }      // optional parts and extensions it uses when present
  capabilities: { [capability]: Basis[] }  // a capability holds if any basis holds
}
Basis = { part: string } | { extension: ExtensionId } | { spec: true }
```

A `{ part }` basis holds when the part is neither omitted nor excluded by `only`, nor restricted away. An `{ extension }` basis holds when the provision declares the extension. A `{ spec: true }` basis always holds; it is for what the reference itself guarantees.

The capabilities are a closed set:

| Capability | Meaning |
|---|---|
| `client-endpointing` | the client decides where an utterance ends |
| `takeover` | a session can be claimed and taken over |
| `opus` | Opus audio is accepted as input |
| `renders-progressively` | synthesis audio arrives as it renders |
| `loads-on-request` | a request naming a model loads it |
| `carries-variant` | a request can name a model's variant |
| `session-loads` | opening a session loads the named model |

`Operation` is `synthesize | transcribe | transcribeStream | loadModel | unloadModel`. `synthesizeStream` is not part of this work.

## 6. Selection

`select(operation, service, needs, preferences)`:

- `service` is `{ id, provides, models }`.
- `needs` lists the capabilities the call cannot do without, for example `client-endpointing` for streaming transcription.
- `preferences` is an ordered list of capabilities, used for ranking.

Selection works in this order:

1. Keep the provisions whose API has an adapter that performs the operation.
2. Drop each one that omits, excludes or restricts away a part the adapter `requires`, or lacks an extension the adapter `requires`.
3. Drop each one that holds no basis for a capability in `needs`.
4. Rank what remains by `preferences`, holding before not holding, compared in preference order. Ties keep `provides` order.

The result is the winning provision and its adapter. If nothing is left, it is a refusal whose message names the service id, the operation and the API ids the service declares, for example `fluid-stt cannot transcribeStream: it provides openai.audio.transcriptions, triton.model-repository`.

The voice engine's preferences for `transcribeStream` are `opus` when `voice.stt.encodings` lists `opus` before `pcm16` (or lists `opus` alone), followed by `takeover`. When `pcm16` comes first, or `opus` is absent, the engine sends pcm16 even to a provision that accepts Opus, and `opus` is not a preference. Every other operation has no preferences.

## 7. Model loading

`decideLoad(service, model, selected, preload)` implements the design's table and returns `none`, or `{ call: "adapter", provision }`, or `{ call: "declared" }`.

| Declared | Result |
|---|---|
| `loading: none`, or no `models` | `none` |
| `autoLoad: never` | an explicit load |
| the roster's model has variants, and the selected adapter lacks `carries-variant` | an explicit load naming the variant |
| the selected adapter lacks `session-loads`, and the call opens a session | an explicit load before the session |
| `autoLoad: always` | an explicit load when `preload` is true; otherwise `none` |

The rows are checked top to bottom. An explicit load uses the provision whose adapter performs `loadModel` (`triton.model-repository`), or the declared `models.load`. Never both: validation forbids it.

`decideUnload(service, leaving)` returns an unload of `leaving` when the service declares `resident: many` and has an unload call; otherwise nothing.

## 8. Adapters Banter builds

**The model name on the wire.** Every call names a model as follows:
- **Synthesis:** `resolution.model`.
- **Transcription, streaming sessions and STT loads:** the serving's `key`.
- **TTS loads:** the roster id for a `resolvesVoices` provider, otherwise the serving's `key`. This is the same name its synthesis sends.

`{model}` in a declared call and `{name}` in a Triton route both follow these rules. A fluid server maps the roster id to its runtime key itself, as `fluid-tts` does today for `kokoro-82m` (key `kokoro-ane`). A variant travels as the roster's variant id.

**Paths.** An adapter's path is the spec's own path under the spec's server address. A provision's `basePath` replaces the path part of that server address. With no `basePath`, the defaults are:

| API | Default path |
|---|---|
| OpenAI REST APIs | `/v1/audio/speech`, `/v1/audio/transcriptions` |
| `openai.realtime` | `/v1/realtime` |
| Deepgram (server root) | `/v1/listen`, `/v1/speak` |
| `triton.model-repository` (root) | `/v2/repository/...` |
| `fluid.stt.stream` and `fluid.tts.stream` (root) | `/v1/audio/stream` |

So with `basePath: "/alt"`:

| API | Path |
|---|---|
| `openai.audio.speech` | `/alt/audio/speech` |
| `openai.realtime` | `/alt/realtime` |
| `deepgram.listen.live` | `/alt/v1/listen` |
| `triton.model-repository` load | `/alt/v2/repository/models/{name}/load` |

The caller's endpoint path, such as the dsh relay's `/dsh-voice/speech/<id>`, comes before all of it.

**Failures.** Every adapter rejects a non-2xx answer with an error carrying the server's text: the body's `error` (string or `error.message`), or the raw body if it isn't JSON, prefixed by the status. The voice system shows that text and does not go live when a load fails.

Each adapter is written from its pinned reference. Paths are the spec's, prefixed by the provision's `basePath` and then by the endpoint the caller holds, which may itself carry a path (the dsh relay's `/dsh-voice/speech/<id>`). An adapter never reads a service id or capability. It sends an extension's fields only when the provision declares that extension, and it always sends the parameters it depends on.

- **`openai.audio.speech`**, `synthesize`. The body is `model`, `input`, `voice` and `speed`, the serving's `requestParams` spread in first, and `response_format`.
  - **Format.** `response_format` is the first value of `restricts.response_format` that the caller can decode (mp3, aac, wav). Without a restriction it is the first of mp3, aac and wav. The adapter returns the format it asked for, and the playback engine decodes by it. If a restriction leaves no value the caller can decode, the adapter rejects before sending any request, with a message naming the formats the service accepts.
  - **Cloned voice.** A resolution that is a recording is sent as `ref_audio`, with `ref_text` when there is a transcript, and only with `cloning-reference`. Without that extension it is refused before any request.
  - **Streaming.** With `stream-flag` it sends `stream: true` when the caller wants progressive audio.
  - **Capability.** `renders-progressively` holds on `{ spec: true }` or on `stream-flag`.
  - **Uses when present:** `parameter:stream_format`, which the voice loop never needs.
- **`openai.audio.transcriptions`**, `transcribe`. A multipart post of `file`, with `model` when the caller names one. It requires nothing beyond `parameter:file`, and returns `text`.
- **`fluid.stt.stream`**, `transcribeStream`. This is `stt-socket.ts`, moved to the adapter's place with its behaviour unchanged. It sends `session` and `takeover` only when the caller asks for take-over.
  - **Capabilities:** `client-endpointing` and `opus` on `{ spec: true }`, `takeover` on `{ part: "parameter:session" }`, `carries-variant` on `{ part: "parameter:chunkMs" }`, and `session-loads` on `{ spec: true }`.
- **`deepgram.listen.live`**, `transcribeStream`, built in step T3.
  - **Connect.** It connects with `encoding` (`opus` or `linear16`), `sample_rate`, `channels=1`, `interim_results=true` and `endpointing=false`, plus `model` when named.
  - **Messages.** It sends `Finalize`, `KeepAlive` and `CloseStream`. Each `Results` is accumulated into the utterance so far, which goes out as a partial, and exactly one final is answered per `Finalize`.
  - **Finalize.** With `finalize-answered` it settles on the result marked `from_finalize`. Without it, it settles on the first `from_finalize` result or after 3000 ms, whichever comes first.
  - **Capabilities:**
    - `client-endpointing` on `{ extension: "endpointing-off" }`;
    - `opus` on `{ extension: "opus-packets" }` together with an `encoding` that has not been restricted away from `opus`;
    - `takeover` on `{ extension: "session-claim" }`;
    - `session-loads` on `{ part: "parameter:model" }`.
- **`openai.realtime`**, `transcribeStream`, built in step T3.
  - **Resampling.** The engine hands every `transcribeStream` adapter the same audio: Opus packets, or 16 kHz mono pcm16. This adapter resamples pcm16 to 24 kHz before appending it.
  - **Ready.** It calls `onReady` on `session.updated`. The `deepgram.listen.live` adapter calls it when the socket opens.
  - **Opening.** It opens `<path>?intent=transcription` and sends `session.update` with `session.type: "transcription"`, `turn_detection: null`, and an input format of `{ type: "audio/pcm", rate: 24000 }`. With `opus-input` it can instead send `{ type: "audio/opus", rate: 48000 }`, with each `input_audio_buffer.append` carrying one raw Opus packet as WebCodecs emits it (48 kHz mono), base64-encoded.
  - **Turns.** Audio goes as `input_audio_buffer.append` and a finalize as `input_audio_buffer.commit`. A finalize with no audio since the last commit is answered with an empty final and no commit.
  - **Transcripts.** Deltas accumulate per `item_id`. Finals are released in commit order, matched by `item_id`.
  - **Capabilities:** `client-endpointing` on `{ spec: true }`, and `opus` on `{ extension: "opus-input" }`. It has no `session-loads`.
- **`triton.model-repository`**, `loadModel` and `unloadModel`.
  - `POST <base>/v2/repository/models/{name}/load` with `{"parameters": {...}}` carrying `mode` and `variant` when given, and only with `resident-slot`.
  - `POST .../unload`.
  - Success is a 200. Failure is a status with `{"error": ...}`, which becomes the refusal's text.
- **`declared-call`**, `loadModel` and `unloadModel`, from `models.load` and `models.unload`. It substitutes `{model}` in the path, query and body with the serving's `key`.

`select` treats `models.load` and `models.unload` as a load call when no provision performs one.

**Declarations.** Every adapter's declaration lands in T1, so selection and validation can be tested there. The wire code lands in T2, or in T3 for the last two rows.

| API | Operations | Requires | Uses when present |
|---|---|---|---|
| `openai.audio.speech` | `synthesize` | `parameter:input`, `parameter:response_format` | `parameter:voice`, `parameter:speed`, `cloning-reference`, `stream-flag` |
| `openai.audio.transcriptions` | `transcribe` | `parameter:file` | `parameter:model`, `parameter:response_format` |
| `fluid.stt.stream` | `transcribeStream` | `client-message:Finalize`, `server-message:transcript` | `parameter:session`, `parameter:takeover`, `parameter:chunkMs`, `value:format=opus` |
| `triton.model-repository` | `loadModel`, `unloadModel` | `route:load` (load), `route:unload` (unload) | `resident-slot` |
| `deepgram.listen.live` | `transcribeStream` | `client-message:Finalize`, `server-message:Results`, `parameter:endpointing` | `client-message:KeepAlive`, `client-message:CloseStream`, `parameter:model`, `finalize-answered`, `session-claim`, `opus-packets` |
| `openai.realtime` | `transcribeStream` | `mode:transcription`, `client-message:session.update`, `client-message:input_audio_buffer.append`, `client-message:input_audio_buffer.commit`, `server-message:input_audio_buffer.committed`, `server-message:conversation.item.input_audio_transcription.completed` | `server-message:conversation.item.input_audio_transcription.delta`, `client-message:input_audio_buffer.clear`, `opus-input` |

Capabilities are as stated per adapter above.

## 9. The fluid servers

Swift, in `services/fluid/`. The design's sections "Model loading" and "What the fluid servers provide" are the contract. This section settles the rest.

**Startup.** Each server reads `services[]` for its `--provider` id from the registry it already reads, and decodes `provides`. It refuses to start, with a message naming the API or part, when:
- an entry claims an API its build does not serve;
- the build lacks a part of an API that the entry does not list in `omits` or exclude by `only`.

Each server holds, in code, the list of APIs it serves and the parts of each that it lacks. The check is that list against the entry. `defaults` values are read from the entry, and the listen route's `endpointing` default comes from `provides[deepgram.listen.live].defaults.endpointing`. With none declared, the spec's default applies.

**Routes, by step.**

| Step | `fluid-stt` | `fluid-tts` |
|---|---|---|
| S1 | adds `triton.model-repository`; `ensure` replaces an idle model on request under the design's rules | adds `triton.model-repository`; `/v1/audio/speech` streams without `stream`, and `stream_format=sse` is implemented |
| S2 | `deepgram.listen.live` conformance; `deepgram.listen.prerecorded`; `stream=true` on transcriptions; the Realtime transcription subset at `/v1/realtime` | `deepgram.speak` at `POST /v1/speak`; `deepgram.speak.live` at WebSocket `/v1/speak`; the Realtime subset at `/v1/realtime`; `TTS-STREAM.md` |
| S3 | removes `POST /v1/models/load`, `POST /v1/models?model_name=`, `POST /v1/models/unload`, `DELETE /v1/models` | removes `POST /v1/models/load`, `POST /v1/models?model_name=`, `DELETE /v1/models` |

`GET /v1/models` and `/healthz` stay on both servers. The listing is not something Banter calls (section 11), but `fluid-smoke.sh` and people read it.

**Triton routes.**
- `load` with an empty `parameters` loads the roster default mode for a single-mode model. A `both` model without `mode` is refused with 400.
- A load of the resident model, with the same variant and an already-loaded mode, is a 200 and changes nothing.
- A load that would change the model while a session holds the server is a 409.
- `index` returns `[{name, state, reason}]`, with `state` `READY` for the resident model and `UNAVAILABLE` for the others.

**`fluid-stt` on demand.** The design's "The servers the platform builds", rule for rule. `modelMismatch` goes. A request naming another model while idle replaces the resident one once in-flight work ends. So does a request naming another variant of the resident model: a variant is a different model for this rule. Anything while a session holds the server is refused at once.

**`deepgram.listen.live` conformance (S2).**
- `encoding` accepts `opus` (one raw packet per binary message) and `linear16`; anything else closes with 4007.
- `endpointing=false` turns the segmenter off.
- `model` is honoured as on the stream socket.
- `session` and `takeover` claim as on the stream socket.
- Every `Finalize` is answered by exactly one `Results` with `from_finalize: true`, including an empty one.
- A refusal or displacement closes with its 4001–4010 code and sends no frame.
- An unparseable client message gets an `Error` message and the stream stays open.
- `KeepAlive` and `CloseStream` are honoured. `Configure` is omitted.

**Realtime subsets (S2).**
- `fluid-stt` implements `session.update` (transcription session only), `input_audio_buffer.append`, `input_audio_buffer.commit` and `input_audio_buffer.clear`. It answers with `session.created`, `session.updated`, `input_audio_buffer.committed`, `input_audio_buffer.cleared`, `conversation.item.input_audio_transcription.delta` and `.completed`, and `error`.
- `fluid-tts` implements `session.update`, `response.create` (speaking the text of `input_text` parts verbatim) and `response.cancel`, answering with `session.created`, `session.updated`, `response.created`, `response.output_audio.delta`, `response.output_audio.done`, `response.done` and `error`, in 24 kHz PCM.
- Any other client event is answered with `error`.
- The provisions list exactly these under `only`.

**Example provisions.** Section 12 gives the provisions at each step. The servers' conformance tests check each provision the server claims against its routes.

## 10. Validation at registry load

These checks are in a new `control/shared/src/provisions.ts`, called from `validateRoster(roster, services)`. The fluid example is a fragment that tests validate only through `validateRoster`, so this is how its provisions get checked. The checks run on the parsed objects, so they also catch unknown keys, which the non-strict zod sync would otherwise pass with a warning. Each failure throws a `registry.json roster:` or `registry.json services:` error, as the existing checks do, and is fatal at startup and refused at reload.

1. A service lists an API once.
2. A `basePath` begins with `/` and does not end with one.
3. `omits` and `only` do not both name parts of the same kind.
4. Every `api` and every `extends` entry is in the catalog.
5. Every name in `omits` and `only`, and every key in `restricts` and `defaults`, is in that API's part index. Every restricted value is in the index where the index lists values for that parameter.
6. A service with `loading: required` and `autoLoad: never` has a load call. So does a service serving a roster model with `variants`, unless one of its provisions' adapters holds `carries-variant` for an operation the service is called for.
7. A service never has both a provision whose adapter performs `loadModel` and a `models.load`.
8. A `DeclaredCall` has a method, a path beginning with `/`, and no placeholder but `{model}`.
9. A service Banter calls has a candidate for what it is called for:
   - a TTS provider: `synthesize`;
   - a provider serving a `streaming` STT model: `transcribeStream`;
   - a provider serving a `batch` STT model: `transcribe`;
   - a provider serving a `both` model: either one.
   
   "Banter calls" means a roster provider names the service.

The config's selections are not checked at load. A selection can name a provider on a shard, which the control plane's own roster doesn't hold until that shard is polled. The existing selection route keeps guarding them as it does now.

No sync or repair rule writes `provides` or `models`.

## 11. Banter's callers

**What `GET /api/voice` serves.**
- `tts.providers[]` loses `responseFormat` and `sessions`, and gains `provides` and `models`.
- `stt.options[]` loses `sessions` and gains `provides`, `models` and `serves: {model, key}[]`.
- `stt.models` is added: the roster's `sttModels`, with `kind`, `params` and `variants`.
- `tts.selection.request` and `requestError` become `tts.selection.resolution` and `resolutionError`. A resolution is `{ model: string, voice: { name: string } | { recording: string, transcript?: string }, params?: object }`, where `model` is the serving's key, or the roster id for a `resolvesVoices` provider.

`buildSpeechRequest` becomes `resolveSpeech` and returns a resolution, and `POST /api/voices/resolve` on the shard returns one. The resolution rule and its shared cases are unchanged, apart from the fixture losing `responseFormat` and `sessions`.

`/api/services` and `/api/services/:id` serve `provides` and `models` with each service. `GET /api/services/:id/info` goes, with its shard proxy and `proxyShardInfo`.

**The voice engine.**
- **Speech.** The playback engine's speech call becomes `synthesize` through the selected adapter. `SpeakRequest` carries the resolution, the provision and the endpoint, and its `format` is what the adapter returns. `AudioFormat` stays mp3, aac or wav.
- **Batch transcription.** `stt-client.ts` becomes the transcribe path through `openai.audio.transcriptions`.
- **Streaming transcription.** `StreamingSttTransport` holds the adapter that `select` returns for `transcribeStream`, with `needs: [client-endpointing]`. It sends Opus only when the provision holds `opus` and the browser can encode it.
- **Mode.** `resolveSttMode` reads `kind` from `stt.models` and the candidates from `select`, not from `GET /v1/models`, and `fetchSttModelFacts` goes. `chunkMs` values come from the model's `params`. Whether weights are present on the server is no longer shown. A load of an absent model fails with the server's own message.
- **Loads.** The voice system decides them with `decideLoad` and performs them through the adapters, in the engine. The injected `loadTtsModel`, `loadSttModel` and `fetchSttModelFacts` services go from the dashboard's `voice-service.ts` and the dsh plugin's `services.ts`. Both keep `ensureServiceReady`, which supplies the endpoint.
- **Unloads.** On a model change, the settings page's unload becomes the engine's `decideUnload`.
- **Take-over.** `session` and `takeover` are sent, and a `held` close leads to the take-over dialog, only when the selected streaming provision holds `takeover`. The dashboard's take-over switch shows on the same condition, read from the selected STT option alone.

**The dsh plugin.**
- The relay registers its WebSocket upgrade route at each WebSocket path the selected STT service's `transcribeStream` candidates use (`basePath` plus the spec path), in place of the fixed `/v1/audio/stream`.
- A relay test shows that query parameters and close codes 4001–4010 reach the browser unchanged.
- The plugin gains `@platform/shared` as a dependency if it imports from it directly.

## 12. Example registries and fixtures

The two node registries (`control/control-plane/data/registry.example.json` and `control/control-shard/data/registry.example.json`) register `stt-faster-whisper` and `tts-kokoro`. They state the following from step T1 on, since T1's checks load them:

- `stt-faster-whisper`:
  - `provides`: `openai.audio.transcriptions`, which omits `parameter:languages`, `parameter:keywords`, `parameter:prompt`, `parameter:temperature`, `parameter:include`, `parameter:timestamp_granularities`, `parameter:stream`, `parameter:chunking_strategy`, `parameter:known_speaker_names` and `parameter:known_speaker_references`, and restricts `response_format` to `["json", "text"]`;
  - `models`: `{ loading: "none" }`.
- `tts-kokoro`:
  - `provides`: `openai.audio.speech`, which omits `parameter:instructions` and `parameter:stream_format`, and restricts `response_format` to `["wav"]`;
  - `models`: `{ loading: "required", autoLoad: "always", resident: "one", load: { method: "POST", path: "/v1/models", query: { model_name: "{model}" } }, unload: { method: "DELETE", path: "/v1/models", query: { model_name: "{model}" } } }`.

The guides' snippets for `stt-whisper` and `tts-neutts-air` say the same. `stt-whisper` is as `stt-faster-whisper`. `tts-neutts-air` restricts `response_format` to `["wav", "mp3"]` and has `models: { loading: "none" }`. Neither declares `stream-flag`, because neutts-air's stream ignores the format.

`services/fluid/registry.fluid.example.json`:

Both fluid servers state `models: { loading: "required", autoLoad: "always", resident: "one" }` at every step, with no declared calls. Check 6 is met at T1 without one: Nemotron's variants travel over `fluid.stt.stream`, which holds `carries-variant`. The provisions:

**T1** (written by the TypeScript builder, read by no client until T2):
- **`fluid-stt`:**
  - `fluid.stt.stream`;
  - `openai.audio.transcriptions`, which omits `parameter:language`, `parameter:languages`, `parameter:keywords`, `parameter:prompt`, `parameter:temperature`, `parameter:include`, `parameter:stream`, `parameter:chunking_strategy`, `parameter:known_speaker_names` and `parameter:known_speaker_references`, and restricts `response_format` to `["json", "text", "verbose_json"]`.
- **`fluid-tts`:** `openai.audio.speech`, which omits `parameter:instructions` and `parameter:stream_format`, restricts `response_format` to `["aac", "wav", "pcm"]`, and extends `stream-flag` and `cloning-reference`.

**S1:**
- **`fluid-stt`** adds `triton.model-repository` extending `resident-slot`.
- **`fluid-tts`** adds the same. Its `openai.audio.speech` loses `stream-flag` and the `parameter:stream_format` omission.

**S2:**
- **`fluid-stt`:**
  - `openai.audio.transcriptions` loses the `parameter:stream` omission and gains `value:timestamp_granularities=segment` (the build never returns segments).
  - `triton.model-repository` omits `field:index.version`, on both servers.
  - `deepgram.listen.prerecorded` omits every query parameter in its index except `model`, `encoding` and `sample_rate`.
  - `deepgram.listen.live`:
    - omits every query parameter except `model`, `encoding`, `sample_rate`, `channels`, `interim_results` and `endpointing`;
    - omits `client-message:Configure`, `server-message:ConfigureSuccess`, `server-message:ConfigureFailure`, `server-message:UtteranceEnd` and `server-message:SpeechStarted`;
    - restricts `encoding` to `["opus", "linear16"]`;
    - `defaults: { endpointing: 700 }`;
    - extends `session-claim`, `finalize-answered`, `endpointing-off` and `opus-packets`.
  - `openai.realtime`, with `only` the client and server messages in section 9 plus `mode:transcription`, extending `opus-input`.
- **`fluid-tts`:**
  - `openai.audio.speech` declares `defaults: { response_format: "aac" }`, where the spec's default is mp3.
  - `deepgram.speak`: omits every query parameter except `model`, `encoding`, `container`, `sample_rate` and `speed`; restricts `encoding` to `["aac", "linear16"]`; extends `voice-param` and `cloning-reference`.
  - `deepgram.speak.live`: restricts `encoding` to `["linear16"]`; extends `voice-param`, `cloning-reference` and `session-claim`.
  - `openai.realtime`, with `only` the messages in section 9 plus `mode:conversation`, extending `verbatim-speech`.
  - `fluid.tts.stream`.

At S2 the Swift builder confirms each of these against its build. Any difference goes to a brief, never a silent edit.

Test fixtures that register a roster provider give it a minimal valid `provides`. That is one provision of the API its capability needs, for example `openai.audio.speech` for a TTS provider. Fixtures that only list services with no provider are untouched.

## 13. Docs (step D)

The docs describe the current state. They name no people and say nothing about which services an install runs.

- `docs/reference/components/registry.md`: `provides`, `models` and the new checks.
- `docs/reference/configuration.md`: `voice.preload` and `voice.stt.encodings`.
- `docs/reference/components/stt.md` and `tts.md`.
- `docs/reference/speech-server-api.md`, rewritten as which APIs each built server provides, by catalog id.
- `docs/reference/design/voice-system.md`, `model-roster.md`, `fluid-stt-on-demand-load.md` and `fluid-server-streaming-and-structure.md`.
- The guides' registry snippets.
- `services/README.md`.
- `services/fluid/STT.md`, including `/listen` and the stale lines the mapping found: a 2 s busy wait, "the socket will not load it", and the 2 s supersede wait.
- `services/fluid/DEVELOPING.md`'s streaming interval.

`dev/design/service-apis.md` becomes `docs/reference/design/service-apis.md`. It is revised to Banter's form: the platform-only callers come out, the extension sections it promises are written, and it says what the build taught. `dev/analysis/service-api-binding.md` is deleted in cleanup.

`dev/design/platform-divergence.md` gains a "Banter is ahead" entry for the service APIs, naming the commits platform should take.

## 14. Departures from the design

- **The shard's `/svc/<id>` forwarder is absent.** The dsh relay is the only node-side WebSocket forwarder Banter has (section 11).
- **No `chat` operation.** Banter has no LM Studio client and no `chat` selection in `config.json`.
- **The voice engine owns loading.** It performs loads itself through the adapters, where platform's dashboard injects load functions. This is so the dashboard and the dsh plugin share one implementation.
- **Every catalog API has a part index**, including those with no Banter adapter.
- **`stt.models` is served in `/api/voice`.** It replaces the engine's read of `GET /v1/models`, since the roster declares the models.
- **`session-loads` on `deepgram.listen.live` rests on `parameter:model`.** The design does not say whether a Deepgram session loads, and Deepgram's spec says nothing of loading. Whether a request actually loads still comes from the service's `autoLoad`, through `decideLoad`.
- **The `deepgram.listen.live` adapter's finalize wait is 3000 ms** where the server does not declare `finalize-answered`. The design leaves the bound unset.

## 15. Smoke checks and file ownership

`scripts/fluid-smoke.sh` and `scripts/fluid-smoke-listen.ts` are tests, written with the other tests before the build and frozen for the builders. They change by step:
- **At S1,** the load and unload checks move to the Triton routes. A check is added that a speech request without `stream` arrives in more than one chunk for a streaming model.
- **At S2,** checks are added that `/v1/listen` answers a `Finalize` sent with no audio with one empty `from_finalize` result, and that `endpointing=false` leaves an utterance open past 700 ms of silence.
- **At T3,** `scripts/fluid-smoke-adapters.ts`, also run by `fluid-smoke.sh` against its scratch servers, drives the `deepgram.listen.live` and `openai.realtime` adapters through one utterance each, and checks one final per finalize.

T3's adapters are verified inside that sandboxed scratch deploy and never against a separately started server, because an explicit load of a model with no weights on disk downloads them. The baseline records which models are on disk. A smoke run that skips the STT checks is not green.

| File | Owner, by step |
|---|---|
| `services/fluid/registry.fluid.example.json` | TypeScript builder at T1; Swift builder from S1 |
| `services/fluid/**` otherwise | Swift builder |
| the smoke scripts | the tests' author; frozen for both builders |
| everything else in the repo | TypeScript builder |

## 16. Steps and sync points

**TypeScript builder:**
- **T1, contract:** sections 2 to 7 and 10, and every adapter's declaration (section 8's table), but no wire code; the removal of `TtsOperation` and the `/info` route; the T1 example provisions. Sync point A.
- **T2, cutover:** sections 8 (except the two T3 adapters), 11 and 12, and the removal of `responseFormat` and `sessions`. Starts after S1.
- **T3:** the `deepgram.listen.live` and `openai.realtime` adapters, verified against the local servers. Starts after S2.

**Swift builder** (starts at A):
- **S1:** startup reading and the check; Triton routes; on-demand loading; speech streaming without a flag, and SSE. Sync point B.
- **S2:** the standard APIs and `TTS-STREAM.md`. Sync point C.
- **S3:** the old load routes removed. Starts after T2 has merged.

**D:** docs, after everything is green.

## 17. Done means

- Every gate is green:
  - control: `bun test` in `control/`;
  - shared: `bun test` in `shared/`, which runs the tests beside `shared/apis/`;
  - dashboard and voice engine: `bun run test`, `bun run lint` and `bunx tsc -b` in `dashboard/`, and `bun run lint` in `voice-engine/`;
  - dsh plugin: `bun run test`, `bun run lint` and `bunx tsc -p .` in `plugins/dsh/voice/`;
  - Swift: `swift test` in `services/fluid/`;
  - `scripts/fluid-smoke.sh`.
- No non-test TypeScript source outside `shared/apis/adapters/` contains a path to a speech service: `/v1/audio/speech`, `/audio/transcriptions`, `/v1/audio/stream`, `/v1/listen`, `/v1/realtime`, `/v1/models` or `/v2/repository`. Registry data, schemas, Swift, scripts and docs are not covered.
- No source reads `responseFormat`, `sessions`, `TtsOperation` or `capabilityId` to choose a call.
