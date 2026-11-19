# Speech to text

What turns a user's speech into the text a turn is built from. Three layers run
in the browser, one on the speech machine.

| Layer | Model | Where | Purpose |
|---|---|---|---|
| VAD | Silero | browser (ONNX) | per-frame speech detection; drives the pause threshold |
| Turn detection | Pipecat smart-turn v3 | browser (ONNX) | turn-completion probability; drives the adaptive commit delay |
| Transcription | the model the STT service's roster names | speech machine | the transcript, on commit |

Why the decision logic sits this way — two-stage commit, the adaptive curve, why
Parakeet's punctuation cannot serve as a completion signal — is in
[`../design/turn-taking.md`](../design/turn-taking.md). Browser-side
implementation is the `@platform/voice-engine` package (`voice-engine/src/`); the ONNX runtime version is pinned in `voice-engine/package.json`.

## Services

Voice mode's STT service and model are `voice.stt.serviceId` and `voice.stt.model` in `config.json`; the service is any registry entry with `capabilityId: "stt"` that answers `/v1/audio/transcriptions`. The repo contains these adapters, which you can register:

| Service | Model | Runtime | Notes |
|---|---|---|---|
| `fluid-stt` | Parakeet TDT v3, Parakeet Unified 0.6B, Nemotron Streaming EN 0.6B | FluidAudio / CoreML (`services/fluid`) | Apple Silicon; streaming and batch |
| `stt-faster-whisper` | Whisper (faster-whisper, `turbo` by default) | CTranslate2 (`services/stt/faster-whisper`) | CPU or NVIDIA GPU, on Linux, macOS and Windows; batch |
| `stt-whisper` | Whisper large-v3-turbo | MLX (`services/stt/whisper`) | Multilingual; batch |

