# Speech output — chunking and why the loop is custom

How generated text becomes audio, and the two decisions behind it that are not visible in the code: how many TTS calls a response takes, and why this loop was built rather than adopted. Implementation: `voice-engine/src/agent/text-chunker.ts`, `speech-chunker.ts`, `playback-engine.ts`, `streaming-backend.ts`. Chunk parameters are documented in [the configuration reference](../configuration.md#voicetts) under `voice.tts.options`.

## Two calls, not one per sentence

**The loop speaks to every provider over HTTP, and HTTP fixes the text at request time.** mlx-audio and Kokoro expose `/v1/audio/speech` with `stream: true`, which takes all the text upfront in one POST and streams audio bytes back; only the output streams, and neither has an incremental-input API. `fluid-tts` also serves a WebSocket at `/v1/audio/stream` that takes text span by span, which would remove the chunk boundary altogether, but the dashboard has no client for it yet (see [`fluid-server-streaming-and-structure.md`](fluid-server-streaming-and-structure.md)).

So the work is discrete HTTP calls, and the question is how many.

**Splitting at every sentence is wasteful.** Each call pays roughly a second of startup on mlx-audio regardless of length — measured at 1.0 s for 12 words, 1.2 s for 49, 1.8 s for 102. Sentence-level splitting pays that repeatedly. Waiting for the whole response pays it once but leaves the user in silence while tokens generate.

**Two calls resolve it for most responses.** Accumulate complete sentences from the token stream until the combined word count clears a minimum, then fire immediately at that sentence boundary. Keep accumulating while the first chunk's audio plays; when the stream ends, send the remainder as a second call and append its audio to the same buffer.

This works because generation is much faster than playback. Twelve words become roughly 4.5 s of audio in about a second, so dispatching the first chunk buys a ~3.5 s head start, during which the LLM produces far more than the second chunk needs. The playback buffer absorbs the variance.

**Why a minimum word count exists at all.** Below about twelve words the startup cost is disproportionate — a second of inference for 4.5 s of audio is 22% overhead. Above it the cost amortises fast: 1.2 s for 16 s of audio is 7.5%. The minimum keeps the overhead off tiny fragments without delaying the first audio. A response that ends before the minimum is reached goes out as one call, which is the common case for short factual answers.

Models with different cost profiles need different strategies, which is why the chunk profile is configuration rather than a constant.

## Why this loop is custom

Five existing voice implementations were surveyed, and the most sophisticated — an OpenClaw plugin with multi-provider STT/TTS, VAD, interruption handling and fallback chains — was evaluated in depth. Adapting it would have been more work than building this, with a worse result.

The generic part of a voice loop is the easy part: listen, detect silence, transcribe, call the LLM, synthesise, play. What is actually hard is the infrastructure — which models, where they run, how they fail over — and the UX details, which are specific to this hardware and network. Adopting someone else's loop would have meant replacing the internals and keeping scaffolding that does not help.

The survey did change the design. TTS minimum-buffer playback, transcript deduplication as insurance against double-processing, and the idea of audio feedback during processing gaps all came from reading it, as did a sharper view of hallucination filtering and of the core loop as a module that could drive more than one surface.

## Open

- **Acknowledgment before slow responses.** Speaking a short filler while the LLM works would cover the gap before first audio. Designed, never built.
- **Speaker identification.** Verifying the speaker is the enrolled user would serve as noise rejection — rejecting speech from a television or another person in the room. Parked; a prototype exists on an abandoned branch.
- **Audio feedback during gaps.** Three layers mixed simultaneously — ambient, state transition, event — was sketched against the processing gaps the acknowledgment idea also addresses.
