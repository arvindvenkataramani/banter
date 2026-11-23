# Model roster — how availability is declared

## Why one declaration

A server's model list, the shard's voice entries, the control plane's config and the dashboard's own lists can each assert what the system can do. When several places assert it and none verifies it, they drift: a model is listed that has no weights on disk, a voice exists in one list and not another, and a preset and a cloning reference for the same person live under different names in different files. A list in a Swift array is also a fact about one installation that costs a rebuild to change, and a list of model ids tends to describe the shape of the library's code (one model listed twice because two classes load it, or once per chunk size) rather than models as someone choosing one would identify them.

Moving a list from Swift to JSON would move the assertion without checking it. What is needed is a declaration that describes models as someone choosing one would identify them, can be validated, and is held where the validation is possible. That declaration is the roster.

---

## The distinctions that follow

**Model support is code. Model availability is config.** A server knows how to instantiate three kinds of ASR manager; a JSON file cannot name a Swift class. Which models this installation offers, on which service, is data.

**Definition versus consumption.** A definition surface introduces a thing and owns its properties; it is the only place the thing comes into existence. A consumption surface names a thing that already exists, holding its id and whatever is true about *this use*. The test is whether a key can be validated against something else: if it can, it consumes, and what it validates against defines. A key naming a voice consumes. A key carrying that voice's reference path defines.

**Production versus specification.** A definition lives with whoever produces the thing — the node that runs the model and holds the recording, and can therefore verify what it declares. A consumer specifies which one it wants and needs no such access.

---

## Roles

### The node roster

**Role** — the definition surface. One per node, declaring what that node can produce. There is no roster file: each node builds its roster from the `roster` section of its own `registry.json`.

**Ownership** — the models on this node, the providers that serve them, the curated voices and how each model renders them, and the recordings clones are made from. Every one is machine-local: a recording path is true only on the machine holding the file, and a model exists only where its weights are.

**Why node-local.** Declaring a filesystem path anywhere else asserts something the declaring node cannot check, and turns a hardware change into an edit on a machine that was not involved. A node declares what it can verify.

**Why the registry.** The registry already describes what runs on a node, and every roster entry refers to a service by its registry id. `config.json` holds settings and nothing that describes the system, so it cannot hold definitions. The roster sits in its own section beside `services` rather than inside the service entries, which stay short: an entry says a service runs here, and the roster says what it serves.

**Relationships** — validated at load against the services in the same file, so a provider naming no service fails before anything starts. Every node builds one, the control plane included, and exposes it to the assembler.

### The assembler

**Role** — merges the node rosters into one, the way the registry is already merged.

**Ownership** — nothing beyond its own node's roster. It holds no definitions for remote nodes.

**Key logic** — polls each node alongside the service poll it already runs, tags each provider with its host and whether that host is answering, and serves the union. An unreachable node keeps its last known roster, with its providers flagged unreachable — the same treatment the service poller already gives a shard that stops answering, and for the same reason: a node being down is not evidence its models ceased to exist.

A model or voice id declared on two nodes is a collision. The assembler leaves it out on both nodes and names the collision, because a silent winner is the failure this design exists to remove. Recordings stay with the node that declared them, since a recording path means nothing on another machine.

**Relationships** — the control plane plays this role and also builds a node roster of its own from its own registry, exactly as it owns a registry and merges the shard's services into it. The two roles are fused in one process; separating them is a larger refactor that this design neither requires nor blocks.

### Consumers

**Role** — choose from the roster. They hold selections, never definitions.

**Ownership** — which model and voice are selected, and tuning that belongs to a use rather than to a model: chunk strategy, VAD thresholds, turn-taking curves.

**Relationships** — read the assembled roster; write selections that reference roster ids. A request names a voice id, a model id and a runtime. It never carries a recording path, a transcript or a runtime's own name for a voice or model.

### Servers Banter builds

**Role** — instantiate what they are given.

**Ownership** — the mapping from a manager name and its parameters to a live manager, and, for a synthesis server, turning a voice id into what its model needs. That is the irreducible code.

**Key logic** — told where the node's registry is and which provider it is, such a server never enumerates. Its listing endpoint reports exactly what that provider declares, annotated with what only it knows. An id it cannot map to a manager is a startup failure naming the id.

