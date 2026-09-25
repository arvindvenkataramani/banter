# Developing the fluid servers

How `fluid-stt` and `fluid-tts` are built, and the API behaviour that is theirs rather than part of the shared [speech server API](../../docs/speech-server-api.md). To set them up, see the [README](README.md).

## One package, two processes

Both servers are executables of this package and share `FluidServerKit`: the resident-model lifecycle, idle release, the socket claim, and the HTTP surface.

**Each holds exactly one CoreML model at a time.** FluidAudio issue #661 reports `EXC_BAD_ACCESS` in libBNNS when two managers predict concurrently, and CoreML is not reentrant. So each server serialises everything that touches its model.

**They run as two processes, not one.** Barge-in is an STT manager transcribing live while a TTS manager synthesises. One process would need a serialiser across both, which would make barge-in impossible.

FluidAudio has no common interface across models: each family has its own manager type, constructor and call shape. Supporting another model means adapting a new manager, not adding configuration. The roster only chooses among models the code already supports.

FluidAudio is pinned to a fork, `arvindvenkataramani/FluidAudio`, for the Pocket TTS patches in [patches/](patches/README.md). The STT server uses the same pin but does not depend on the patches.

## Source layout

`Sources/FluidServerKit/`, shared:

| File | What it holds |
|---|---|
| `ResidentSlot.swift` | the one-model, one-operation lock |
| `SocketClaim.swift` | which connection holds a streaming socket |
| `SocketSession.swift` | the control-frame vocabulary, error codes and socket sink |
| `IdleWatchdog.swift` | releasing an idle model |
| `HttpSurface.swift` | CORS, argument parsing, the OpenAI-shaped model list entry |
| `AudioEncoders.swift` | AAC and WAV response encoding |

`Sources/FluidServerSTT/`:

| File | What it holds |
|---|---|
| `FluidServer.swift` | entry point, argument parsing, roster load |
| `Roster.swift` | the model roster this server was told to offer, and its validation |
| `ResidentModel.swift` | the one resident model: batch transcription and the streaming session lifecycle |
| `LoadedModel.swift` | one live manager (or pair, for Unified) and every reference to its weights |
| `APIHandlers.swift` | handlers for the protocol generated from `openapi.yaml` |
| `Routes.swift` | transcription, hand-written (see below) |
| `StreamRoutes.swift` | the WebSocket endpoint |
| `StreamingSession.swift` | Unified's and Nemotron's session-API managers behind one interface |
| `AudioDecode.swift` | Opus and PCM16 frames to samples, through the `COpus` system-library target |
| `WordTimings.swift` | sub-word tokens merged into words |
| `ModelErrors.swift` | error conditions and their HTTP status |

`Sources/FluidServerTTS/`:

| File | What it holds |
|---|---|
| `FluidTtsServer.swift` | entry point, roster load |
| `Roster.swift` | the model roster and its validation |
| `Backends.swift` | one driver per FluidAudio TTS manager behind a common call, and text splitting for backends with a hard input cap |
| `ResidentTtsModel.swift` | the one resident model |
| `APIHandlers.swift` | handlers for the protocol generated from `openapi.yaml` |
| `Routes.swift` | synthesis, whole-utterance and streamed |
| `StreamRoutes.swift` | the WebSocket endpoint |
| `Audio.swift` | regrouping generated audio into fixed-duration chunks for streaming |

**`openapi.yaml` is the source of truth for health and model lifecycle.** `swift-openapi-generator` turns it into a protocol `APIHandlers` must satisfy, so those routes can't drift from their documented shape without failing to compile. Transcription is hand-written, because OpenAI-compatible clients send `timestamp_granularities[]` with the brackets and a schema cannot describe two names for one field.

Build with `scripts/fluid-build.sh`, or `swift build -c release` in this directory. Tests: `swift test`.

## fluid-stt

### Loading

- **Loading is always explicit.** A request naming a model that isn't loaded is refused, never silently switched: the request that caused a load would pay for it, and nothing would say so.
- **A model of kind `both` needs `mode` on every load.** There is no default, because the wrong choice would surface as unexplained latency rather than as an error. `mode` can be `batch`, `streaming` or `both`.
- **Loading the same id with a new mode grows what is resident** instead of reloading it. Parakeet Unified's two encoders share one decoder, joint and vocabulary, so adding the streaming encoder to a resident batch one is cheaper than a reload.
- **Anything else unloads first.** The same id and variant is a no-op. A different variant, or a different id, unloads what is resident, so two models are never held at once. A failed load leaves nothing resident.
- **Variants.** `variant` names one directly (`560ms`, `1120ms`, `2240ms` for Nemotron); `chunkMs`, or any other declared parameter, selects the variant that binds it. Naming both, pointing at different variants, is refused.
- **Busy is a short wait, then 409.** A batch request or a load queues behind whatever holds the model and is refused only after two seconds. A streaming connection that holds the claim takes the model over instead of queuing.
- **`cleanup()` releases by reference count.** Memory returns only if nothing else still holds the model, which is why `LoadedModel` owns every reference to its weights. Measured across repeated switches, the process settles to a steady state rather than growing.

