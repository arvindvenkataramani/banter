# Fluid server: streaming synthesis, and one package for both servers

Two decisions that turn out to be one. Streaming TTS breaks the assumption the TTS server's resident actor rests on, and the state that fixes it is already written on the STT side. That makes the resident lifecycle the core of what the two servers share, and shared code needs somewhere to live.

Scope: streaming synthesis for the benchmark, the dashboard-to-server transport for the voice loop, and the package structure that holds both servers. Not in scope: FluidAudio internals beyond `synthesizeStreaming`'s signature and `AudioFrame`'s shape.

## Streaming synthesis

**Why it matters.** Every TTS figure in the benchmark is batch, so TTFB there is time to the *complete* response, and it therefore scales with the utterance: 0.68 s for a twelve-word line, 8.98 s for the longest text in the set. Pocket-TTS runs streaming in production under mlx-audio and at 0.177 RTF generates far faster than real time, so first audio should arrive on a clock the text length does not move. Measured, it does — about 0.32 s across that whole range, against 0.675 s to 8.984 s batch on the same five texts. A voice loop is bounded by that constant rather than by the slope, which is what makes the model usable in one. The runs are `results/2026-09-19T14-16-08-stream.csv` and `2026-09-19T02-43-44-batch.csv` under the TTS benchmark harness.

**Capability, not a special case.** Only Pocket-TTS can stream; `PocketTtsManager.synthesizeStreaming` returns `AsyncThrowingStream<AudioFrame, Error>` and the other seven backends expose a whole-utterance `synthesize` only. That is a fact about the current backends, not a shape to build around: another streaming model must fit the same capability.

So a separate protocol, `TtsStreamingDriver`, with one method yielding samples and a sample rate. Only Pocket-TTS conforms. A second protocol rather than an optional method on `TtsBackendDriver` means the seven non-streaming backends need no edit, and a future streaming model conforms with one method.

The driver's only job is to yield samples as they exist. Buffering, WAV framing and flush live outside it, so a new driver inherits the TTFB behaviour rather than reimplementing it.

**Buffering policy.** Accumulate frames until `bufferedSamples >= interval * sampleRate`, emit, reset; flush the remainder at the end. Overridable per request so the benchmark can sweep it. A *time* interval rather than a sentence or frame count is the point: TTFB is then bounded by the interval regardless of text length.

The sweep puts the interval at **0.5 s**. Below about 1.0 s, TTFB stops tracking the interval and settles near 0.3 s — the wait there is the model reaching its first frames rather than the buffer filling — so 0.5 s sits at the floor while a quarter-second buys 0.005 s for nearly twice the chunks. RTF is flat across the range, so a smaller chunk costs only the encoder call that frames it.

This is about fifteen lines and it is the whole policy layer. It belongs in its own function, testable without a model — it is the only part with a decision in it.

**Wire contract: one container per response.** A response is a single encoded stream — one header, then frames emitted as they are produced. Not one self-contained file per interval. A per-interval container repeats the header at every seam and, for any codec with encoder delay and end padding, puts a gap there too; concatenated, those seams are audible. The encoder is opened once when the response starts, fed each buffered chunk, and flushed at the end.

**The codec is AAC in ADTS.** ADTS frames are self-delimiting, so they concatenate the way the dashboard's MediaSource already consumes audio, and AudioToolbox encodes AAC natively at 24 kHz mono with no vendored dependency. Speech at 24–32 kbps is transparent, and the choice is about what both ends can speak rather than about speed: encoding costs 60–90 ms of TTFB and the figure does not grow with length, so it is the encoder priming once rather than a per-chunk tax. On a 37 s utterance the AAC response finished *sooner* in wall time than the WAV one, writing a twelfth the bytes.

**`response_format` selects the format.** The dashboard asks for one, the benchmark asks for another, and a caller that writes files to disk may want a lossless format. A format the server cannot produce is an error, never a silent substitution: returning WAV to a caller that asked for something else is a contract violation that surfaces as unplayable audio rather than as a failure.

That negotiation is also the compatibility story, and Banter is not single-device: people use it from Android phones as well as Apple hardware. AAC is the right primary for exactly that reason — Android has decoded AAC-LC since 2010 and Chrome plays it in MediaSource, so it is the more portable choice rather than the Apple-flavoured one. WAV is the floor beneath it: anything that cannot decode AAC can still play WAV, losing the MediaSource path but not the audio.

mp3 is reachable but unnecessary. AudioToolbox decodes it and will not encode it, so it would need LAME behind a C interop target — the pattern the STT server already uses for `COpus`, and `lame_encode_buffer` is incremental, so it would fit the same one-encoder-per-response shape. Small, but it buys nothing: AAC already covers every device Banter serves. Add it only if a real one turns up that needs it.

