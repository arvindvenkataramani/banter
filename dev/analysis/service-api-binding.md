# How Banter knows how to call a service: research findings

Explore-stage findings for one question: given a service in the registry, how does Banter know which calls to make to it? Researched 2026-11-23 from primary specs, project docs and framework source. Claims carry a source link; those taken from a search snippet or secondary page are marked *secondary*. What could not be checked is listed at the end.

## What the registry says today

A service entry records what it does (`capabilityId`: `tts`, `stt`, `llm`, `research`), where it listens (`network.port`, `healthPath`), and how to run it (`runner`, `lifecycle`). Nothing records the interface it exposes. Callers infer it from the capability: `tts` is taken to mean OpenAI's `/v1/audio/speech`, `llm` OpenAI chat completions. That inference fails inside a single capability. Under `research`, `zotero-mcp` speaks MCP and `pdf-ocr` serves a custom `POST /process`, whose only description is prose in its `notes` field.

The client side fixes the shape per operation in code. `voice-engine` sends synthesis to `/v1/audio/speech` on whichever TTS runtime is selected (`voice-engine/src/system/playback-engine.ts`), batch transcription to `/audio/transcriptions` (`voice-engine/src/human/stt-client.ts`), and streaming transcription to `/v1/audio/stream` (`voice-engine/src/human/stt-socket.ts`), a WebSocket protocol specific to the fluid services. The control shard's media jobs also call `/v1/audio/speech`. The services serve more shapes than the client uses: `fluid-stt` serves OpenAI transcription, Deepgram's `/v1/listen` over both REST and WebSocket, and its own `/v1/audio/stream`; `fluid-tts` serves `/v1/audio/speech` and its own `/v1/audio/stream`.

An earlier form of self-description survives in `shared/types.ts`: `TtsOperation` (`path`, `method`, `contentType`, `responseType`) for a `synth` and an optional `stream` operation, returned from a service's `/info` route and proxied by `GET /api/services/:id/info`. Nothing reads it to choose a call.

The shard roster's `providers` section carries per-provider flags (`sessions`, `responseFormat`, `resolvesVoices`) that describe how a TTS provider differs from an unstated base API. They are the nearest thing to an interface declaration the registry holds, and they exist only for TTS.

## Discovery and conformance standards

**RFC 9727** (Standards Track, June 2025) defines `/.well-known/api-catalog`, returning an `application/linkset+json` document whose `item` entries each link a `service-desc` (machine-readable description, such as an OpenAPI document), `service-doc`, `service-meta` and `status`, the last four from RFC 8631. It answers where a service's API descriptions live. It has no vocabulary for which API a service implements or which features it supports. [RFC 9727](https://www.rfc-editor.org/rfc/rfc9727.html), [RFC 8631](https://www.rfc-editor.org/rfc/rfc8631.html)

