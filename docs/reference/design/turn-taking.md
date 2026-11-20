# Turn-taking and endpointing

How the system decides the user has finished speaking. Implementation: `voice-engine/src/human/mic-loop.ts`, with the models in `silero-vad.ts` and `smart-turn.ts`. Parameters and their defaults are documented in [the configuration reference](../configuration.md#voicestt) under `voice.stt.turnTaking`, and served from `config.json` — this document does not restate their values.

**Terminology.** The industry calls a user speaking over the system "barge-in". We say "interruption". External sources — LiveKit, Pipecat, the academic literature — use the former; translate when citing them.

## The problem

A fixed silence threshold is a bad signal for "done speaking". People pause to find a word, to think, to breathe. Any single threshold fires too early for someone thinking aloud and too late for a quick "yes". The whole design follows from refusing that trade.

## Two-stage commit

Silence triggers a **pause**, not a commit. A second, adaptive wait triggers the commit.

**The mic never stops.** Pause is a logical state; audio keeps flowing into the buffer. An earlier design stopped and restarted capture across pauses and was abandoned — it cost re-permission latency and forced a second accumulation buffer separate from the capture buffer. With the mic always open, the buffer is the whole utterance and resetting it touches nothing in the audio pipeline. Silence inside the buffer is harmless: Parakeet ignores non-speech regions.

If speech resumes during the wait, the commit timer is cancelled and the buffer keeps accumulating. A speaker can pause mid-thought indefinitely.

**Why two stages rather than one longer threshold.** A single long threshold adds its latency to every turn. Two stages let the system react fast when confident and stay patient when not, and the second stage only runs for speech that has already gone quiet.

**Silero VAD's per-frame verdict drives the transitions**, not an energy measure. `human/energy-analyzer.ts` computes RMS energy, but nothing consumes it. A level gate in the VAD — requiring a louder frame while the agent is speaking, since an echo arrives attenuated — reduced echo in testing and was removed: echo feeding back into a turn depends on whether any gets through, not how much, and the gate added a pass over every frame on a device with no headroom. If level is wanted again, it belongs in the capture path or a worker, not in the VAD's per-frame work on the main thread.

### Safety flush

Continuous speech that never triggers a pause is handed off `voice.stt.maxRecordingMs` after the utterance was confirmed, five minutes by default: the loop transcribes what it holds and keeps listening, and speech that continues is a new utterance joining the same turn. It is a valve for monologues and for a stuck VAD, and the one path where the loop ends an utterance over a speaking user, because the alternative is never ending it.

## Adaptive endpointing

Pipecat's `smart-turn-v3` (BSD-2-Clause, ONNX) predicts turn completion from raw audio — no transcript, no text analysis, no LLM call. It runs browser-side in roughly 12 ms.

**The commit delay is a piecewise curve, and this is a deliberate departure from prior art.** LiveKit and Pipecat both switch binary: above threshold use the minimum delay, otherwise the maximum. We use three regions — a ceiling above the confidence threshold, a floor below a low cutoff, and a configurable curve between them.

The reason is that the model's intermediate probabilities carry information. At 40% confidence the speaker is probably mid-thought; at 65% they are probably done but not certainly. A binary switch discards that. The curve is quadratic by default, which keeps the system patient across most of the ambiguous band and only commits fast once confidence is genuinely high.

The prior art goes binary for simplicity, and because their models' intermediate probabilities are less reliable than this one's.

**The two numbers to watch when tuning** are the response-time bounds: pause threshold plus minimum delay is the best case, pause threshold plus maximum delay the worst. Both follow from the config; neither is worth hard-coding into prose that will drift.

### Parakeet punctuation cannot serve as a completeness signal

Parakeet places periods on acoustic pauses, not semantic structure. It inserts them mid-thought — "I'm only five years behind. The state of the art" — and omits them at real sentence boundaries. This holds even over long buffers with full context, so it is not an artifact of fragmentation.

A "does it end with a period?" heuristic would therefore fire false positives at exactly the moments being evaluated, and miss real boundaries. That rules out the cheap regex pass the literature suggests as a first approximation, and is part of why endpointing works on audio here rather than text.

## The buffer

Because the mic never stops, there is no separate accumulation buffer to manage: `UtteranceBuffer` (`human/utterance-buffer.ts`) keeps a rolling preroll and switches to append-only when speech begins, and `getUtteranceAudio()` returns the utterance with the preroll ahead of it. `endUtterance()` trims back to preroll without touching the `AudioContext` or `MediaStream`, so a hand-off costs nothing in the audio pipeline.

On a streaming transport the words appear while the user speaks; see [`voice-loop-streaming-stt.md`](voice-loop-streaming-stt.md).

## Interruption

Speech the system was not expecting lands in one of three places, depending on how far the user's turn has got.

**During the commit wait**, speech cancels the pending hand-off and the utterance carries on. The speaker never learns the commit gate almost fired. This is the ordinary mid-thought pause.

**After a hand-off**, speech is a new utterance. It joins the same turn while the first is still transcribing, and reopens the turn if that has already closed, so one message carries both whenever the words have not yet gone.

**While the agent has the floor**, a confirmed utterance ends the agent's turn and aborts its run, whether or not the agent had started speaking. The partial response stays in history rather than being deleted, because the user may have heard part of it and a message that vanishes is worse than one that stops short. This case needs echo cancellation to be working: without it the system hears its own speech and interrupts itself. The rules are in [`voice-floor.md`](voice-floor.md).

## Browser implementation

This section documents what was non-obvious when porting smart-turn to the browser. None of this is in Pipecat's documentation — it only emerged during implementation.

### Pipecat's implementation is Python-only

The smart-turn repo (`pipecat-ai/smart-turn`) and the main `pipecat-ai/pipecat` repo contain no JavaScript. All inference code is Python using `onnxruntime` (server-side) and HuggingFace `transformers`. There is no reference browser implementation to follow. We are the first to run this model in a browser.

Cloning the repos was useful not for finding JS code but for reading the Python inference to understand preprocessing:
- `WhisperFeatureExtractor(chunk_length=8)` — constructed directly with a fixed 8-second chunk length, not loaded from pretrained
- Called with `do_normalize=True`, `padding="max_length"`, `truncation=True`
- Output shape: `[1, 80, 800]` (80 mel bins × 800 frames for 8s at 16kHz)

This confirmed the expected tensor shape and that the feature extractor config is specific to 8-second windows, not Whisper's default 30 seconds.

### One multi-threaded ORT runtime, never bundled

Silero VAD and smart-turn share one `onnxruntime-web` instance, which `loadOrt()` in `voice-engine/src/human/ort-init.ts` imports from `onnxruntime-web/wasm`. The WASM backend covers every operator both models use, including smart-turn's int8 `QuantizeLinear`/`DequantizeLinear`, so no larger bundle is needed.

Multi-threaded WASM needs `SharedArrayBuffer`, which only a cross-origin isolated page has, so every dashboard response carries `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`: `serveStatic` in `control/shared/src/static.ts` sends them in production and `server.headers` in `dashboard/vite.config.ts` in dev. When the page is isolated ORT runs `min(4, hardwareConcurrency)` threads, otherwise one. Browsers isolate only a secure context, the same condition they set for the microphone, so any page where voice can start gets the threads unless something between server and browser strips the headers. The settings dialog notes when a secure page is not isolated. Smart-turn's median inference falls from 184 ms to 96 ms on a four-core iPhone at four threads, and from 147 ms to 44 ms on the Mac; ORT's own default of half the cores would give the iPhone only two threads, at 112 ms. Silero takes about 0.2 ms at any thread count. With isolation missing and more than one thread requested, the model fails to load, and only a console warning (`numThreads is set to 4, but this will not work unless you enable crossOriginIsolated mode`) says why.

ORT is never bundled. Each worker thread ORT starts loads the module ORT's code lives in, and any chunk the bundler writes may import the app's main chunk for a shared helper; a worker that loads the main chunk runs the whole app, fails on `document`, and session creation waits for threads that never start. A dynamic `import()` of the package is not enough, because Rolldown still hoists helpers into the main chunk. So `loadOrt()` imports ORT's prebuilt `ort.wasm.bundle.min.mjs` with `?url`, which Vite copies unchanged as an asset, and loads it with `import()` at runtime; that file imports nothing. Dev hides the failure, because Vite serves ORT as a separate module there; only a production build shows it, so check voice on a production build after any change here.

COEP `require-corp` blocks any cross-origin image, script or frame whose server does not opt in. Safari has no `credentialless` mode, so the softer policy is not available on the iPhone. Chat therefore renders only images embedded as `data:` URLs and shows a remote image as a link, as OpenClaw's own chat does; everything else the dashboard loads is same-origin, a blob, or a CORS `fetch`.

One runtime matters most on the iPhone: Safari keeps WASM memory past the tab that allocated it, and after three ORT runtimes had loaded, a fourth failed at startup with `RangeError: Out of memory` until Safari was force-quit.

The `.wasm` is imported with `?url` too, and `wasmPaths` names it, since the unbundled module cannot locate it itself. Both are content-hashed assets under `/assets/`, so the static server's long cache there is safe across upgrades. Serving the runtime from `public/` does not work in dev: Vite's dev server rejects imports of files under `public/`.

### The log-mel features are computed in-house, not by transformers.js

`voice-engine/src/human/whisper-features.ts` computes the `[1, 80, 800]` input itself, with the mel filters read from `public/models/whisper-tiny/preprocessor_config.json`. It prepares the waveform as the reference inference above does: the last 8 s, zero-padded at the start so speech ends where the window ends, then normalized to zero mean and unit variance over the whole window. transformers.js has no `do_normalize` and pads at the end, so neither step comes from it. Its FFT, window and padding are adapted from transformers.js 4.0.1. transformers.js runs the mel projection as an ONNX MatMul through its own onnxruntime-web (1.25-dev), which it loads from jsdelivr at runtime: a second ORT runtime, with a WASM heap that never shrinks, fetched from a CDN, for one matrix multiply. The in-house version does that multiply as a loop and allocates its working buffers once.

transformers.js stays a pinned dev dependency as the reference: `whisper-features.test.ts` requires our output to match its `WhisperFeatureExtractor` to within 1e-4 (it matches to one float32 rounding step). Upgrading that pin means re-checking the adapted code against the new version.

---

## Open

- **Energy onset is unused.** It would fire at ~32 ms against VAD's ~256 ms, at the cost of spurious pauses on noise.
- **An LLM completeness check was designed but never built.** Asking the agent's own model whether a transcript is a complete thought would bring semantics and conversational context that audio cannot: a 3 s pause after "The answer is forty-two." differs from one after "The answer is…". The cost is a network round-trip of 200–500 ms and a dependency on transcript quality, which the Parakeet punctuation finding above makes suspect. The literature's preferred shape is both signals together — audio first, LLM only when the audio model is ambiguous.
- **The curve is guessed, not fitted.** It should be tuned from telemetry on real speech, separating two outcome types: commits that fired while the user was still speaking, and commits that made the user wait after they had finished. The two may want different curve shapes.