`fluid-stt` is not upstream: FluidAudio contains no server. It lives in
[`../../services/fluid/`](../../services/fluid/) beside `fluid-tts`;
`scripts/fluid-build.sh` builds both, and `scripts/shard-install-services.sh` or
`scripts/control-install-services.sh` copies the built binaries to the path each
service's `ops.install` names. The models a `fluid-stt` entry offers are its
provider's `sttModels` in the `roster` section of the registry that registers
it, which it reads at startup through `--registry {registry}` in `runner.main`.
Its registry entry and roster are in `services/fluid/registry.fluid.example.json`, which merges into
a live registry by appending (see [`../setup/speech-servers.md`](../setup/speech-servers.md#fluid-an-apple-silicon-option)); edit it to
register the services you use. The example registries
(`control/control-plane/data/registry.example.json`,
`control/control-shard/data/registry.example.json`) show the shape of the
batch-only entries.

**The process and the model have separate lifetimes.** The registry's `lifecycle` decides when a `fluid-stt` process runs. A Deepgram-compatible client cannot start the process itself, so a registry serving one needs `loadStrategy: "startup"` and `idleUnload: false` on that entry. Inside a running process, the server starts with no model resident, and the first request that needs one loads it: the model the request names, or the roster's `defaultModel` when it names none, in the mode its route needs — streaming for a WebSocket, batch for a transcription. A request never replaces a resident model: naming a different one is a 409, and a nameless request uses whatever is resident. A model that serves both modes gains the missing one when a request needs it. A model that needs a parameter (Nemotron's chunk size) loads on a request only when the request carries it: the dashboard's stream socket sends `chunkMs`, and a different tier of the resident model is a 409 like any other model. Requests arriving during a load wait for it, about 13 s warm and longer on a first load from a new path; a WebSocket is accepted before the load starts. After `idleUnloadMs` without work against the model (in the same provider block; 30 minutes when absent or not positive), it is unloaded, whether a request or `/v1/models/load` brought it up; health checks and model listings are not work, and an open session is never unloaded.

**A session is the sole occupant of the service.** While a WebSocket holds the session — the dashboard's stream or a Deepgram `/listen` socket — everything else is refused at once: batch transcriptions, loads that would change the model, unloads and other sessions (except a takeover, which replaces the session). A load already satisfied succeeds without change, so voice mode starting on another device can reach its takeover. Outside a session, requests queue: a batch transcription behind another waits up to two minutes. Deepgram's own API decides mode by transport, `POST /listen` being pre-recorded and the WebSocket live, so a `/listen` POST is a non-session batch request and its WebSocket is a session. The rule assumes one person using one client at a time: voice mode and meeting transcription do not run together. Why it is shaped this way: [`../design/fluid-stt-on-demand-load.md`](../design/fluid-stt-on-demand-load.md).

**`fluid-stt` is also the alignment source** wherever word timings matter. Its
conversion returns correctly merged word timestamps; the MLX Parakeet server
strips the leading space that marks a word boundary and returns sub-word
fragments — 56 of them for a 28-word clip.

**Parakeet through MLX** measured 0.053 WER against `fluid-stt`'s 0.033 on the same
corpus and has the word-timing defect above.

**Whisper suits multilingual input.** On English it measured slower and less
accurate than Parakeet.

## Transport, for the streaming path

Batch transcription posts the committed utterance. The streaming endpoint takes
audio over a WebSocket, and `fluid-stt` decodes raw Opus frames there
(`services/fluid/Sources/FluidServerSTT/AudioDecode.swift`, libopus).

Both are built on the browser side and the loop carries either without
branching on which: `voice-engine/src/human/stt-transport.ts` is the interface,
`stt-transport-batch.ts` and `stt-transport-streaming.ts` the two
implementations, and `mic-loop.ts` holds no conditional on transport.

**A dropped socket is replaced.** The close event is the whole of the failure
condition, and nothing else detects a stall. While voice is on, `VoiceSystem`
(`voice-engine/src/system/voice-system.ts`) builds a new transport and swaps it into `HumanVoice`,
retrying per `voice.stt.reconnect` in `config.json`. Words the old socket had
not finalized are lost, and one notice says so. Voice ends when another client
takes the session over or when the retries run out, with an error that stays
until dismissed, because a missed notice leaves the interface looking healthy
while voice is off.

**Muting pauses an utterance; it does not finalize it.** On a mute, `HumanVoice` streams `voice.stt.pauseFlushMs` of silence in the microphone's place, so the model produces text for the words already said, and then stops sending, with no `Finalize`. Unmuting resumes sending into the same utterance. Only a hand-off, a discard or voice-off sends a `Finalize`, and no transcription boundary authorises a send: the turn manager delivers a turn.

**Every `Finalize` gets exactly one final, in order.** The server answers each `Finalize` with the words since the previous one and handles audio and requests serially on one socket, so the Nth final answers the Nth `Finalize`. The streaming transport keeps its outstanding requests in a first-in, first-out queue and each final resolves the oldest; a request's own promise is how `HumanVoice` knows which utterance an answer belongs to. `transport.discard()` sends a `Finalize` for speech the loop rejected and drops the answer, so rejected words never reach the next utterance's transcript.

**Partials replace an utterance's words** rather than appending to them — each carries the whole transcript as it stands — and the visible end is trimmed to the last settled word boundary, so a partial mid-word token is never rendered as a whole word. The words live in the transcript store (`store/transcript-store.ts`), and the composer is a view of it: focusing the field mutes the microphone, settles the paused utterance so its words can be edited, and each edit writes through to the store.

The format decision is already made and is the reason the server takes raw
frames. A `MediaRecorder` emits Opus inside a WebM container, which would need
an incremental EBML parser server-side; WebCodecs `AudioEncoder` (Safari 26+)
emits raw packets instead. Measured from an iPhone on cellular over a VPN:
pcm16 ran at 257.8 kbit/s against its 256 kbit/s requirement — no headroom, and
it degrades by falling behind — while raw Opus ran at 21.8 kbit/s, about twelve
times less. The WebM form sat at 50.1 kbit/s, over half of it container. That
margin is what decides whether voice works away from the house.

## Deepgram-compatible surface

`fluid-stt` also answers Deepgram's `/listen` (and `/v1/listen`), so a client written for Deepgram can use it by changing a base URL. Anarlog's Custom speech provider is the one it is built for. `POST /listen` takes the audio file as the raw body; a WebSocket on `/listen` takes `linear16` PCM at the declared `sample_rate` and returns `Results` messages. The `Authorization` header is not checked, and any non-empty key satisfies a client that requires one.

Unlike the dashboard's stream route, where the client decides when an utterance ends, the server decides here: a pause of `endpointing` milliseconds (700 by default) after speech closes the utterance and sends a final. The silence gate is an energy threshold over 10 ms windows (0.01 RMS, about -40 dBFS, not measured against real recordings), so silence before any speech closes nothing. A client `Finalize` also closes the open utterance, and `from_finalize` is set on that result.

The server segments because a Deepgram client expects finals as it goes, and the dashboard route never emits one unprompted; a meeting client would otherwise see one growing interim and lose it on a dropped socket. The listen route claims the model with a generated session and no takeover, so a second concurrent client is refused instead of displacing a call in progress.

Limits:
- Multi-channel audio is averaged to mono, so Anarlog cannot tell the microphone from the other participants. Separating them would need two sessions on one model.
- There is no cap on utterance length: a speaker who never pauses for `endpointing` gets one growing interim and no final.
- Confidence is always 1.0, and diarization, filler words, numerals and keyword boosting are ignored.
- The contract is Anarlog's parser (`crates/owhisper-client/src/adapter/deepgram/` in `fastrepl/anarlog`); Deepgram's own specification has not been read.
