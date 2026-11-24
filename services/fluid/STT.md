# fluid-stt

A speech-to-text server for Apple Silicon, built on FluidAudio's CoreML models. It holds one ASR model at a time and serves it three ways: whole files over HTTP, live audio over its own WebSocket protocol, and the standard APIs a registry entry declares (Deepgram's `/v1/listen` and a transcription subset of OpenAI's Realtime). Registered in a registry as the service `fluid-stt`.

## Package and layout

`fluid-stt` is one of two executables in the `services/fluid` package, alongside `fluid-tts`. They share `FluidServerKit` — the resident-model lifecycle, idle release, and the externally visible HTTP surface — because both servers hold exactly one CoreML model at a time for the same reason: FluidAudio issue #661 reports `EXC_BAD_ACCESS` in libBNNS when two managers predict concurrently. They run as two processes rather than one, because an STT manager transcribing live while a TTS manager synthesises is what barge-in is, and one process would need a serialiser across both modalities that makes barge-in impossible by construction.

FluidAudio is pinned to an exact upstream release. `services/fluid/verification/README.md` says what to check before changing it; the STT server takes the dependency for `AsrManager` and the session-API managers.

Source layout under `Sources/FluidServerSTT/`:

| File | What it holds |
|---|---|
| `FluidServer.swift` | entry point, argument parsing, roster load |
| `Roster.swift` | the model roster this server was told to offer, and its validation |
| `ResidentModel.swift` | the STT-specific view of the one resident model: batch transcription and the streaming session lifecycle |
| `LoadedModel.swift` | one live manager (or pair, for Unified) and every reference to its weights |
| `APIHandlers.swift` | handlers for the protocol generated from `openapi.yaml` |
| `Routes.swift` | transcription, hand-written because its multipart parsing and field spellings sit outside OpenAPI |
| `StreamRoutes.swift` | the WebSocket endpoint |
| `StreamingSession.swift` | Unified and Nemotron's session-API managers behind one interface |
| `AudioDecode.swift` | Opus and PCM16 frames to samples |
| `WordTimings.swift` | sub-word tokens merged into words |
| `ModelErrors.swift` | this server's error conditions and their HTTP status |

