# FluidAudio patches for Pocket-TTS

Unpatched FluidAudio at `b68f4847` speaks Pocket-TTS badly in two ways, and both are in FluidAudio, not in `fluid-tts`. The three patches here fix them, and **the servers apply them**: `../Package.swift` pins `arvindvenkataramani/FluidAudio` at `6843a35b`, which is the three commits stacked on `b68f4847` in that order.

Read this before changing the FluidAudio pin in `../Package.swift`. A pin bump that drops these fixes brings the defects back silently; nothing fails, the audio just gets worse.

## The defects

**Garbled speech and misplaced cuts.** FluidAudio's SentencePiece tokenizer switches the whole input to one token per character when it meets a single character outside the model's vocabulary. Absent from the English vocabulary: `( ) [ ] { } … / # @ + = < > ` ~ | \ ^ ° € £ • → × ™`, emoji, tab, newline. A chunk holding one of these is spoken as garble ("theee control plan on… theee Pie whyk also serve…"). The chunker also counts tokens before collapsing whitespace, so the first sentence after a paragraph break is measured by its character count and cut between two words. Text from an LLM carries parentheses and paragraph breaks routinely, so this affects most voice-loop replies.

**Sentences cut at 50 tokens.** The CoreML conversion has a fixed 512-slot KV cache, and FluidAudio therefore cuts every sentence over 50 tokens into separately synthesized chunks; prosody restarts at each cut. Ordinary sentences run 52 to 70 tokens. mlx-audio runs the same model with a growing cache and speaks them whole.

## The patches

Apply in order to a checkout of `b68f4847` with `git am patches/*.patch`. Together they reproduce the branch `pocket-tts/3-whole-sentences`.

| Patch | What it does | Upstream |
|---|---|---|
| `0001` tokenizer fix | An unknown character becomes its byte-fallback tokens and the words around it stay whole; whitespace is collapsed before chunks are sized. Token ids equal the reference `sentencepiece` library's. Cures the garbling and the cut after a paragraph break. | Issue [#931](https://github.com/FluidInference/FluidAudio/issues/931), PR [#932](https://github.com/FluidInference/FluidAudio/pull/932) |
| `0002` cut placement | Unavoidable cuts land at dashes, ellipses and bracket edges as well as `, ; :`; a clause with no punctuation is split evenly; `...` and `?!` reach the model as written. | Issue [#934](https://github.com/FluidInference/FluidAudio/issues/934), PR [#935](https://github.com/FluidInference/FluidAudio/pull/935), stacked on #932 |
| `0003` whole sentences | A sentence over 50 tokens stays whole when it fits the cache, budgeting 4 cache slots of audio per token (75 tokens for a 125-frame voice); generation stops at the last cache slot. Chunks then match mlx-audio's. Local only: it rests on an assumed speaking rate, which a larger cache would make unnecessary. | Evidence in the larger-cache request, [#933](https://github.com/FluidInference/FluidAudio/issues/933); not proposed |

**A caution on `0003`.** Kyutai's original Python implementation of Pocket-TTS also holds chunks to 50 tokens, cuts an oversized sentence at `, ; :` "to prevent skipped words", and logs that a chunk still over the limit "may skip words". That is a property of the model, separate from the cache. No skipped words were heard in seven sentences of 52 to 70 tokens, through mlx-audio or through `0003`; that is a small sample. If the voice loop ever drops words from a long sentence, suspect `0003` first.

By ear, on cloned voices: `0001` removes the garbling and the mid-phrase pause; `0003` makes the result as good as mlx-audio; `0002` matters only for sentences `0003` still has to cut.

## When the patches can go

All together, never one at a time. The pin stays on the fork until an upstream release carries the equivalent of all three, then moves to that release with no patches left. Moving to a newer upstream while re-applying the patches still outstanding is not done: it means maintaining patches against a moving base. Upstream #938 covers `0003`; `0001` and `0002` wait on PRs #932 and #935.

When that release exists, check it by ear before trusting it:

```
fluidaudiocli tts --backend pocket --text "The control plane on the Pi (which also serves the dashboard) polls the shard every fifteen minutes." -o check.wav
```

Garbled fragments mean `0001` is still needed. A pause before the last words of a 60-token sentence means the cutting is still there. If upstream ships a 1024-slot cache, `0003` should give way to the reference rule with no assumed rate.

## Checking without listening

`verification/` holds what is needed to re-prove any of this on a FluidAudio checkout.

- `PocketTtsChunkProbeTests.swift` prints what the model is given, chunk by chunk, for `passage-1.txt` and `passage-2.txt`, with the model's real tokenizer. Copy it into `Tests/FluidAudioTests/TTS/PocketTTS/`, run `POCKET_PROBE_DIR=<this directory> swift test --filter PocketTtsChunkProbeTests`, then delete it. A chunk flagged `PER-CHARACTER` has as many tokens as characters and will be spoken as garble; unpatched upstream flags three chunks of passage 2, and any build with `0001` flags none. The probe calls the chunker directly, so it shows 50-token chunking even on a build with `0003`, whose whole-sentence limit is passed in by the synthesizer.
- `tokenizer_parity.py` prints the token ids Google's `sentencepiece` gives for each line of `tokenizer-parity-input.txt`. With `0001`, FluidAudio's ids are identical.
- Passage 1 is the `extended` text of the TTS benchmark; its third sentence follows a paragraph break. Passage 2 has a bracketed aside, an ellipsis, a spaced hyphen, and one sentence with no punctuation.

Never use a `fluidaudiocli` binary from a shared working clone as the "before": build the baseline in its own worktree from a named revision.

## Where the rest lives

- Investigation, measurements, and the state of the upstream filings: the vault note below, and issues #931/#933/#934 with PRs #932 and #935.
- Listening samples and the issue drafts: `$WORKSPACE/system/projects/benchmarks/voice/tts/pocket-tts-chunking.md`.
- The same commits on the fork `arvindvenkataramani/FluidAudio`, as `fix/pocket-tts-tokenizer-unknown-characters`, `feat/pocket-tts-cut-placement` and `local/pocket-tts-whole-sentences`.