**It reads the roster section of the node's registry directly**, rather than being handed its models or given a file of its own. Both alternatives create a second place a model id must be written correctly, and nothing notices when the two disagree — which is the defect this design exists to remove, relocated. What the direct read costs is one lookup: find this provider, take its models, ignore the rest.

**The path and the provider are arguments, not environment.** Both are declared in the service's registry entry beside its port, so they are readable without running anything and identical however the process is started. An environment variable is invisible after the fact, scoped to whoever spawned the process, and absent when a supervisor restarts a service itself.

A running server logs the path and provider it loaded, so what it offers is always attributable to a file that can be opened. It reads its section once, at startup. A reload that changes a provider's section leaves the running server as it was, and the reload says which services need restarting; finding and restarting them automatically would mean walking the dependency tree for an edit that almost never happens.

Third-party servers receive nothing and are not asked to. For those, the roster is the control plane's claim about what the service will accept; a wrong id fails at the request. The annotations below apply only where Banter controls the server.

### The shard, for runtimes that cannot read the registry

**Role** — resolves voices on behalf of a runtime on its own machine that cannot read the registry.

**Key logic** — the shard answers a resolution: given a voice, a model and such a runtime, it applies the voice resolution rule and returns what the runtime needs. The caller then sends its request to the runtime directly; the shard does not carry the traffic. The shard is the nearest Banter service to the runtime and holds the recordings, so the work stays on the machine where the definitions can be verified. No actor on another machine resolves a voice for anyone. A runtime on the control plane's own host has no shard beside it, and the control plane resolves for it from its own node roster, by the same rule: it is then the node holding the definitions.

**Relationships** — the shard is a resolver for these runtimes, not a proxy. A caller that skips the resolution and names a voice to such a runtime itself is outside Banter's guarantees, since nothing between it and the runtime can refuse an undeclared name.

---

## What a roster contains

Three entities and two relations, each declared in exactly one place.

| Thing | What it is | Declared in |
|---|---|---|
| **Model** | A set of weights, the same model whichever runtime serves it | `ttsModels`, `sttModels` |
| **Runtime** | A registered service that serves models | `providers`, keyed by service id |
| **Voice** | A person with a name, independent of any model | `voices` |
| **Serving** (model × runtime) | This runtime serves this model, and how | the runtime's `serves` |
| **Rendering** (voice × model) | This model produces this voice, and how | the voice's `renderings` |
| **Recording** | Audio of a voice, kept so models can clone her | the voice's `recordings` |

```
roster
  ttsModels   [ { id, name, cloning?: { requiresText, minDurationS?, maxDurationS?, sampleRate? }, chunkProfile?, chunking? } ]
  sttModels   [ { id, name, kind, params?, variants? } ]
  providers   service id → { resolvesVoices (tts), responseFormat?, sessions?, defaultModel?, idleUnloadMs?,
                             serves: [ { model, key, streaming?, realtime?, concurrency?, requestParams? } ] }
  voices      [ { id, name,
                  recordings?: [ { audio, text, durationS, sampleRate } ],
                  renderings:  [ { model, method: preset | clone, key? } ] } ]
```

`schemas/platform.schema.json` is the field-level contract.

**Every order of choosing is a traversal.** A reader inverts the two relations at load, giving four lookups: a voice's models, a model's voices, a runtime's models, a model's runtimes. Voice then model then runtime, runtime then model then voice, and every other order are compositions of those four. Nothing about a voice names a runtime: a voice is available on a runtime when some model renders her and that runtime serves that model.

### Providers

Keyed by registry service id. The key being a service id is what makes availability checkable rather than asserted: a provider naming no registered service is a load error. The service's registry entry supplies its name, host and port, so the roster stores none of them.

A service absent from the roster is a service the control plane will not route to. That is the mechanism working, and it is how a deprecated or unwanted service is excluded — by omission, needing no code change and no freeze.

A provider lists what it **serves**: each model it runs, by model id, with the runtime's own key for that model and the facts true of this runtime rather than of the weights. For synthesis those are whether it can stream the model's audio (`streaming`), whether it is fast enough for the realtime voice loop (`realtime`), how many requests it takes at once (`concurrency`), and fields every request carries, in this runtime's vocabulary (`requestParams`). An absent flag means no.