`Sources/FluidServerKit/` holds what both servers share: `ResidentSlot` (the one-model, one-operation lock), `SocketClaim` (which connection holds a streaming socket), `SocketSession` (the control-frame vocabulary, error codes, and socket sink), `IdleWatchdog`, `HttpSurface` (CORS, argument parsing, the OpenAI-shaped model list entry), `AppIdentity` (the bundle identifier and versions from the running `.app`'s Info.plist), `AppLocations` (the per-application caches, temp, and Application Support paths those identifiers key), and `OSLogHandler` (mirrors swift-log into unified logging).

## Identity and locations

Each server ships as an `.app` bundle — `fluid-stt.app/Contents/MacOS/fluid-stt` beside `Contents/Info.plist` — rather than a bare executable, so macOS keys every per-application location by a stable bundle identifier instead of by file name. `fluid-stt`'s identifier is `com.banter.fluid-stt`; `fluid-tts`'s is `com.banter.fluid-tts`.

`AppLocations` derives three paths from that identifier:

| Location | Path | Created |
|---|---|---|
| Temporary files | `<user temp>/<bundle id>/` | at every startup, emptied first |
| Caches | `~/Library/Caches/<bundle id>/` | by whatever writes to it — CoreML's runtime cache |
| Application Support | `~/Library/Application Support/<bundle id>/` | not created; nothing writes here |

The temp subdirectory holds this server's own scratch files — the batch transcription upload here, and StyleTTS2's reference-audio trim on `fluid-tts` — never the shared system temp directory. It is wiped and recreated on every start, so a crash never leaves a previous run's file behind. A server that cannot create it fails at startup, naming the path.

Each server also logs through unified logging with its bundle identifier as the subsystem, alongside the stdout stream the shard runner captures: `log stream --predicate 'subsystem == "com.banter.fluid-stt"'`.

## Running

`fluid-stt --port 8767 --registry <path> --provider fluid-stt`

`--registry` and `--provider` are required; a server started without both, or pointed at a registry it cannot read or a roster it cannot validate, fails at startup rather than serving an empty listing. The roster is the `roster` section of the node's registry — the same file the control plane or shard loads — naming which models exist under a set of provider ids; this server reads what the `fluid-stt` provider `serves`, takes each served model's declaration from the roster's `sttModels`, and validates that it can build a manager for each. A registry with no `roster` section, no such provider, or nothing served under it is a startup failure naming the path and the provider.

The server starts holding no model. The first request that needs one loads it — the model it names, or the roster's `defaultModel` when it names none — and waits for the load; a model repository load brings one up ahead of time. After the roster's `idleUnloadMs` without work (30 minutes when absent), the model is unloaded.

`--bind local` (the default) listens on `127.0.0.1` only, which is what a local proxy such as Tailscale Serve forwards to: the proxy sits in front, registered for the service by the node that runs it, and the process itself binds no public interface. `--bind all` listens on every interface, the Tailscale one included, over plain HTTP, which is what a LAN setup uses. Any other value fails at startup.

Optional CORS: set `FLUID_CORS_ORIGINS` (comma-separated origins) before starting. When the browser reaches the server directly, it must list the dashboard's origin; [../../docs/guide/shard.md](../../docs/guide/shard.md) describes that path.

## Models

The roster in `registry.fluid.example.json` offers three ids:

| Model id | Kind | Selecting a variant |
|---|---|---|
| `parakeet-tdt-v3` | batch | none — one implicit variant |
| `parakeet-unified-0.6b` | both | `mode` required on load: `batch`, `streaming`, or `both` |
| `nemotron-streaming-en-0.6b` | streaming | `variant` (`560ms`, `1120ms`, `2240ms`) or the equivalent `chunkMs` |

A model's `kind` is `batch`, `streaming`, or `both`. `both` is one model with two encoders over one set of shared weights — Parakeet Unified's decoder, joint, and vocabulary are common to both modes — not two separate models. A model of kind `both` needs `mode` on every load; there is no default, because the wrong choice would surface as unexplained latency rather than as an error.

Weights are not prefetched by this server. `GET /v1/models` reports `present` for each entry, true when every file that model's manager needs is already on disk under `~/Library/Application Support/FluidAudio/Models/`; a load of an absent model downloads its weights inside the call.

**One model is resident at a time, and switching costs around thirteen seconds.** CoreML is not reentrant, so the server holds exactly one model and serialises everything that touches it. A batch request or a load is queued behind whatever holds the slot, refused with 409 only after a two-minute wait; a streaming connection that holds the claim takes the slot over instead of queuing, as the streaming section describes.

**A request loads the model it names.** A request naming a model other than the resident one, or another variant of it, replaces it once the work in flight ends. An open streaming session is the sole occupant: while it lasts, every other request is refused at once. Outside a session, requests queue for up to two minutes.

**Loading the same id with a new mode grows what is resident instead of reloading it.** Asking to load `parakeet-unified-0.6b` in `streaming` mode while it is already resident in `batch` mode adds the streaming encoder in place, keeping the batch one up — the shared weights make this cheaper than a full reload. Loading the same id and variant that are already resident is a no-op. Loading the same id with a different variant, or a different id entirely, unloads whatever is resident first, so two models or two variants are never held at once. A failed load leaves nothing resident.

## HTTP API

Health and model lifecycle are generated from `openapi.yaml`, which is their source of truth: `swift-openapi-generator` turns it into a protocol `APIHandlers` must satisfy, so those routes cannot drift from their documented shape without failing to compile. Transcription is hand-written, because OpenAI-compatible clients send `timestamp_granularities[]` with the brackets and a schema cannot describe two names for one field.

### `GET /healthz`

`{"status": "ok", "model": "parakeet-tdt-v3", "variant": null, "bundleIdentifier": "com.banter.fluid-stt", "shortVersion": "0.1.0", "buildVersion": "a1b2c3d"}`

`model` is null when nothing is loaded. `variant` is null unless the resident model has more than its implicit one. Health is about the process, not the model: the server answers as soon as it is up, before anything is loaded. `bundleIdentifier`, `shortVersion` (`CFBundleShortVersionString`, the package version), and `buildVersion` (`CFBundleVersion`, the source commit) come from the running `.app`'s Info.plist, so the platform can see which build is up without reading the install directory.

### `GET /v1/models`

OpenAI-compatible listing. Each entry carries `id`, `name`, `object`, `created`, `owned_by`, `loaded`, `loadable`, `kind`, `transport`, `present`, and, where the roster declares them, `params` and `variants`. The loaded entry also carries `variant` (its resident variant) and `modes` (which halves of a `both` model are currently up — a boolean cannot say which, since Unified can be resident in one mode or both). `loadable` is always true here; it is kept because OpenAI-compatible clients read it, not because anything in this roster is unloadable in the sense it implies. `transport` lists `http`, `websocket`, or both, separately from `kind`: `kind` says what the model is, `transport` says how it is reached, and the two are not asserted to coincide.

### Model repository: `POST /v2/repository/...`

Explicit loading is Triton's model repository extension, with the departures `resident-slot` declares. A model is named by its serving's key.

`POST /v2/repository/models/{name}/load`, with an optional body `{"parameters": {"mode"?, "variant"?}}`. Empty `parameters` load a single-mode model in its one mode; a model of kind `both` needs `mode` (`batch`, `streaming` or `both`), and a model with variants needs `variant`. A load of the resident model, with the same variant and a mode already up, changes nothing. Any other parameter is refused.

`POST /v2/repository/models/{name}/unload` drops the model if it is the resident one; naming another is a no-op.

`POST /v2/repository/index`, with an optional `{"ready": true}`, lists every roster model as `{name, state, reason}`: `READY` for the resident one and `UNAVAILABLE` for the rest.

| Status | When |
|---|---|
| 200 | loaded, unloaded, or already as asked |
| 400 | the name is no serving's key, or the parameters do not choose what the model offers |
| 409 | a streaming session holds the server and the load would change the model, or the call is an unload; or work in flight outlasted the wait |
| 503 | building the model failed; nothing is resident |

### `POST /v1/audio/transcriptions` and `POST /audio/transcriptions`

Multipart upload, OpenAI-compatible. `file` is required. `response_format` takes `text` for plain text, `verbose_json` for word timings, and defaults to JSON. `timestamp_granularities[]=word` (or the unbracketed `timestamp_granularities=word`) adds word timings to a `verbose_json` response.

The optional `model` field names the model the caller wants, by its serving's key: loaded if nothing is resident, replacing the resident one if another is, once the work in flight ends.

| Status | When |
|---|---|
| 200 | transcript |
| 400 | `model` names no serving's key |
| 409 | no `model` is named, no model is loaded and the roster has no default |
| 409 | the loaded model is resident only in streaming mode, or is a streaming-only model with no batch path |
| 409 | a streaming session holds the model |
| 415 | the request is not `multipart/form-data` |
| 400 | the multipart body could not be decoded |

The body is capped at 200 MB. Error bodies are `{"error": "<what is wrong>"}`.

## Streaming

`ws://<host>:<port>/v1/audio/stream?model=<id>&format=<opus|pcm16>&session=<id>&takeover=1`

The socket is accepted, then the model is made ready: loaded if nothing is resident, given its streaming mode if it lacks it, replacing the resident one if another model is named and no session holds the server. `model` is optional and names the model wanted, by its serving's key; `chunkMs` picks the tier of a model that takes one (Nemotron), and another tier of the resident model replaces it the same way; `format` defaults to `opus`. While a session holds the server, a connection that would change the model gets in only as a takeover or the holder's own reconnect: the holder's session ends, then the newcomer's model loads.

`session` and `takeover` say who holds the connection. One streaming session is live at a time, so `session` is the caller's own id: a connection without one has an identity of its own and can never be recognised as a reconnect. `fluid-tts`'s socket takes the same two parameters and follows the identical rule, so a client written against one socket reads the other correctly.

| Holder | Newcomer | Result |
|---|---|---|
| none | any | newcomer gets the slot |
| id X | id X | newcomer gets the slot; the old socket is closed `replaced` (the client has abandoned it) |
| id X | id Y, or none | refused `held`; the holder keeps the slot |
| id X | id Y, or none, with `takeover=1` | newcomer gets the slot; the holder is closed `superseded` |

The model check runs before the claim: a connection that will be refused for its model cannot displace a live session on its way out. A replace or takeover that is granted still waits up to five seconds for the previous holder's in-flight work to finish; past that the newcomer is refused `busy` instead, and the previous holder keeps the slot.

Binary frames carry audio; text frames carry control.

| Direction | Frame | Meaning |
|---|---|---|
| → | binary | one audio frame in the declared format |
| → | `{"type":"Finalize"}` | end of utterance: return the transcript and stay open for the next one |
| → | `{"type":"CloseStream"}` | return the transcript, then close |
| → | `{"type":"KeepAlive"}` | proves the client is alive; never answered |
| ← | `{"type":"ready","model":…,"format":…}` | session open |
| ← | `{"type":"transcript","is_final":false,"text":…}` | the transcript as it currently stands, sent when it changes rather than per frame. It may still change |
| ← | `{"type":"transcript","is_final":true,"text":…,"words":[…]}` | after `Finalize` or `CloseStream`; settled, with word timings |
| ← | `{"type":"error","code":…,"message":…}` | the session then closes with the matching code |

Interim frames carry the whole transcript so far, not a delta: a client renders the latest and discards what it replaces. `done` is accepted as a synonym for `Finalize`. A text frame naming any other type, or one that is not valid JSON, is silently ignored rather than answered with an error.

**One connection carries a conversation, not an utterance.** `Finalize` returns the transcript and resets the session for the next turn, leaving the connection open; only `CloseStream` ends it. Every session starts from a clean decoder, whether that is its first utterance or the one after a `Finalize`, and every exit — a `Finalize`, a `CloseStream`, a dropped socket, a decode failure, a takeover — resets the session before the model is released, so a connection that never sends `Finalize` still leaves the model clean for whoever holds it next.

**A quiet session is kept, not dropped, until something else needs the model.** There is no short idle timeout. A connection that stops sending without closing keeps its session for up to thirty minutes; past that, the server sends `{"type":"error","code":"idle","message":"nothing received for 30 minutes; closing the session"}` and closes with 4003. Any frame, including `KeepAlive`, resets that clock. A client streaming audio never needs `KeepAlive` for this purpose — it exists for a client that has gone quiet mid-conversation and wants to prove it is still there, and the interval it sends at only needs to stay well inside thirty minutes.

**Every error carries a code.** On this socket every error ends the session, since one socket carries exactly one session: the coded frame is always followed by the matching close code in the 4000 range. (`fluid-tts`'s socket follows the same codes, but not every one of its errors ends the connection — a refusal scoped to one span, on a socket that queues several, is a frame with no close; see the streaming design doc.)

| code | close | when |
|---|---|---|
| `held` | 4001 | another session holds the slot and the connection did not ask to take over |
| `superseded` | 4002 | another client took over this session's slot |
| `idle` | 4003 | nothing received for thirty minutes |
| `model_not_loaded` | 4004 | no model loaded, or not resident in a streaming-capable mode |
| `model_mismatch` | 4005 | the named model is not in the roster, or the roster refuses how it is asked for |
| `busy` | 4006 | the slot is busy with other work |
| `bad_format` | 4007 | unknown `format` |
| `bad_audio` | 4008 | a frame could not be decoded |
| `failed` | 4009 | transcription or finalize failed for any other reason |
| `replaced` | 4010 | the same session reconnected on a new socket (close only, no error frame) |

A dropped connection is not resumed: reconnecting starts a new session, and the words since the last `Finalize` are lost with it. A session that cannot start closes the same way, after one `error` frame where its code is not `replaced`.

### A session end to end

Loading first is optional, since the socket loads the model it names; a load ahead of time keeps the load out of the first utterance. Unified needs `mode` because it serves both batch and streaming.

```js
await fetch(`${endpoint}/v2/repository/models/parakeet-unified-0.6b/load`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ parameters: { mode: 'streaming' } }),
})

const ws = new WebSocket(
  `${wsEndpoint}/v1/audio/stream?model=parakeet-unified-0.6b&format=opus&session=${sessionId}`)
ws.binaryType = 'arraybuffer'

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  if (msg.type === 'transcript') {
    // Interim frames replace what came before; the final one carries words[].
    render(msg.text, msg.is_final)
  } else if (msg.type === 'error') {
    // msg.code is what to act on; the socket then closes with its matching code.
    fail(msg.code, msg.message)
  }
}

// Raw Opus packets from WebCodecs. MediaRecorder would wrap them in WebM,
// which this endpoint does not accept.
const encoder = new AudioEncoder({
  output: (chunk) => {
    const buf = new ArrayBuffer(chunk.byteLength)
    chunk.copyTo(new Uint8Array(buf))
    ws.send(buf)
  },
  error: fail,
})
encoder.configure({
  codec: 'opus', sampleRate: 16000, numberOfChannels: 1, bitrate: 64000,
})

// …feed AudioData from a 16 kHz mic capture into encoder.encode()…

// End of one utterance. The final transcript follows and the connection stays
// open for the next turn; send CloseStream instead to end the conversation.
ws.send(JSON.stringify({ type: 'Finalize' }))

// While the user is not speaking, prove the connection is alive.
setInterval(() => ws.send(JSON.stringify({ type: 'KeepAlive' })), 4000)
```

The client decides when the utterance ended — VAD and turn detection make that judgement, and the server does not second-guess them.

**Audio formats.** `pcm16` is raw little-endian Int16, 16 kHz mono. `opus` is raw Opus packets, one per frame, as WebCodecs `AudioEncoder` produces them — not the WebM that `MediaRecorder` emits, which this endpoint does not parse. Decoded with libopus via the `COpus` system-library target. Bitrate and DTX are the client's choice and never reach the server, which decodes whatever arrives.

## Standard APIs

The registry entry for `fluid-stt` declares which published APIs it serves and where it departs from them, by catalog id; the server reads that entry at startup and refuses to start when it claims more than the build serves. The speech server API reference lists the provisions: [docs/reference/speech-server-api.md](../../docs/reference/speech-server-api.md).

### Deepgram `/v1/listen`

`POST /v1/listen` takes the audio as the raw body, or raw `linear16` at `sample_rate` when `encoding=linear16`. A WebSocket on `/v1/listen` takes `linear16` PCM at the declared `sample_rate`, or one raw Opus packet per message with `encoding=opus`, and returns `Results` messages. `/listen` is an alias. `model` names a serving by its key, as on the stream socket, and `session` and `takeover` claim the socket with the same rules. A refusal or displacement closes with its 4001 to 4010 code and sends no frame; a message the server cannot parse is answered with an `Error` message and the stream stays open. `CloseStream` settles the open utterance, sends `Metadata` and closes with 1000.

The segmenter closes an utterance after `endpointing` milliseconds of silence once there is text; its default is the provision's `defaults.endpointing`, else Deepgram's 10, and `endpointing=false` leaves every utterance to the client. Every `Finalize` is answered by exactly one `Results` marked `from_finalize`, including an empty one when nothing was heard. Only a result with text is marked `is_final`, so a client settles on `from_finalize`. The `Error` message carries `type`, `variant`, `description` and `message`; the deprecated `code` is not sent. Deepgram's own model names are not served: `model` is a serving's key, and a name that is no serving's key is refused.

### Realtime transcription (`openai.realtime`)

A WebSocket on `/v1/realtime` serves OpenAI's Realtime protocol in transcription mode only. It implements `session.update`, `input_audio_buffer.append`, `input_audio_buffer.commit` and `input_audio_buffer.clear`, and answers with `session.created`, `session.updated`, `input_audio_buffer.committed`, `input_audio_buffer.cleared`, `conversation.item.input_audio_transcription.delta` and `.completed`, and `error`. Any other client event is answered with `error`.

The model is the connect query's `model` or `session.audio.input.transcription.model`, both a serving's key. `audio/pcm` at the session's rate and `audio/opus` (one raw packet per append, an extension of the protocol) are accepted; any other format, and any `turn_detection` other than null, is answered with `error`. Each commit's audio is transcribed whole, and commits are answered in order: `committed`, one `delta` holding the text when there is any, then `completed`, whose `usage` carries the seconds of audio committed. An empty commit is an `error`. The server never decides where an utterance ends.

## Word timings

The TDT decoder emits sentencepiece tokens, so a word arrives as several timed sub-word fragments. `WordTimings.swift` merges them by the boundary each tokenizer actually encodes: Parakeet's tokens carry a leading space on the token that begins a new word, and Nemotron's carry SentencePiece's `▁` marker, sometimes across a token that spans more than one word. Unified reports its own word groups directly through `consumeWordTimings`, applying the same boundary rule in its own shape, and its result is converted rather than regrouped.

The boundary rule is written against parakeet-mlx's own tokenizer behaviour, which is its source of truth, and not against any AGPL-licensed prior art — carry that note forward wherever `WordTimings.swift` goes.

## Deployment

`scripts/fluid-build.sh` builds both executables with `swift build -c release`, then assembles each into an `.app` bundle under `.build/release/`: `Contents/MacOS/<name>` holds the executable, `Contents/Info.plist` is rendered from the matching template in `Resources/` with the package version (from `VERSION`) and the source commit filled in, and the bundle is ad-hoc signed. Every FluidAudio resource bundle (`FluidAudio_*.bundle`) is copied into each app's `Contents/Resources/`, since a bundled executable's resource lookup checks there before falling back to the executable's own directory, and a target that cannot find its bundle traps at first use.

`ops/shard-install-services.sh` installs each bundle into `~/services/fluid/fluid-stt/fluid-stt.app` and `~/services/fluid/fluid-tts/fluid-tts.app` as each registry entry's `ops.install` declares, alongside a `SOURCE-COMMIT.txt` recording what they were built from and a `service.installed` event in the shard's log. A service already running is stopped through the control API before its bundle is replaced and started again afterward; one that was not running stays that way, and one whose bundle has not changed is not touched. The registry's launch command runs `fluid-stt.app/Contents/MacOS/fluid-stt` (or the `fluid-tts` equivalent) with `--registry` and `--provider`, with `{registry}` filled with the path of the shard's own `registry.json`.
