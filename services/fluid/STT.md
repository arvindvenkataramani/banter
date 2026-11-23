# fluid-stt

A speech-to-text server for Apple Silicon, built on FluidAudio's CoreML models. It holds one ASR model at a time and serves it two ways: whole files over HTTP, and live audio over a WebSocket. Registered in a registry as the service `fluid-stt`.

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

The server starts holding no model. The first request that needs one loads it — the model it names, or the roster's `defaultModel` when it names none — and waits for the load; the load endpoints bring one up ahead of time. After the roster's `idleUnloadMs` without work (30 minutes when absent), the model is unloaded.

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

**One model is resident at a time, and switching costs around thirteen seconds.** CoreML is not reentrant, so the server holds exactly one model and serialises everything that touches it. A batch request or a load is queued behind whatever holds the slot, refused with 409 only after a two-second wait; a streaming connection that holds the claim takes the slot over instead of queuing, as the streaming section describes.

**A request loads only into an empty slot.** A request naming a model other than the resident one is refused rather than silently switched; only the load endpoints replace a model. An open streaming session is the sole occupant: while it lasts, every other request is refused at once. Outside a session, requests queue for up to two minutes.

**Loading the same id with a new mode grows what is resident instead of reloading it.** Asking to load `parakeet-unified-0.6b` in `streaming` mode while it is already resident in `batch` mode adds the streaming encoder in place, keeping the batch one up — the shared weights make this cheaper than a full reload. Loading the same id and variant that are already resident is a no-op. Loading the same id with a different variant, or a different id entirely, unloads whatever is resident first, so two models or two variants are never held at once. A failed load leaves nothing resident.

## HTTP API

Health and model lifecycle are generated from `openapi.yaml`, which is their source of truth: `swift-openapi-generator` turns it into a protocol `APIHandlers` must satisfy, so those routes cannot drift from their documented shape without failing to compile. Transcription is hand-written, because OpenAI-compatible clients send `timestamp_granularities[]` with the brackets and a schema cannot describe two names for one field.

### `GET /healthz`

`{"status": "ok", "model": "parakeet-tdt-v3", "variant": null, "bundleIdentifier": "com.banter.fluid-stt", "shortVersion": "0.1.0", "buildVersion": "a1b2c3d"}`

`model` is null when nothing is loaded. `variant` is null unless the resident model has more than its implicit one. Health is about the process, not the model: the server answers as soon as it is up, before anything is loaded. `bundleIdentifier`, `shortVersion` (`CFBundleShortVersionString`, the package version), and `buildVersion` (`CFBundleVersion`, the source commit) come from the running `.app`'s Info.plist, so the platform can see which build is up without reading the install directory.

### `GET /v1/models`

OpenAI-compatible listing. Each entry carries `id`, `name`, `object`, `created`, `owned_by`, `loaded`, `loadable`, `kind`, `transport`, `present`, and, where the roster declares them, `params` and `variants`. The loaded entry also carries `variant` (its resident variant) and `modes` (which halves of a `both` model are currently up — a boolean cannot say which, since Unified can be resident in one mode or both). `loadable` is always true here; it is kept because OpenAI-compatible clients read it, not because anything in this roster is unloadable in the sense it implies. `transport` lists `http`, `websocket`, or both, separately from `kind`: `kind` says what the model is, `transport` says how it is reached, and the two are not asserted to coincide.

### `POST /v1/models/load`

Body: `{"model": "<id>", "mode"?, "variant"?, "chunkMs"?}`. `mode` is required for a model of kind `both` and refused for one that does not serve what it names. `variant` names one of the model's variants directly; `chunkMs` (or any other declared parameter) selects the variant that binds it. Naming a variant together with a parameter that would select a different one is refused.

| Status | When |
|---|---|
| 200 | `{"object": "model.load", "loaded": "<id>"}`, with `variant` added for a model that has several |
| 400 | no `model` in the body, the id is unknown, or the roster refuses the request (no mode named for a `both` model, an unoffered parameter value, and so on) |
| 409 | the slot is busy with other work, past the two-second wait |

### `POST /v1/models?model_name=<id>`

The spelling `mlx-audio` answers and `fluid-tts` shares, so a client written against either reads this one too. It carries no mode, variant, or parameters: a model that needs any of them is refused here, and `POST /v1/models/load` is the form that can state them.

### `POST /v1/models/unload`

Body: `{"model": "<id>"}`. Drops the model if it is the resident one. Unloading something that is not loaded is a no-op, not an error.

### `DELETE /v1/models`

Drops whatever is resident, without naming it — the spelling OpenAI-compatible clients use, and what `fluid-tts` answers on the same path. A no-op when nothing is loaded. Unlike every other endpoint here, this one refuses immediately rather than waiting out the slot's deadline when work is in flight: waiting would hide a caller's mistake behind a stall.

### `POST /v1/audio/transcriptions` and `POST /audio/transcriptions`

