# Checking a FluidAudio version

`../Package.swift` pins FluidAudio to an exact upstream release. Read this before changing that version: a FluidAudio regression in Pocket-TTS produces no error, only worse audio.

## What can go wrong silently

**Garbled speech and misplaced cuts.** FluidAudio releases before 0.17.4 switch the whole input to one token per character on meeting a single character outside the model's vocabulary. Absent from the English vocabulary: `( ) [ ] { } … / # @ + = < > ` ~ | \ ^ ° € £ • → × ™`, emoji, tab, newline. A chunk holding one of these is spoken as garble ("theee control plan on… theee Pie whyk also serve…"). Text from an LLM carries parentheses and paragraph breaks routinely, so this affects most voice-loop replies.

**Sentences cut at 50 tokens.** The CoreML conversion has a fixed 512-slot KV cache, and releases before 0.17.4 cut every sentence over 50 tokens into separately synthesized chunks, so prosody restarts at each cut. Ordinary sentences run 52 to 70 tokens. Releases before 0.18.1 also place an unavoidable cut between two words when a dash or bracket edge was available.

0.18.1 is therefore the oldest release the servers can be built against.

**A model the library fetches.** A FluidAudio manager downloads whatever file it expects and does not find. A release that renames a model file or changes a default pack turns a load into a download. The Pocket driver names its language pack (`.english2026Apr`, the pack in `v2.1/english`) for this reason: FluidAudio's `.english` follows Kyutai's newest checkpoint.

**A resource bundle left out of the app.** FluidAudio targets carry SwiftPM resource bundles, and a target that cannot find its bundle traps at first use. `scripts/fluid-build.sh` copies every `FluidAudio_*.bundle` into each app.

## The checks

Run `scripts/fluid-smoke.sh` first. It builds both servers, runs them from a scratch install with the network denied, loads every roster model on disk, has each TTS model synthesize a sentence in one roster voice, and requires the scratch fluid-stt to hear it back. It fails on a missing bundle, on a model file the build wants and the machine lacks, and on audio that does not transcribe.

Then listen. The smoke test proves a sentence is intelligible; only an ear finds a pause in the wrong place. Synthesize `passage-2.txt` with Pocket-TTS in a cloned voice and listen for garbled fragments at the bracketed aside and for a pause before the last words of the long sentence.

A caution on long sentences. Kyutai's Python implementation of Pocket-TTS holds chunks to 50 tokens, cuts an oversized sentence at `, ; :` "to prevent skipped words", and logs that a chunk still over the limit "may skip words". That is a property of the model, separate from the cache. If the voice loop ever drops words from a long sentence, suspect the whole-sentence rule first.

## Checking without listening

- `PocketTtsChunkProbeTests.swift` prints what the model is given, chunk by chunk, for `passage-1.txt` and `passage-2.txt`, with the model's real tokenizer. Copy it into `Tests/FluidAudioTests/TTS/PocketTTS/` of a FluidAudio checkout, run `POCKET_PROBE_DIR=<this folder> swift test --filter PocketTtsChunkProbeTests`, then delete it. A chunk flagged `PER-CHARACTER` has as many tokens as characters and will be spoken as garble. The probe calls the chunker directly, so it shows 50-token chunking whatever the synthesizer's whole-sentence limit is.
- `tokenizer_parity.py` prints the token ids Google's `sentencepiece` gives for each line of `tokenizer-parity-input.txt`. FluidAudio's ids should be identical.
- Passage 1 is the `extended` text of the TTS benchmark; its third sentence follows a paragraph break. Passage 2 has a bracketed aside, an ellipsis, a spaced hyphen, and one sentence with no punctuation.

Never use a `fluidaudiocli` binary from a shared working clone as a baseline: build it in its own worktree from a named revision.

## Where the rest lives

The upstream record is FluidAudio issues #931, #933 and #934.