Worth checking on a real Android device is whether Chrome there wants fragmented MP4 rather than raw ADTS framing; the WAV floor covers that case until someone tests it.

A driver that does not conform to `TtsStreamingDriver` serves the whole utterance as one response in the same container. The wire shape is then uniform across backends and a client never branches on which model it is talking to.

**The dashboard has mp3 compiled in**, in three places: the MIME passed to `addSourceBuffer`, the blob fallback's type, and `streaming-backend.ts`'s capability probe. It speaks mp3 because that is mlx-audio's default, not because anything chose it. Moving to AAC makes that MIME follow the format requested, which is the change that lets one playback path serve either server.

**Mid-stream errors truncate and log.** Status and headers are already sent by the time a failure can occur. Inventing a trailer the harness does not parse helps nobody.

**Do not fake it by splitting text.** That measures the server's splitter. This project already fell into that trap once.

## Streaming breaks the resident actor

Batch `synthesize` serialises because it awaits completion inside the actor. A streaming method returns an `AsyncThrowingStream` immediately and releases the actor while CoreML is still predicting. Three consequences:

- A second request can enter mid-stream, putting two CoreML predictions in flight — the libBNNS crash (FluidAudio #661) the actor exists to prevent. The dashboard's client-side semaphore permits several chunks at once, so this is a normal case, not an edge.
- `unload()` or `load(other)` mid-stream nils the driver while frames are still coming.

`ResidentTtsModel` has none of this state. `ResidentModel` on the STT side has all of it, and for exactly this reason: Swift actors are reentrant across an `await`, so isolation alone only serialises the spans *between* suspension points.

- `transitioning` is true for the whole span of a load or unload, including while `loaded` and `session` are both nil and so cannot themselves signal busy.
- `session` holds the resident slot for a stream's duration, excluding batch work and any other session.
- A session token distinguishes one session from the next, so a late teardown cannot end a session it does not own.
- `waitForFreeSlot` bounds the handoff case — a client closing one connection and opening the next arrives while the previous teardown is still running, and refusing there would be refusing on a technicality.

Every entry point opens with `if session != nil || transitioning { throw streamBusy }`.

Two departures from the STT shape, both forced by TTS. **Batch synthesis holds the slot as well.** STT's `transcribe` only checks the flags, because a stream there is never begun mid-transcribe; here a stream beginning during a batch await puts the same two predictions in flight from the other side. Both paths take the slot for their whole span, so every entry point tests one thing. And **the wait deadline has to outlast a whole utterance** — around six seconds at the batch median — because several chunks of one reply arrive together and a caller queueing behind another is ordinary rather than a handoff artifact.

**The slot releases when the producer ends, not when the consumer stops reading.** Hummingbird cancels the request task on client disconnect, and iterating an `AsyncThrowingStream` from a cancelled task returns nil at once — while FluidAudio carries on predicting. Releasing there would hand the next request an overlapping prediction, which is the crash the slot exists to prevent. So the frame loop runs in an unstructured task that does not inherit that cancellation, draining to the producer's own end and releasing there. Draining costs the remaining synthesis time, which is what cancellation on the socket buys back.

That reasoning is not about speech recognition. It is about one CoreML model resident behind an actor with a long-running operation that outlives the call that started it — which is what TTS becomes the moment it streams. **The state is generic and the TTS streaming work needs it from the start, not as a later hardening pass.**

### Every model loads the same way

A model is weights in memory. How it is then driven — one shot over HTTP, or a session over a socket — is a property of the request, not of the load. So `load` builds whatever the catalogue names and puts it in the slot, whichever kind it is, and `/healthz` reports what is actually resident.

This matters because the alternative breaks the rule the load exists to keep. A load costs seconds, and those seconds must be paid where the caller can see them: on the explicit load, or on the first request of a server that declares it loads on request (see [fluid-stt-on-demand-load.md](fluid-stt-on-demand-load.md)), never hidden in a later one. A session model whose manager is built when a socket connects moves that cost onto the first connection — the one place a voice loop cannot absorb it — while `/healthz` reports a model that is not in memory at all.

What differs between the kinds is only what they refuse. A session model has no one-shot call, so transcription against one is refused by name rather than by claiming nothing is loaded. A batch model cannot stream, so a socket asking for one is refused the same way. Both refusals come from asking the resident model what it is, not from a second notion of residency.

The slot is unchanged by any of this: one model, one operation, taken for the operation's whole span. A socket takes it for the life of the connection and hands it back on every path out, so a transcription arriving mid-session is refused with the work that holds it named. Closing a socket is not an unload — the model stays resident exactly as a batch manager does between transcriptions.

## Package structure

One SwiftPM package holds both servers, because nothing requires different FluidAudio revisions or macOS minimums. Both build against one exact upstream FluidAudio release, so:

```
services/fluid/
  Package.swift          — FluidAudio (exact upstream release), Hummingbird; platforms: .v15
  Sources/
    FluidServerKit/      — shared
    FluidServerSTT/      — executable: fluid-stt
    FluidServerTTS/      — executable: fluid-tts
```

One package, so shared code is an ordinary target dependency: no path dependencies, no version skew between the two servers' copies of it. A single shared target rather than a Foundation-only/HTTP split — both servers are Hummingbird servers already, and nothing else will consume these targets.

### What is shared

**Resident-model lifecycle.** Slot state, the transitioning flag, token-based session release, `waitForFreeSlot`, the busy check on every entry point. Generic over what the slot holds; the work methods stay modality-specific.

**The HTTP surface** — error body shape and status mapping, response constructors, the `/v1/models` and `/healthz` models and routes, and CORS. These are shared because they are externally visible, not because of the code saved: two servers in the same family answering the same OpenAI-compatible endpoints differently leaks to every client written against one and pointed at the other.

CORS is the sharpest case, because both servers are already configured by the same hand through `FLUID_CORS_ORIGINS`: a second spelling of that variable, or one server allowing an origin the other refuses, is a trap for whoever sets them. It is duplicated: the two packages pin different Hummingbird revisions and `CORSMiddleware`'s initialiser differs between them, so the duplication is not even textual. Reconciling those pins is part of the collapse, and this is one of the things that has to land on the far side of it.

**Utilities** — argument parsing, log bootstrap, and the audio encoders.

### What is not

**The backend drivers**, and **the two Audio modules** — STT decodes Opus off the wire, TTS encodes WAV and trims StyleTTS2 references. No common contract underneath them.

### Two executables, not one

Required, not a convenience. FluidAudio #661 records the crash: two *distinct* managers predicting concurrently land on Apple's shared `com.apple.e5rt.concurrentExecutionQueue` and corrupt E5RT/BNNS scratch state, giving `EXC_BAD_ACCESS` in `libBNNS` on a write into read-only mapped model memory. Each manager is already serial internally, so the race is purely cross-manager. `cpuOnly` does not help — the crash is already on the BNNS CPU path.

An STT manager and a TTS manager in one process are two managers. Per-manager actor isolation does nothing across them; nothing in CoreML serialises one against the other. And the voice loop needs exactly that concurrency, because STT running live while TTS synthesises is what barge-in is.

One process would therefore need a shared serialiser across both modalities — which makes barge-in impossible by construction. Two processes give each its own E5RT state, and the concurrency is between processes where no shared queue exists.

Three things point the same way independently:

- **TTS has a consumer outside the voice loop.** The shard registry's roster drives any caller of the speech API, where TTS can run with no STT at all. The two idle lifecycles genuinely differ, so a single session-scoped clock would be wrong.
- **The failure mode is uncatchable.** `EXC_BAD_ACCESS` kills the process. In one process, a rough TTS backend takes a live STT session down with it. Fault isolation here is a correctness property, not operational tidiness.
- **Banter's service machinery is per-process** — one registry entry, one Serve port, one memory budget per service, and the benchmark's `vmmap` footprint method measures a process. Merging them makes STT-versus-TTS memory unmeasurable, which is what this work exists to measure.

What favours one process: fewer registry entries, one deploy, one port. Not enough.

## Two transports

The benchmark and the voice loop want different things from the same synthesis path, and one transport serves both badly.

### Benchmark: HTTP

`POST /v1/audio/speech`, as above: the response streams as it renders, with no flag asked, and `stream_format: "sse"` sends the same audio as server-sent events. One request, one utterance, no queue, no cancellation. The harness reads whatever the server sends — it is an instrument, and it follows the wire format rather than setting it.

### Voice loop: WebSocket

Text arrives at the dashboard from the gateway a token at a time and should reach synthesis as fast as it arrives. Over HTTP it cannot: a request needs its text up front, so the dashboard has to accumulate enough to be worth sending. That is what `text-chunker.ts` exists for — it is a consequence of the request boundary, not a requirement of the voice loop. **A socket removes the boundary and the chunker with it**: text goes out as it arrives, and the server synthesises on whatever boundaries it finds.

Streaming also makes the server one-stream-at-a-time, so overlapping work has to queue. Held-open HTTP requests are a queue with no control surface — no way to drop it as a unit, no ordering between a cancel and the work it cancels, N independent aborts racing N connections. On a socket, barge-in is one ordered message: stop generating, drop the queue. Audio already on the wire is the client's problem, and `playback-engine.ts`'s generation counter already discards it.

The server queues rather than the dashboard serialising. Synthesising the next span while the current one plays is what keeps the seams gapless, and the dashboard should not be modelling the fact that the server holds one model — that is a server fact, and it would have to change again if it stopped being true. The queue needs a depth cap so a runaway client is refused rather than hanging.

**Whether audio arrives as it renders is a declared capability.** The roster declares `streaming` per serving (a runtime's fact about a model) and the speech API's adapter holds the `renders-progressively` capability, which the API's own default response grants and the `stream-flag` extension grants for runtimes that need the flag. The playback engine asks for progressive audio from browser capability alone, and the adapter sends `stream: true` only to a provision that declares `stream-flag`; `fluid-tts` declares neither the flag nor a need for it, since it streams every response that can stream. The `realtime` flag in `voice.tts` marks a model fast enough for the voice loop and is read only to filter the model picker, so a model that cannot stream still shows up in the loop as a long first-audio wait with nothing to attribute it to.

STT already holds a socket for its streaming session. A WebSocket here is the consistent shape, not the exception.

**One connection at a time drives synthesis, by the same claim STT uses.** `SocketClaim` in `FluidServerKit` decides who holds the socket, by a `session` id and an optional `takeover`: nobody holding it, or the holder's own id reconnecting, grants it; another id is refused `held` unless it takes over, in which case the holder is closed `superseded`. The claim gates the connection; synthesis itself still takes the model slot per span through `beginStream`, unchanged by any of this.

Every error frame on this socket carries the same codes as STT's, but not every one closes the connection. An error that ends the session — the claim refused or taken over, an unknown format, the wrong model at connect — sends the coded frame and then its matching close code, exactly as STT's does. An error scoped to one request on a session that carries on — the queue full, one span's synthesis failing — sends the coded frame alone: the queue holds several spans on one connection, so one span's failure is not the connection's failure, and the socket stays open for what the client sends next.

### Idle release belongs to the shard, not to either server

Neither transport says when to unload, and neither server needs to decide. Both are registered demand-loaded with `idleUnload` and a thirty-minute timeout, so the shard stops the whole process once it goes quiet and the resident model dies with it. An in-process clock would be a second timer doing a subset of that, inside a lifetime the shard already owns.

The socket's own watchdog is a different thing and stays: it bounds a client that holds a connection and stops sending, which would otherwise make the server refuse all other work while waiting on a peer that may be gone. That is about one connection, not about the process.

This holds because these servers run under a supervisor that evicts them. A build shipped anywhere the process outlives its own idleness — run by hand, in a container, on someone else's machine — would need its own release, and the kit's slot is where it would go.

## Open questions

**Whether the upstream cross-manager crash was closed by a fix, and which.** The issue is closed. A shared serialiser landing does not change the decision — serialising across modalities is what barge-in cannot have — but it changes what a single process would have cost, and it is worth knowing before the FluidAudio version moves.

**Whether mlx-audio needs a matching streaming run.** FluidAudio streams first audio at about 0.32 s whatever the length. mlx-audio's Pocket-TTS arm is measured batch at 0.21–2.6 s, which is the same length-dependent shape and so not comparable directly; its floor being near FluidAudio's constant is what makes the comparison uninteresting, since streaming there could only bring it to a similar place. Worth running if a reason to move off FluidAudio appears; it does not gate the voice loop.

## What remains

Both servers build from `services/fluid/` against the upstream FluidAudio release, registered as `fluid-stt` and `fluid-tts`. Each generates its model-lifecycle routes from its own `openapi.yaml`; synthesis, transcription and the sockets stay hand-written.

**Model routes converge.** Both servers answer `GET /v1/models` and `/healthz`, and load and unload models through `triton.model-repository`: `POST /v2/repository/models/{name}/load` and `.../unload`, with `mode` and `variant` as load parameters on the STT server, and `POST /v2/repository/index`. The routes that were mlx-audio's and the older load routes are gone. The voice engine reads no listing: the roster declares the models, and a load of a model with no weights on disk fails with the server's own message.

`docs/reference/design/fluidserver-model-lifecycle.md` describes the STT lifecycle. Its component detail on the managers and the model catalogue holds; the lifecycle itself is `ResidentSlot` in the shared kit, shared by both servers.