A synthesis provider states whether it **resolves voices itself** (`resolvesVoices`). A runtime that reads the registry does; any other has the shard resolve for it. The flag is declared rather than inferred from the runner command, so no actor has to parse a command line to decide where resolution happens.

**The key is the runtime's, not Banter's.** `pocket-tts` under the FluidAudio server and `mlx-community/pocket-tts` under mlx-audio are one model reached by two runtimes that address it differently. What files a key resolves to, in which cache root, under whose conventions, is the runtime's business and the roster does not model it.

### Models

A model has an identity — this model, these weights — independent of the runtime running it, and is declared once per node however many runtimes serve it. It does not name a Swift class, a loader, or a directory. Which class serves a request is the server's business, and a roster that named one would be describing the runtime again.

A synthesis model declares what cloning demands of a recording, if it can clone at all, and its chunker constraint (`chunkProfile`). A speech-to-text model declares its kind: batch, streaming, or both. These are facts about the model, taken from its documentation and measurements, not chosen per installation.

**Loading names a mode where there is a choice.** A model that does one thing needs no mode. A model capable of both is refused if asked to load without one — naming the model and the choices — rather than defaulting silently into the wrong latency. Both is a legitimate explicit choice. The refusal is what keeps a caller from discovering its mistake as unexplained latency instead of an error.

What the server then makes resident is the server's decision. It brings up what serving the request requires and nothing else: the unified model's two encoders are components, not a bundle, and a caller that asked for batch does not pay for the streaming encoder. Residency is a memory question, and it belongs where the memory budget and the idle evictor already are.

**Parameters and variants are declared separately, and the roster states where they meet.** A parameter is something a load accepts, with the values it may take. A variant is one set of weights under a model's id: Nemotron's three latency tiers are one model with three encoders, so loading it at 560 ms and then asking for 1120 ms asks for different weights under the same id. A variant may name the parameter values that select it. That mapping is the only coupling between the two, and it is data; a parameter that shapes no weights maps to no variant, and a variant that no parameter reaches is loaded by naming it.

```
model: nemotron-streaming-en-0.6b
  params:   chunkMs ∈ {560, 1120, 2240}
  variants: 560ms  ← chunkMs 560
            1120ms ← chunkMs 1120
            2240ms ← chunkMs 2240
```

Without the mapping, the server has to know per model which parameters change weights, and a load naming the resident id at another tier is taken as already satisfied while the old encoder stays up.

**A load resolves to one variant.** A request may name a variant, give parameter values, or both. A named variant is used as named; failing that, the variant whose mapping the parameters match; failing that, the model's single implicit variant. A named variant alongside parameters that map to a different one is an error naming both, since either silent winner would report a model as resident that is not. A model with several variants that a load leaves unresolved is refused, as an unnamed mode is.

**What is resident is an id and a variant.** Loading the resident pair does nothing. Another variant of the resident id replaces it as any other model would, and waits for live work as any load does. A parameter mapped to no variant never causes a reload.

Mode stays its own field. It picks which of a model's components come up over weights that do not change, which makes it a residency choice and leaves the model's identity alone.

### Voices

A voice is a person with a name, independent of any model. The voice list is curated: it holds the voices chosen for use on this node, not every voice the models could produce. A voice absent from the list does not exist to Banter, and a request for it is refused.

**A rendering** is a voice as produced by one model, and is declared on the voice. Its method is either:

- **preset** — the model was trained with her, and the rendering carries the model's own name for her (`key`);
- **clone** — the model imitates her from one of her recordings.

A voice may have both kinds, on different models. Heart is a Kokoro preset and can be cloned by Pocket-TTS and LuxTTS from her recordings. She sounds different on each, which is what a rendering represents: one voice, produced several ways.

```
voice: heart
  name: Heart
  recordings:
    - audio, transcript, 9.15 s, 24 kHz
    - audio, transcript, 4.9 s, 24 kHz
  renderings:
    - kokoro-82m   preset  key: af_heart
    - pocket-tts   clone
    - luxtts       clone

voice: eponine
  name: Eponine
  renderings:
    - pocket-tts   preset  key: eponine

model: luxtts
  cloning: transcript used, at most 5 s
```