### Routes

| Route | Notes |
|---|---|
| `GET /healthz` | `{"status":"ok","model":<id or null>,"variant":<or null>}`. Answers as soon as the process is up, before anything is loaded |
| `GET /v1/models` | Each entry adds `loaded`, `loadable`, `kind`, `transport`, `present` and, where declared, `params` and `variants`. The loaded entry also carries `variant` and `modes` (which halves of a `both` model are up). `loadable` is always true, kept because OpenAI-compatible clients read it |
| `POST /v1/models/load` | `{"model", "mode"?, "variant"?, "chunkMs"?}`. 200 `{"object":"model.load","loaded":<id>}` (plus `variant`); 400 for an unknown id or a request the roster refuses; 409 when busy |
| `POST /v1/models?model_name=<id>` | The spelling mlx-audio answers. Carries no mode or variant, so a model that needs one is refused here |
| `POST /v1/models/unload` | `{"model"}`. Drops it if resident; otherwise a no-op |
| `DELETE /v1/models` | Drops whatever is resident. Unlike every other route, refuses at once rather than waiting when work is in flight |
| `POST /v1/audio/transcriptions`, `POST /audio/transcriptions` | Multipart, `file` required, capped at 200 MB. 409 when no model is loaded, the named model isn't the loaded one, the model is resident only for streaming, or a streaming session holds it; 415 for a non-multipart body |

Error bodies are `{"error": "<what is wrong>"}`.

### Streaming socket

The shared protocol is in the [speech server API](../../docs/speech-server-api.md#streaming-transcription). What is specific to this server:

- `done` is accepted as a synonym for `Finalize`. A text frame of any other type, or one that isn't valid JSON, is ignored.
- The model check runs before the claim, so a connection refused for its model can't displace a live session on its way out.
- A replace or takeover waits up to two seconds for the previous holder's in-flight work. Past that, the newcomer is refused `busy` and the holder keeps the socket.
- Every session starts from a clean decoder, and every exit resets it before the model is released: `Finalize`, `CloseStream`, a dropped socket, a decode failure, a takeover. A client that never sends `Finalize` still leaves the model clean for the next one.
- Bitrate and DTX are the client's choice; the server decodes whatever arrives.

### Word timings

The TDT decoder emits SentencePiece tokens, so a word arrives as several timed fragments. `WordTimings.swift` merges them by the boundary each tokenizer encodes: Parakeet's tokens carry a leading space on the token that starts a word; Nemotron's carry SentencePiece's `▁` marker, sometimes on a token spanning several words. Unified reports its own word groups through `consumeWordTimings`, and its result is converted rather than regrouped.

The boundary rule is written against parakeet-mlx's own tokenizer behaviour, which is its source of truth, and not against any AGPL-licensed prior art. Carry that note forward wherever `WordTimings.swift` goes.

## fluid-tts

- **Responses are AAC by default**, in ADTS framing, with `wav` the only other `response_format`; anything else is refused rather than substituted. A streamed response is one encoded stream, not one file per interval, so there's no gap at the seams.
- **Streaming is a capability, not a special case.** Only Pocket TTS streams today (`TtsStreamingDriver`). A backend that can't stream, asked for `stream: true`, returns the whole utterance in the same container, so a client never branches on which model it's talking to.
- **Streamed audio is emitted in fixed-duration chunks**, every 2 s of generated audio by default (mlx-audio's default and field name), overridable per request with `streaming_interval`. Below about 1 s the time to first audio stops tracking the interval and settles near 0.3 s, so 0.5 s is the useful floor. Set it per model with the roster's `requestParams`.
- **Long text is split for backends with a hard input cap**, at sentence and clause boundaries rather than between words.
- **`ref_audio` and `ref_text`** are accepted on synthesis for models that take a voice from reference audio, under the names mlx-audio uses.

### Streaming socket

`WS /v1/audio/stream?model=<id>&format=<aac|wav>&session=<id>&takeover=1`. The dashboard doesn't use it yet; it synthesises over HTTP.

It takes the same `session` and `takeover` rules and error codes as `fluid-stt`'s socket. The client sends `{"type":"speak","text":…}` spans as text arrives, and the server queues them and synthesises the next while the current one plays. `{"type":"cancel"}` drops the queue. The server sends `ready`, then `utterance.start`, binary audio and `utterance.end` for each span, and `cancelled` after a cancel. Unlike on the STT socket, a refusal scoped to one span is an error frame without a close.

## Installing

`scripts/install-artifacts.sh`, called by both install scripts, copies each binary into the working directory its registry entry declares. It writes `SOURCE-COMMIT.txt` recording what it was built from, and logs a `service.installed` event. A running service is stopped through the control API for the swap and started again afterwards; one whose binary hasn't changed isn't touched.

An artifact can be a file or a directory. `fluid-tts` installs `FluidAudio_FluidAudio.bundle` beside its binary, holding the lexicon and G2P tables LuxTTS loads through `Bundle.module`. SwiftPM's generated lookup checks the executable's own directory first, so the installed copy is used and nothing reaches back into the build tree. `swift-nio`'s two bundles hold only privacy manifests and are not installed.