**OGC API conformance** is the clearest existing pattern for declaring what a service implements. `GET /conformance` returns `{"conformsTo": [uri, ...]}`, each URI naming a conformance class, such as `http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core`. A client string-matches the classes it knows and ignores the rest. Optional parts of a standard are separate classes, so the same list declares both the base API and its features. [OGC 17-069r4](https://docs.ogc.org/is/17-069r4/17-069r4.html)

**OpenAPI** 3.1 and 3.2 have no field for "this API implements standard X", and no widely adopted `x-` extension for it was found. 3.2 (September 2025) adds `itemSchema` for streaming and sequential media types. *Secondary:* [upgrade guide](https://learn.openapis.org/upgrading/v3.1-to-v3.2.html)

**AsyncAPI** is the description format for WebSocket and event-driven APIs. A third-party AsyncAPI 2.6 document of OpenAI's Realtime API exists; no official one was found. Backstage accepts `asyncapi` as an API type. *Secondary:* [apis.io](https://apis.io/asyncapis/openai/openai-realtime-asyncapi/)

**MCP** has its own discovery. Server Cards (SEP-2127, final) are static metadata at `<streamable-http-url>/server-card`, carrying name, version, transport endpoints and `supportedProtocolVersions`, and deliberately no capability list; clients read capabilities live from the server. The MCP registry's `server.json` names transports as `stdio`, `streamable-http` or `sse`. [SEP-2127](https://modelcontextprotocol.io/seps/2127-mcp-server-cards), [server.json](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/generic-server-json.md)

**Service catalogs** declare the interface as a type string plus a pointer. Backstage's API entity has `spec.type` (well-known values `openapi`, `asyncapi`, `graphql`, `grpc`, any other string accepted) and a definition; a component lists `providesApis`. Kubernetes Services carry a free-form `appProtocol` per port. [Backstage](https://backstage.io/docs/features/software-catalog/descriptor-format/), *secondary:* [Istio](https://istio.io/docs/ops/configuration/traffic-management/protocol-selection/)

**"OpenAI-compatible" has no conformance identifiers.** No URIs, profiles or test suite define it for third-party servers. Capability vocabularies exist per runtime and none is shared: OpenRouter lists `supported_parameters` per model, LM Studio a `capabilities` object, Ollama a `capabilities` array. Open Responses publishes an acceptance suite for its own spec. [OpenRouter](https://openrouter.ai/docs/guides/overview/models.md), *secondary:* [LM Studio](https://lmstudio.ai/docs/developer/rest/list), [Ollama](https://docs.ollama.com/api-reference/show-model-details.md), [Open Responses](https://www.openresponses.org/compliance)

## The speech API landscape

There is one formal speech-server standard, MRCPv2 ([RFC 6787](https://www.rfc-editor.org/rfc/rfc6787)), which needs SIP and RTP and lives in telephony. Everything Banter would meet is a de facto vendor shape.

| API | Transport | Text in | Audio out | Copied by |
|---|---|---|---|---|
| [OpenAI `/v1/audio/speech`](https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create) | HTTP, one request | whole text | streamed bytes, or SSE via `stream_format` | Kokoro-FastAPI, Speaches, LocalAI, mlx-audio |
| [OpenAI `/v1/audio/transcriptions`](https://developers.openai.com/api/docs/guides/speech-to-text) | HTTP multipart | — | text; deltas with `stream=true` on newer models | Speaches, mlx-audio |
| [OpenAI Realtime](https://developers.openai.com/api/docs/guides/realtime) | WebSocket or WebRTC | streamed | streamed | Speaches, Kokoro-FastAPI (TTS only) |
| [ElevenLabs stream-input](https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-stream-input) | WebSocket, voice in path | streamed, `flush`, empty text ends | base64 chunks + alignment | Kokoro-FastAPI |
| [Cartesia](https://docs.cartesia.ai/api-reference/tts/websocket) | WebSocket | streamed under a `context_id` with `continue` | base64 chunks + timestamps | Kokoro-FastAPI |
| [Deepgram live STT](https://developers.deepgram.com/reference/speech-to-text/listen-streaming) | WebSocket | audio in | interim and final transcripts with word timings | — |
| [Deepgram REST TTS](https://developers.deepgram.com/reference/text-to-speech/speak-request) | HTTP, one request | whole text | audio bytes | — |
| [Deepgram streaming TTS](https://developers.deepgram.com/reference/text-to-speech-api/speak-streaming) | WebSocket | streamed, typed messages | raw binary frames, no word timing | — |
| [Wyoming](https://github.com/OHF-Voice/wyoming) | TCP, JSON header line + binary payload | events | PCM chunk events | Home Assistant, Piper, Faster Whisper, openWakeWord |

The OpenAI REST shapes are what self-hosted servers copy. They cover one-shot synthesis and transcription, and stop there: no streamed text in, and no standard field for cloning reference audio, which servers add as extensions. Streamed text in exists only in session protocols (ElevenLabs, Cartesia, Realtime, our `fluid-tts` sessions), each with its own message vocabulary. whisper.cpp's server uses its own `POST /inference` rather than the OpenAI route. Wyoming is the one vendor-neutral local protocol, and it declares what a server offers through a `describe`/`info` exchange at connection time.

### OpenAI and Deepgram in detail

Between them, the two vendors cover every speech operation Banter makes, and both publish machine-readable descriptions of their APIs.

OpenAI publishes an OpenAPI 3.1 spec at [openai/openai-openapi](https://github.com/openai/openai-openapi), synced from its upstream source. It covers `createSpeech` (`POST /audio/speech`, JSON body, binary audio or `text/event-stream` back) and `createTranscription` (`POST /audio/transcriptions`, multipart). The spec marks `tts-1`, `tts-1-hd` and `gpt-4o-mini-tts` as shutting down on 2027-01-06 and points to the Realtime API instead, so OpenAI's own TTS is moving off the REST shape that self-hosted servers copy. The shape outlives OpenAI's use of it, because servers implement it independently of OpenAI's models. The Realtime WebSocket API is not in the OpenAPI file.

Deepgram serves an OpenAPI 3.1 spec at [developers.deepgram.com/openapi.yaml](https://developers.deepgram.com/openapi.yaml) and an AsyncAPI 2.6 spec at [developers.deepgram.com/asyncapi.yaml](https://developers.deepgram.com/asyncapi.yaml), mirrored hourly to [deepgram/deepgram-api-specs](https://github.com/deepgram/deepgram-api-specs) under CC-BY-4.0. Both are generated and carry quirks: shared enums on control messages, some numbers typed as strings, a binary TTS response declared as JSON.

Deepgram's three speech APIs:

- **REST TTS**, `POST /v1/speak`. The body is `{"text": …}` and nothing else; `model`, `encoding` (`linear16`, `flac`, `mulaw`, `alaw`, `mp3`, `opus`, `aac`), `container`, `sample_rate`, `bit_rate` and `speed` are query parameters. The response is the audio bytes.
- **Streaming TTS**, `wss://api.deepgram.com/v1/speak` with `model`, `encoding` (`linear16`, `mulaw`, `alaw`, no containers), `sample_rate` and `speed` fixed at connect. The client sends `{"type":"Speak","text":…}`, `{"type":"Flush"}`, `{"type":"Clear"}` and `{"type":"Close"}`. The server sends audio as raw binary frames, with JSON `Metadata`, `Flushed` and `Cleared` (each `Flushed`/`Cleared` carrying a `sequence_id`) and `Warning`. `Clear` discards queued audio, which is what barge-in needs. There is no word timing. Limits: 2000 characters per message, 2400 characters a minute, 20 flushes a minute, 60 minutes per connection.
- **Live STT**, `wss://api.deepgram.com/v1/listen` with `model`, `encoding`, `sample_rate`, `interim_results`, `endpointing`, `utterance_end_ms`, `vad_events` and formatting options as query parameters. The client sends binary audio and `Finalize`, `KeepAlive`, `CloseStream` and `Configure` messages. The server sends `Results` (`is_final`, `speech_final`, alternatives with per-word `start`, `end` and `confidence`), `Metadata`, `UtteranceEnd`, `SpeechStarted` when `vad_events` is set, and `Error`.

### OpenAI Realtime, read 2026-11-24

The Realtime API has a transcription-only mode, and no text-to-speech mode. Sources: [realtime transcription guide](https://developers.openai.com/api/docs/guides/realtime-transcription), [client events](https://developers.openai.com/api/reference/resources/realtime/client-events), [server events](https://developers.openai.com/api/reference/resources/realtime/server-events), [VAD guide](https://developers.openai.com/api/docs/guides/realtime-vad), [migration notes](https://developers.openai.com/api/docs/guides/realtime). Event names below are GA; the `OpenAI-Beta: realtime=v1` header is gone.

**Transcription mode.** A client opens `wss://…/v1/realtime?intent=transcription` (no `model` in the URL, which would create a conversation session) and sends `session.update` with `session.type: "transcription"` and `session.audio.input` holding `format` (`{type: "audio/pcm", rate: 24000}`, the only PCM rate, or G.711 `audio/pcmu`/`audio/pcma`), `transcription` (`model`, `language` or `languages`, `prompt`, `keywords`), `turn_detection` (`null`, `server_vad` or `semantic_vad`) and `noise_reduction`; `include: ["item.input_audio_transcription.logprobs"]` sits beside it. Audio goes up as `input_audio_buffer.append` with base64 bytes in the configured format; `input_audio_buffer.commit` closes a turn and `input_audio_buffer.clear` discards the buffer. The server answers `session.created`, `session.updated`, `input_audio_buffer.committed` (carrying the new `item_id`), `input_audio_buffer.cleared`, `speech_started`/`speech_stopped` when VAD is on, then per item `conversation.item.input_audio_transcription.delta` (incremental text, not the whole so far), `.completed` (`transcript`) or `.failed`, and a generic `error` event after which the session usually stays open. With turn detection `null` the client commits each turn and the guide's flow resolves one completed transcript per committed `item_id`; completions from different turns are not guaranteed to arrive in order. Committing an empty buffer is an error, with the error code undocumented. `gpt-live-transcribe` requires turn detection off and streams deltas as speech arrives; whether older models stream deltas is not stated.

This maps onto the voice loop's needs directly: the client decides turns (commit), discards (clear), and gets partials and one final per turn. Two differences from what the loop relies on: deltas are incremental, so an adapter accumulates them, and an empty turn is an error where the loop expects an empty final. Input is PCM or G.711 only, so there is no Opus transport; at 24 kHz PCM16 that is about 384 kbit/s before base64, against the 21.8 kbit/s Opus the loop measured.

**No TTS mode.** Audio output only comes from `response.create`, which always runs a model (`instructions`, `output_modalities`, `conversation: "none"` for out-of-band responses). Reading text verbatim would mean prompting the model to repeat it, and the docs say instructions are not guaranteed to be followed. Output audio is `response.output_audio.delta` (base64) in 24 kHz PCM16 or G.711, with voices fixed once audio has been produced. OpenAI points plain TTS at REST `/audio/speech`. A separate GPT-Live API (`/v1/live/sessions`) has its own event set and is not Realtime.

**Self-hosted servers implement subsets of Realtime, each declaring its own.** Read in source on 2026-11-24:

- [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI/blob/master/api/src/routers/openai_realtime.py) serves `/v1/realtime` as TTS only. It accepts `session.update`, `response.create` and `response.cancel`, and answers anything else with an `error`. It reads the text of `input_text` parts in `response.input` and speaks it verbatim, ignoring `instructions`. Its events use GA names, from `response.created` through `response.output_audio.delta` to `response.done`, and its audio is 24 kHz PCM only. wyoming_openai uses it as a Realtime TTS client. This is precedent for exactly the limited TTS mode discussed above.
- [Speaches](https://github.com/speaches-ai/speaches/tree/master/src/speaches/realtime) serves `/v1/realtime` in conversation mode (STT, then an LLM through `CHAT_COMPLETION_BASE_URL`, then TTS) and in `intent=transcription` mode. Its source emits only `…transcription.completed` per commit, with no deltas, requires at least 100 ms of audio per commit, uses beta event names, and accepts 24 kHz PCM resampled to 16 kHz.
- [vLLM](https://docs.vllm.ai/en/latest/serving/online_serving/speech_to_text/) serves an STT-only `/v1/realtime` with its own event names (`transcription.delta`, `transcription.done`), not OpenAI's, and 16 kHz PCM.
- [LocalAI](https://localai.io/docs/api/openai-realtime/index.html) runs a full pipeline per model (VAD, transcription, LLM, TTS) with GA names, and has no TTS-only or STT-only mode.

No implementation accepts Opus input.

**Spec.** No official AsyncAPI document was found, and `openai/openai-openapi` describes the REST API. The authoritative Realtime schemas are the generated reference pages above (each also served as `.md`), with schema names such as `RealtimeClientEventSessionUpdate` and `RealtimeTranscriptionSessionCreateRequest`; the SDKs generate their types from them.

ElevenLabs' stream-input follows the same pattern as Deepgram's streaming TTS on a different wire: untyped `{text, flush}` messages, the voice in the URL path, and base64 audio inside JSON with word alignment. A binding for one does not serve the other.

## How frameworks bind abstract operations to concrete APIs

Every framework examined defines a small set of abstract operations and binds each provider to them.

LiveKit Agents has `TTS.synthesize(text) -> ChunkedStream` for whole text and `TTS.stream() -> SynthesizeStream` with `push_text`, `flush` and `end_input` for incremental text; a provider that cannot stream leaves `stream()` raising `NotImplementedError` and declares `TTSCapabilities(streaming=False)`. Pipecat has `run_tts(text, context_id)` yielding frames, with behaviour steered by constructor flags. The Vercel AI SDK has `doGenerate` and `doStream` on language models and a `SpeechModel` behind `generateSpeech`. LiteLLM exposes top-level `completion`, `speech` and `transcription`. [LiveKit tts.py](https://raw.githubusercontent.com/livekit/agents/main/livekit-agents/livekit/agents/tts/tts.py), [Pipecat tts_service.py](https://raw.githubusercontent.com/pipecat-ai/pipecat/main/src/pipecat/services/tts_service.py), [AI SDK](https://ai-sdk.dev/docs/reference/ai-sdk-core/generate-speech), [LiteLLM](https://docs.litellm.ai/docs/text_to_speech)

The binding itself is code in all of them: one adapter class per provider API. Data enters at two points. First, every framework reuses its one OpenAI adapter for any compatible server through a base URL (Pipecat `base_url`, LiveKit `base_url`, LiteLLM `openai/` prefix plus `api_base`, AI SDK `createOpenAICompatible`, LibreChat `baseURL`), so a new server speaking a known shape is configuration only. Second, per-request body adjustments travel as data: LibreChat's `addParams` and `dropParams`, the AI SDK's `transformRequestBody` and `providerOptions`. No framework was found that describes paths, field names and response formats declaratively; LiteLLM links a guide titled "Add OpenAI-Compatible Provider (JSON)" that was not read and may be the exception. [LibreChat](https://www.librechat.ai/docs/configuration/librechat_yaml/object_structure/custom_endpoint), [LiteLLM openai-compatible](https://docs.litellm.ai/docs/providers/openai_compatible)

Optional features are declared in code too: LiveKit's capability flags, Pipecat's flags and subclasses, LiteLLM's "not implemented" errors at call time. No framework treats voice cloning as a declared capability.

## What this means for the design

The research supports three layers: Banter's own abstract operations, one adapter per API, and a registry that names which APIs a service serves. Every framework has the first two; the registry-declared API is what our setup adds, and LiteLLM's `openai/` prefix is the nearest precedent, a string in configuration that selects the adapter.

No framework writes the binding from operation to wire as data. They keep it in adapter code and put only the base URL and request-body adjustments into configuration. The vendors' own OpenAPI and AsyncAPI documents already describe each wire, so a declaration needs only to name the API and point at its reference; restating the spec would state one fact twice.

No API states which parts of it a server implements. Every self-hosted Realtime server serves a different subset (Kokoro-FastAPI TTS only, Speaches transcription without deltas, vLLM with its own event names), and none says so anywhere a client can read. OGC's `conformsTo` list is the nearest pattern for declaring what a service implements, and RFC 9727's catalog the nearest for where its descriptions live; neither defines a vocabulary for departures from a spec. Nobody publishes conformance identifiers for the OpenAI shapes, so the platform mints its own.

Opus input exists in Deepgram's live STT (`encoding=opus`) and in fluid's own socket protocol, and in no Realtime implementation or OpenAI spec.

The decisions taken from these findings are recorded in [`dev/design/service-apis.md`](../design/service-apis.md).

Details still open in the vendor specs: Deepgram's streaming TTS guide sends `{"type":"Text"}` in its JavaScript sample where the spec says `Speak`, the spec defines no `Error` frame for `/v1/speak`, and whether `/v2/speak` (Flux) adds word timing was not read. Realtime's error code for committing an empty buffer is undocumented, and whether models older than `gpt-live-transcribe` stream transcription deltas is not stated.

## Not verified

- Whether OpenAPI 3.1 or 3.2 has any mechanism for declaring conformance.
- LiteLLM's JSON provider guide, and whether it describes paths and fields as data.
- OpenWebUI, Continue and Jan configuration; Home Assistant's OpenAI integration.
- Whether the mlx-audio server accepts `ref_audio` over HTTP; its README shows it only in the CLI and Python examples.
- vLLM's audio endpoints; Vercel `SpeechModel` and `TranscriptionModel` signatures.
- RFC 9727 adoption, and the standards status of MCP's `/.well-known/ai-catalog.json`.