**A rendering names a model, never a runtime.** Kokoro calls Heart `af_heart` under both its runtimes, and Pocket-TTS clones her under both. A rendering on one runtime only is not expressible, and nothing in Banter needs it.

**Renderings are declared, not derived.** A model that can clone and a voice with recordings do not make a rendering: a newly recorded voice is offered on no model until someone links her, and may be linked to some cloning models and not others. Which models produce which voices is curation.

**A voice has a readable id, whatever renders her.** The voice is `heart`; `af_heart` is only the model's key for her, and never leaves the resolver.

**A recording** states what it is: the path to its audio, the path to its transcript, its duration and its sample rate. Recordings exist only for cloning, so a voice rendered only as a preset has none. Whether a model is sent the transcript is the model's decision.

### Compatibility is derived

Models differ in what cloning demands: whether the transcript is used, a minimum or maximum length, a sample rate. Those demands belong to the model. What a recording *is* belongs to the recording. Whether a model can use a recording is arithmetic over the two, computed at load rather than written down. Length bounds are inclusive: a 5.0 s recording fits a 5 s limit.

What is derived is whether a clone works, not whether it is offered. A clone rendering whose voice has no recording satisfying that model fails at load, naming both sides. The failure that matters is the silent one, and this is what makes it loud.

Recording facts are declared, not probed. Voices change rarely; a filesystem read on every load buys protection against an edit that almost never happens, and a stale duration produces audio that sounds wrong — loud enough at this frequency.

### Resolving a voice

A resolver turns a voice id, a model id and a runtime into what the runtime needs.

```
resolve(voice, model, runtime):
  no such voice                          → refuse
  the runtime does not serve the model   → refuse
  the voice has no rendering on the model → refuse
  the first rendering on the model is
    preset → send the rendering's key
    clone  → send the first recording, in declared order, the model
             accepts, with its transcript only if the model uses one
  in every case the model is named by the serving's key, and the
  serving's requestParams go along
```

**Declared order is the preference.** Where more than one recording satisfies a model, the first listed is used, and the same holds for renderings. Reordering is how a preference is expressed.

**Nothing passes through.** Only values read from the roster reach a runtime. A forwarded unknown name is answered with the runtime's default voice and no error, or makes a library try to download one.

**A request that carries a recording has chosen it.** A benchmark may name an arbitrary recording file, and nothing is looked up. Only an actor that resolves accepts such a request.

**Who resolves.** The runtime, if it reads the registry; otherwise the node on the runtime's machine: the shard there, or the control plane for a runtime on its own host. No other actor resolves. `schemas/voice-resolution-cases.json` holds cases both resolvers are tested against, so the two cannot drift apart unnoticed. A runtime that read the registry at startup needs a restart to see a changed voice, and a reload names it.

### Selection belongs to the consumer

The roster states what exists. Which voice, model and runtime to use are decisions, and decisions live with whoever is making the request. The control plane's `config.json` holds only those decisions and the settings a dialog edits; it declares no provider, model or voice.

**A selection names all three: voice, model and runtime.** Since a model can be served by more than one runtime, a model id alone does not say where a request goes, and a selection that left the runtime out would leave the choice to whatever looked it up.

The roster names no default voice. The voice loop's selection in `config.json` is the only default, and a resolution naming no voice, model or runtime is refused.

---

## What the control plane serves

The control plane assembles the node rosters and serves them as they are declared: models, providers with what they serve, and voices with their renderings. It does not rebuild a tree in one order, provider then model then voice, because that bakes one way of choosing into every consumer; a picker builds whichever order it needs from the four lookups. Recordings stay on the node that declares them and are not served: no consumer upstream of a resolver needs a path.

`GET /api/voice` serves, under `tts`:

- `models`: each synthesis model, with its name, whether it can clone, and its chunking defaults.
- `providers`: each synthesis runtime, with its host, whether that host is answering, its name from the service entry, its response format, whether it takes sessions, and what it serves.
- `voices`: each voice, with its name and her renderings as model and method. A preset's key is not served; it is the resolver's.
- `selection`: the stored selection, voice, model and runtime, and `request`, below.

## Reaching a resolution

