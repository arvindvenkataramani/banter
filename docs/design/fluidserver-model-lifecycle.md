# fluidserver model lifecycle

How `fluidserver` holds an ASR model, and how a caller changes which one is loaded.

Scope is the lifecycle only: one model resident, selected at runtime over HTTP. Streaming support is the next piece of work and shapes the abstraction here, but nothing streaming is wired up yet.

## Why this exists

The server loads one model, chosen by `--model-version` at launch, and holds it for the process lifetime. Benchmarking several models that way means several processes, several ports, and a registry entry each. Making the model a runtime value collapses that to one service.

The constraint that shapes everything below: FluidAudio issue #661 reports `EXC_BAD_ACCESS` in libBNNS when two managers predict concurrently, and upstream's `Architecture.md` states CoreML is not reentrant, relying on per-manager actor isolation. So: **one model resident at a time, and a load must never overlap a transcription.**

## Components

### Model catalogue

**Role.** Names the models the server can load, and what each needs in order to load.

**Ownership.** The id strings a caller uses, and the mapping from an id to the manager kind and settings behind it.

**Key logic.** Four ids resolve to the batch TDT stack, distinguished only by which weights they load. One resolves to Parakeet Unified in offline mode, which is a different manager type with its own loader. The catalogue is the only place that knows this difference; everything downstream sees a model id and a loaded model.

The catalogue also carries entries it cannot currently load — the two streaming managers — marked as such. A caller asking what exists gets the truth, and a caller trying to load one gets a specific refusal rather than an unknown-id error.

**Relationships.** Read by the resident-model actor when loading, and by the models endpoint when listing.

### Loaded model

**Role.** One live manager, plus the identity of what it is, behind a uniform transcribe call.

**Ownership.** Every reference to the underlying CoreML models. This is the whole point: `cleanup()` nils the manager's own references, but memory is released only when nothing else retains them. The current code holds the `AsrModels` value returned by the loader alongside the manager, which is a second reference to the same models. Concentrating every reference here means dropping this value drops the last one.

**Key logic.** Managers differ in ways callers should not see. The batch stack needs a fresh decoder state per transcription and reports a decoder layer count to size it. Unified takes a sample buffer and returns text with token timings directly. Its `cleanup()` is async; the batch one is sync and additionally clears a *shared* array cache via an unawaited task, so the clear is not complete when the call returns.

Unloading therefore has to do more than call `cleanup()`: call it, drop every reference, and settle before anyone measures memory. Treating `cleanup()` as a free is the mistake this component exists to prevent.

**Relationships.** Created by the catalogue, held by the resident-model actor, used by the transcription path.

### Resident model actor

**Role.** Holds at most one loaded model and serialises everything that touches it.

**Ownership.** Which model is loaded, and the exclusion between loading and transcribing.

**Key logic.** Actor isolation is the lock. A transcription and a load cannot interleave because both are actor-isolated calls on the same actor, so the reentrancy hazard cannot occur regardless of how many HTTP requests arrive at once.

Loading replaces: unload the current model first, then load the requested one. The order matters for memory — loading before unloading means both are resident at the peak, which is the thing we are trying not to do. It also means a failed load leaves the server with nothing loaded, which is the honest state; pretending the old model survived would be a lie the health endpoint then repeats.

A load of the already-loaded model is a no-op rather than an unload/reload cycle. The caller's intent is "be on this model," and honouring it literally would evict a warm model for no reason.

**Relationships.** Replaces the current transcription queue. The HTTP layer holds it; every route that touches a model goes through it.

### HTTP surface

**Role.** Exposes the catalogue and the resident model to callers.

**Key logic.** Listing reports every catalogue entry and which is loaded. Loading takes an id, performs the switch, and returns when the model is ready to serve — synchronously, because the caller's next action is a transcription and an async job id would just move the waiting.

Transcription optionally names a model. If it names one that is not loaded, the request fails rather than triggering a switch. A silent switch would make timing figures meaningless: the request that caused the load pays for it, and every figure from that run is contaminated. Refusing states the mismatch instead.

Health reports the loaded model id, which describes what the process is currently doing rather than how it was launched. The model is a runtime value, so no launch flag answers the question.

**Relationships.** Everything model-touching goes through the resident-model actor. Multipart parsing, temp-file handling, CORS and the word-timing merge are untouched — the harness depends on their output shape.

## Decisions where the obvious approach is wrong

**Not an `AsrModelVersion` case.** That enum covers the batch TDT stack only. Unified and the streaming managers are separate types with their own loaders, so the catalogue maps ids to manager kinds rather than extending an enum.

**`cleanup()` is not a free.** It nils references. Whether memory returns depends on nothing else holding them, and the batch manager's shared-cache clear is not awaited. Whether it actually frees is an open question this work is meant to answer, not assume — MLX-Audio does not free on model switch, which is why its memory reaches 28 GB.

**There is no `--model-version` flag.** The server starts holding nothing and loads only when asked, which is what the rest of the API already assumed: loading is always explicit, and `model` on a request asserts rather than selects. Which model a voice session wants is `voice.stt.model` in Banter's `config.json`, loaded by the session alongside the TTS model it already loads.

**Unload before load, not after.** Costs a reload if the new model fails, and avoids both being resident at once.

## Verification approach

There is no test target in this package: it declares one executable, and the server is not importable. Verification for this pass is a script against the running server rather than a unit suite — transcribe a known clip on v3 and diff transcript and word timings against the current build, then drive the load endpoint across a switch and capture memory at each stage.

That exercises real CoreML, which is where the risk in this pass lives and which a unit test cannot reach. Splitting the executable into a library plus a thin shell so tests can import it is a structural change to a working service, and does not belong in the same pass as a behavioural one. Revisit when streaming lands and there is logic worth unit-testing on its own.