Multipart upload, OpenAI-compatible. `file` is required. `response_format` takes `text` for plain text, `verbose_json` for word timings, and defaults to JSON. `timestamp_granularities[]=word` (or the unbracketed `timestamp_granularities=word`) adds word timings to a `verbose_json` response.

The optional `model` field names the model the caller wants: loaded if nothing is resident, refused if another model is.

| Status | When |
|---|---|
| 200 | transcript |
| 400 | `model` names an unknown id |
| 409 | `model` names a known model that is not the loaded one, or no model is loaded |
| 409 | the loaded model is resident only in streaming mode, or is a streaming-only model with no batch path |
| 409 | a streaming session holds the model |
| 415 | the request is not `multipart/form-data` |
| 400 | the multipart body could not be decoded |

The body is capped at 200 MB. Error bodies are `{"error": "<what is wrong>"}`.

## Streaming

`ws://<host>:<port>/v1/audio/stream?model=<id>&format=<opus|pcm16>&session=<id>&takeover=1`

The socket is accepted, then the model is made ready: loaded if nothing is resident, given its streaming mode if it lacks it, refused if another model is resident. `model` is optional and names the model wanted; `chunkMs` picks the tier of a model that takes one (Nemotron), and another tier of the resident model is refused; `format` defaults to `opus`.

`session` and `takeover` say who holds the connection. One streaming session is live at a time, so `session` is the caller's own id: a connection without one has an identity of its own and can never be recognised as a reconnect. `fluid-tts`'s socket takes the same two parameters and follows the identical rule, so a client written against one socket reads the other correctly.

| Holder | Newcomer | Result |
|---|---|---|
| none | any | newcomer gets the slot |
| id X | id X | newcomer gets the slot; the old socket is closed `replaced` (the client has abandoned it) |
| id X | id Y, or none | refused `held`; the holder keeps the slot |
| id X | id Y, or none, with `takeover=1` | newcomer gets the slot; the holder is closed `superseded` |

The model check runs before the claim: a connection that will be refused for its model cannot displace a live session on its way out. A replace or takeover that is granted still waits up to two seconds for the previous holder's in-flight work to finish; past that the newcomer is refused `busy` instead, and the previous holder keeps the slot.

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
| `model_mismatch` | 4005 | the named model is not the loaded one, or not in the roster |
| `busy` | 4006 | the slot is busy with other work |
| `bad_format` | 4007 | unknown `format` |
| `bad_audio` | 4008 | a frame could not be decoded |
| `failed` | 4009 | transcription or finalize failed for any other reason |
| `replaced` | 4010 | the same session reconnected on a new socket (close only, no error frame) |

A dropped connection is not resumed: reconnecting starts a new session, and the words since the last `Finalize` are lost with it. A session that cannot start closes the same way, after one `error` frame where its code is not `replaced`.

### A session end to end

Load the model first; the socket will not load it. Unified needs `mode` because it serves both batch and streaming.

```js
await fetch(`${endpoint}/v1/models/load`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'parakeet-unified-0.6b', mode: 'streaming' }),
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

## Word timings

The TDT decoder emits sentencepiece tokens, so a word arrives as several timed sub-word fragments. `WordTimings.swift` merges them by the boundary each tokenizer actually encodes: Parakeet's tokens carry a leading space on the token that begins a new word, and Nemotron's carry SentencePiece's `▁` marker, sometimes across a token that spans more than one word. Unified reports its own word groups directly through `consumeWordTimings`, applying the same boundary rule in its own shape, and its result is converted rather than regrouped.

The boundary rule is written against parakeet-mlx's own tokenizer behaviour, which is its source of truth, and not against any AGPL-licensed prior art — carry that note forward wherever `WordTimings.swift` goes.

## Deployment

`scripts/fluid-build.sh` builds both executables with `swift build -c release`, then assembles each into an `.app` bundle under `.build/release/`: `Contents/MacOS/<name>` holds the executable, `Contents/Info.plist` is rendered from the matching template in `Resources/` with the package version (from `VERSION`) and the source commit filled in, and the bundle is ad-hoc signed. Every FluidAudio resource bundle (`FluidAudio_*.bundle`) is copied into each app's `Contents/Resources/`, since a bundled executable's resource lookup checks there before falling back to the executable's own directory, and a target that cannot find its bundle traps at first use.

`ops/shard-install-services.sh` installs each bundle into `~/services/fluid/fluid-stt/fluid-stt.app` and `~/services/fluid/fluid-tts/fluid-tts.app` as each registry entry's `ops.install` declares, alongside a `SOURCE-COMMIT.txt` recording what they were built from and a `service.installed` event in the shard's log. A service already running is stopped through the control API before its bundle is replaced and started again afterward; one that was not running stays that way, and one whose bundle has not changed is not touched. The registry's launch command runs `fluid-stt.app/Contents/MacOS/fluid-stt` (or the `fluid-tts` equivalent) with `--registry` and `--provider`, with `{registry}` filled with the path of the shard's own `registry.json`.