The control plane resolves a voice only for a runtime on its own host. When it serves the voice selection, on `GET /api/voice` and in the answer to a selection change, it asks the shard on the selection's runtime host to resolve the selection, or resolves it from its own roster when the runtime is on its own host, and serves the answer as `selection.request`: the fields the browser puts into a speech request, which it sends to the runtime unchanged. One resolution per selection, never one per utterance.

The shard answers `POST /api/voices/resolve` with a voice, a model and a runtime. For a runtime that resolves voices itself the answer is the roster's ids. For any other it is the runtime's key for the model, and either the preset's key or a recording's audio path, with the transcript's text when the model uses one, plus the serving's request parameters. A refusal names the voice and model. An unreachable shard leaves `request` absent, with the reason, and the voice loop reports that it cannot speak.

---

## What the built servers report

A server handed its model list reports that list, parameters and variants as declared, adding four things only it can know:

- **`kind`** — batch, streaming, or both. What the model is.
- **`transport`** — the set of routes it is reached over: the transcription endpoint, the socket, or both. A set rather than one value, because a model capable of both modes is genuinely reachable both ways.
- **`present`** — whether every component the model declares is on disk, in the cache root its own runtime reads.
- **`variant`** — for the resident model, which of its variants is loaded.

Kind and transport are reported separately although they correlate today. One describes the model, the other the route to it, and the API should not assert a coupling it does not guarantee.

**A load that has a choice to make must be told.** Loading a model that reports `both` without naming a mode is refused, as is a load that leaves the model's variant unresolved. The refusal names the model and its choices. Defaulting would hand a caller a latency it did not pick, and the symptom — voice that works but feels wrong — is far from the cause.

**A server with no roster is misconfigured, not empty.** Receiving nothing is a startup failure, not a server that offers nothing: an empty listing is indistinguishable from a healthy server whose models are all gone, and that ambiguity is what this design exists to remove. A roster naming a model the server cannot map to a manager is the same failure, named.

`present` is not availability. Availability is a fact the control plane knows — is there a registered service, does the roster list this model, can the assembler reach the node. Weights on disk is one input a server contributes, and it is what makes advertising a model whose weights were never downloaded impossible to restate.

A model capable of both is one entry reporting `kind: both`, not two entries. Which Swift class serves a request is the server's business, and a listing that shows two models where there is one describes the code rather than the model.

---

## Validation

Each check catches a fact that could be wrong or inconsistent.

**A provider must name a registered service.** Otherwise the roster advertises something with nowhere to route.

**Ids are unique.** Voice ids within the voices; model ids across synthesis and speech-to-text models. A duplicate would make a reference silently resolve to the wrong one.

**A serving names a declared model of the provider's capability.** Otherwise a runtime is routed a model that does not exist, or a synthesis runtime is asked to transcribe.

**A rendering names a declared synthesis model.** Otherwise a voice is offered on a model that is not there, found only at request time.

**A preset rendering has a key, and a clone rendering has none.** Otherwise a preset has no name to send, or a clone sends one.

**A clone rendering's model can clone, and the voice has a recording it accepts.** Otherwise a voice is offered and fails, or sounds wrong, on first use. The failure names the voice and the model.

**A synthesis provider states whether it resolves voices itself.** Otherwise nobody resolves, and a raw id reaches a library that tries to download it.

**A fact appears once.** A recording path, a model id, a requirement — one place. The failure being designed out is silence: a mapping edited in one place and not the other produces no error and no symptom until something sounds wrong.

Deliberately unchecked: that a preset key exists in the model, since the roster holds no list of every preset; that recording files exist, since recording facts are declared; and that every voice has a rendering or every model a serving, since an empty answer is a true one.

---

## Consequences

**A picker needs the node reachable.** The dashboard reads the roster from the API rather than compiling lists of its own, so it offers no stale options while a node is down; a model on an unreachable node cannot be loaded. The roster carries reachability so a picker can show a model as declared-but-unreachable rather than dropping it.

**A runtime that cannot resolve is protected only by its callers.** The shard resolves for it but does not stand in front of it, so a caller that names a voice directly can still reach an undeclared one. Every Banter caller asks the shard first.

**The assembly generalises.** A node brings its own definitions and the assembler merges one more set.

---

## Left to the spec

How a parameter mapped to no variant reaches the model: fixed at load, or supplied per session over the socket. No model declares one yet, and the answer depends on what the first one needs.
