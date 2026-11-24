# Developing the fluid servers

How `fluid-stt` and `fluid-tts` are built, and the API behaviour that is theirs rather than part of the shared [speech server API](../../docs/reference/speech-server-api.md). To set them up, see the [README](README.md).

## One package, two processes

Both servers are executables of this package and share `FluidServerKit`: the resident-model lifecycle, idle release, the socket claim, and the HTTP surface.

**Each holds exactly one CoreML model at a time.** FluidAudio issue #661 reports `EXC_BAD_ACCESS` in libBNNS when two managers predict concurrently, and CoreML is not reentrant. So each server serialises everything that touches its model.

**They run as two processes, not one.** Barge-in is an STT manager transcribing live while a TTS manager synthesises. One process would need a serialiser across both, which would make barge-in impossible.

FluidAudio has no common interface across models: each family has its own manager type, constructor and call shape. Supporting another model means adapting a new manager, not adding configuration. The roster only chooses among models the code already supports.

FluidAudio is pinned to an exact upstream release, `FluidInference/FluidAudio` at 0.18.4. [verification/README.md](verification/README.md) says what to check before changing it.

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
| `AppIdentity.swift` | the bundle identifier and versions from the running `.app`'s Info.plist |
| `AppLocations.swift` | the per-application caches, temp and Application Support paths keyed by that identifier |
| `OSLogHandler.swift` | mirrors swift-log into unified logging |

`Sources/FluidServerSTT/`:

| File | What it holds |
|---|---|
| `FluidServer.swift` | entry point, argument parsing, roster load |
| `Roster.swift` | the model roster this server was told to offer, and its validation |
| `ResidentModel.swift` | the one resident model: on-demand load, idle unload, batch transcription and the streaming session lifecycle |
| `LoadedModel.swift` | one live manager (or pair, for Unified) and every reference to its weights |
| `ModelBuilder.swift` | how the resident model brings weights up, injected so tests can stand in for the managers |
| `APIHandlers.swift` | handlers for the protocol generated from `openapi.yaml` |
| `Routes.swift` | transcription, hand-written (see below) |
| `StreamRoutes.swift` | the WebSocket endpoint |
| `ListenRoutes.swift` | Deepgram's `/listen`, batch and WebSocket |
| `ListenQuery.swift` | the `/listen` query parameters |
| `DeepgramResults.swift` | Deepgram's batch response and `Results` messages |
| `Linear16Decoder.swift` | `/listen`'s linear16 PCM frames to samples |
| `UtteranceSegmenter.swift` | the energy gate that closes a `/listen` utterance after a pause |
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

`scripts/fluid-smoke.sh [stt|tts]` checks the servers as built, installed and running, both by default: it deploys each bundle into a scratch directory through the real install code and runs it under a throwaway bundle identifier, with outbound network access denied. `fluid-stt` runs on port 18767 and is checked on health, on-demand load, batch transcription, Deepgram's `/listen` (batch and socket) and idle unload against a sentence spoken by `say`. `fluid-tts` runs on port 18769 and has each roster model synthesize that sentence in one voice (the first roster voice with a preset on the model, else the first that clones under it), and the scratch `fluid-stt` must hear the audio back. It fails if a model directory gained a file, which means a load tried to download. It reads the roster from `services/fluid/registry.fluid.example.json`. Everything it deploys is removed on exit, including an interrupted one, and it never touches a live server or downloads weights. Exit 0 is a pass, 1 a failure, 3 a skip for missing weights or `say`. `--keep` leaves the scratch deploy for debugging.

## fluid-stt

### Loading

- **A request loads the model it names.** The first request that needs a model loads the one it names, or the roster's `defaultModel` when it names none, in the mode its route needs: streaming for a WebSocket, batch for a transcription. Requests arriving during a load share it. A request naming another model, or another variant of the resident one, replaces it once the work in flight ends; a nameless request uses whatever is resident.
- **A request never downloads.** It loads only weights already on the machine; an absent model is refused, and the load endpoints are what fetch one. A failed build is a 503 naming the model.
- **A model that needs a parameter loads on a request only when the request carries it.** Nemotron's chunk size comes from the stream socket's `chunkMs`; another tier of the resident model replaces it like any other model.
- **The model unloads when idle.** After the roster's `idleUnloadMs` without work (30 minutes when absent or not positive), the model is released, whichever way it was loaded. Health checks and model listings aren't work, and an open session is never unloaded. This is separate from the control plane's idle stop, which ends the process.
- **A model of kind `both` needs `mode` on every load.** There is no default, because the wrong choice would surface as unexplained latency rather than as an error. `mode` can be `batch`, `streaming` or `both`.
- **Loading the same id with a new mode grows what is resident** instead of reloading it. Parakeet Unified's two encoders share one decoder, joint and vocabulary, so adding the streaming encoder to a resident batch one is cheaper than a reload.
- **Anything else unloads first.** The same id and variant is a no-op. A different variant, or a different id, unloads what is resident, so two models are never held at once. A failed load leaves nothing resident.
- **Variants.** `variant` names one directly (`560ms`, `1120ms`, `2240ms` for Nemotron); `chunkMs`, or any other declared parameter, selects the variant that binds it. Naming both, pointing at different variants, is refused.
- **A session is the sole occupant.** While a WebSocket holds the session (the dashboard's stream or a `/listen` socket), everything else is refused at once: batch transcriptions, loads that would change the model, unloads, and other sessions short of a takeover. A load the resident model already satisfies succeeds unchanged, so voice starting on another device can reach its takeover. Outside a session, requests queue for up to two minutes. The rule assumes one person on one client at a time; the reasoning is in [docs/reference/design/fluid-stt-on-demand-load.md](../../docs/reference/design/fluid-stt-on-demand-load.md).
- **`cleanup()` releases by reference count.** Memory returns only if nothing else still holds the model, which is why `LoadedModel` owns every reference to its weights. Measured across repeated switches, the process settles to a steady state rather than growing.

### Routes

| Route | Notes |
|---|---|
| `GET /healthz` | `{"status":"ok","model":<id or null>,"variant":<or null>,"bundleIdentifier","shortVersion","buildVersion"}`. Answers as soon as the process is up, before anything is loaded. The last three come from the `.app`'s Info.plist: the package version and the source commit |
| `GET /v1/models` | Each entry adds `loaded`, `loadable`, `kind`, `transport`, `present` and, where declared, `params` and `variants`. The loaded entry also carries `variant` and `modes` (which halves of a `both` model are up). `loadable` is always true, kept because OpenAI-compatible clients read it |
| `POST /v1/models/load` | `{"model", "mode"?, "variant"?, "chunkMs"?}`. 200 `{"object":"model.load","loaded":<id>}` (plus `variant`); 400 for an unknown id or a request the roster refuses; 409 when busy or a session holds the service; 503 when building the model fails |
| `POST /v1/models?model_name=<id>` | The spelling mlx-audio answers. Carries no mode or variant, so a model that needs one is refused here |
| `POST /v1/models/unload` | `{"model"}`. Drops it if resident; otherwise a no-op |
| `DELETE /v1/models` | Drops whatever is resident. Unlike every other route, refuses at once rather than waiting when work is in flight |
| `POST /v1/audio/transcriptions`, `POST /audio/transcriptions` | Multipart, `file` required, capped at 200 MB. Loads the named model, or the default, replacing an idle resident one. 409 when a streaming session holds the service; 503 when the load fails; 415 for a non-multipart body |
| `POST /listen`, `POST /v1/listen` | Deepgram batch: the audio file as the raw body, a Deepgram response back. See below |

Error bodies are `{"error": "<what is wrong>"}`.

### Streaming socket

The shared protocol is in the [speech server API](../../docs/reference/speech-server-api.md#streaming-transcription). What is specific to this server:

- `done` is accepted as a synonym for `Finalize`. A text frame of any other type, or one that isn't valid JSON, is ignored.
- The socket is accepted, then the model is made ready: loaded if nothing is resident, given its streaming mode if it lacks it, replacing the resident one if another is named and no session holds the server. Audio arriving during the load waits in the socket. `chunkMs` picks Nemotron's tier.
- The model check runs before the claim, so a connection refused for its model can't displace a live session on its way out.
- A replace or takeover waits up to two seconds for the previous holder's in-flight work. Past that, the newcomer is refused `busy` and the holder keeps the socket.
- Every session starts from a clean decoder, and every exit resets it before the model is released: `Finalize`, `CloseStream`, a dropped socket, a decode failure, a takeover. A client that never sends `Finalize` still leaves the model clean for the next one.
- Bitrate and DTX are the client's choice; the server decodes whatever arrives.

### Deepgram-compatible `/listen`

`fluid-stt` also answers Deepgram's `/listen` (and `/v1/listen`), so a client written for Deepgram can use it by changing a base URL. Anarlog's Custom speech provider is the one it was built for. `POST /listen` takes the audio file as the raw body; a WebSocket on `/listen` takes `linear16` PCM at the declared `sample_rate` and returns `Results` messages. The `Authorization` header isn't checked, so any non-empty key satisfies a client that requires one.

Unlike the dashboard's stream, where the client decides when an utterance ends, the server decides here: a pause of `endpointing` milliseconds (700 by default) after speech closes the utterance and sends a final. A Deepgram client expects finals as it goes, and would otherwise see one growing interim and lose it on a dropped socket. The silence gate is an energy threshold over 10 ms windows (0.01 RMS, about -40 dBFS, not yet measured against real recordings), so silence before any speech closes nothing. A client `Finalize` also closes the open utterance, and sets `from_finalize` on that result.

The socket claims the model with a generated session and no takeover, so a second concurrent client is refused rather than displacing a call in progress. A `/listen` POST is a batch request outside any session.

Limits:
- Multi-channel audio is averaged to mono, so the client can't tell the microphone from the other participants.
- There's no cap on utterance length: a speaker who never pauses for `endpointing` gets one growing interim and no final.
- Confidence is always 1.0. Diarization, filler words, numerals and keyword boosting are ignored.
- The contract is Anarlog's parser (`crates/owhisper-client/src/adapter/deepgram/` in `fastrepl/anarlog`); Deepgram's own specification hasn't been checked.

### Word timings

The TDT decoder emits SentencePiece tokens, so a word arrives as several timed fragments. `WordTimings.swift` merges them by the boundary each tokenizer encodes: Parakeet's tokens carry a leading space on the token that starts a word; Nemotron's carry SentencePiece's `▁` marker, sometimes on a token spanning several words. Unified reports its own word groups through `consumeWordTimings`, and its result is converted rather than regrouped.

The boundary rule is written against parakeet-mlx's own tokenizer behaviour, which is its source of truth, and not against any AGPL-licensed prior art. Carry that note forward wherever `WordTimings.swift` goes.

## fluid-tts

- **Responses are AAC by default**, in ADTS framing. `wav` and `pcm` (headerless 16-bit mono at 24 kHz) are the other `response_format` values; anything else is refused rather than substituted. A streamed response is one encoded stream, not one file per interval, so there's no gap at the seams.
- **Streaming is a capability, not a special case.** Only Pocket TTS streams today (`TtsStreamingDriver`). `/v1/audio/speech` streams with no flag asked, and `stream_format: "sse"` sends the same audio as `speech.audio.delta` events and a closing `speech.audio.done`. A backend that can't stream returns the whole utterance in the same container, so a client never branches on which model it's talking to.
- **Streamed audio is emitted in fixed-duration chunks**, every 2 s of generated audio by default (mlx-audio's default and field name), overridable per request with `streaming_interval`. Below about 1 s the time to first audio stops tracking the interval and settles near 0.3 s, so 0.5 s is the useful floor. Set it per model with the roster's `requestParams`.
- **Long text is split for backends with a hard input cap**, at sentence and clause boundaries rather than between words.
- **`ref_audio` and `ref_text`** are accepted on synthesis for models that take a voice from reference audio, under the names mlx-audio uses.

### Streaming socket

`WS /v1/audio/stream?model=<id>&format=<aac|wav>&session=<id>&takeover=1`. The dashboard doesn't use it yet; it synthesises over HTTP.

It takes the same `session` and `takeover` rules and error codes as `fluid-stt`'s socket. The client sends `{"type":"speak","text":…}` spans as text arrives, and the server queues them and synthesises the next while the current one plays. `{"type":"cancel"}` drops the queue. The server sends `ready`, then `utterance.start`, binary audio and `utterance.end` for each span, and `cancelled` after a cancel. Unlike on the STT socket, a refusal scoped to one span is an error frame without a close.

## App bundles

Each server ships as an `.app` bundle, `<name>.app/Contents/MacOS/<name>` beside `Contents/Info.plist`, rather than a bare executable, so macOS keys its per-application locations by a stable bundle identifier instead of a file name: `com.banter.fluid-stt` and `com.banter.fluid-tts`.

`scripts/fluid-build.sh` builds both executables with `swift build -c release`, then assembles each bundle under `.build/release/`. `Info.plist` is rendered from the matching template in `Resources/`, with the package version from `VERSION` and the source commit filled in, and the bundle is ad-hoc signed. Every FluidAudio resource bundle (`FluidAudio_*.bundle`, which includes the lexicon and G2P tables LuxTTS loads through `Bundle.module`) is copied into each app's `Contents/Resources/`, since a bundled executable's resource lookup checks there first. `swift-nio`'s two bundles hold only privacy manifests and aren't copied.

`AppLocations` derives three paths from the identifier:

| Location | Path | Created |
|---|---|---|
| Temporary files | `<user temp>/<bundle id>/` | at every startup, emptied first |
| Caches | `~/Library/Caches/<bundle id>/` | by whatever writes to it: CoreML's runtime cache, today |
| Application Support | `~/Library/Application Support/<bundle id>/` | not created; nothing writes here yet |

The temp subdirectory holds the server's own scratch files (the batch transcription upload, and StyleTTS2's reference-audio trim on `fluid-tts`), never the shared system temp directory. Wiping it at startup means a crash never leaves a previous run's file behind. A server that can't create it fails at startup, naming the path.

Each server also logs to unified logging with its bundle identifier as the subsystem, alongside stdout: `log stream --predicate 'subsystem == "com.banter.fluid-stt"'`.

## Installing

`ops/install-artifacts.sh`, called by both install scripts, copies each bundle into the working directory its registry entry declares. It writes `SOURCE-COMMIT.txt` recording what it was built from, and logs a `service.installed` event. A running service is stopped through the control API for the swap and started again afterwards; one whose bundle hasn't changed isn't touched.
