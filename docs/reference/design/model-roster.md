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

**Ownership** — providers, the models each serves, the parameters a server needs to instantiate one, the voices those models render, and the recordings those voices are built from. Every one is machine-local: a reference path is true only on the machine holding the file, and a model exists only where its weights are.

**Why node-local.** Declaring a filesystem path anywhere else asserts something the declaring node cannot check, and turns a hardware change into an edit on a machine that was not involved. A node declares what it can verify.

**Why the registry.** The registry already describes what runs on a node, and every roster entry refers to a service by its registry id. `config.json` holds settings and nothing that describes the system, so it cannot hold definitions. The roster sits in its own section beside `services` rather than inside the service entries, which stay short: an entry says a service runs here, and the roster says what it serves.

**Relationships** — validated at load against the services in the same file, so a provider naming no service fails before anything starts. Every node builds one, the control plane included, and exposes it to the assembler.

### The assembler

**Role** — merges the node rosters into one, the way the registry is already merged.

**Ownership** — nothing beyond its own node's roster. It holds no definitions for remote nodes.

**Key logic** — polls each node alongside the service poll it already runs, tags each provider with its host and whether that host is answering, and serves the union. An unreachable node keeps its last known roster, with its providers flagged unreachable — the same treatment the service poller already gives a shard that stops answering, and for the same reason: a node being down is not evidence its models ceased to exist.

Voices merge by id. The same person offered on two machines is one voice with the model links from both, and each link keeps the recordings of the node that declared it, since a reference path means nothing on another machine. Model ids do not merge: a selection names a model by id alone, so an id declared on two nodes would leave one of them unreachable. The assembler leaves such a model out on both nodes and names the collision, because a silent winner is the failure this design exists to remove.

**Relationships** — the control plane plays this role and also builds a node roster of its own from its own registry, exactly as it owns a registry and merges the shard's services into it. The two roles are fused in one process; separating them is a larger refactor that this design neither requires nor blocks.

### Consumers

**Role** — choose from the roster. They hold selections, never definitions.

**Ownership** — which model and voice are selected, and tuning that belongs to a use rather than to a model: chunk strategy, VAD thresholds, turn-taking curves.

**Relationships** — read the assembled roster; write selections that reference roster ids.

### Servers Banter builds

**Role** — instantiate what they are given.

**Ownership** — the mapping from a manager name and its parameters to a live manager. That is the irreducible code.

**Key logic** — told where the node's registry is and which provider it is, such a server never enumerates. Its listing endpoint reports exactly what that provider declares, annotated with what only it knows. An id it cannot map to a manager is a startup failure naming the id.

**It reads the roster section of the node's registry directly**, rather than being handed its models or given a file of its own. Both alternatives create a second place a model id must be written correctly, and nothing notices when the two disagree — which is the defect this design exists to remove, relocated. What the direct read costs is one lookup: find this provider, take its models, ignore the rest.

**The path and the provider are arguments, not environment.** Both are declared in the service's registry entry beside its port, so they are readable without running anything and identical however the process is started. An environment variable is invisible after the fact, scoped to whoever spawned the process, and absent when a supervisor restarts a service itself.

A running server logs the path and provider it loaded, so what it offers is always attributable to a file that can be opened. It reads its section once, at startup. A reload that changes a provider's section leaves the running server as it was, and the reload says which services need restarting; finding and restarting them automatically would mean walking the dependency tree for an edit that almost never happens.

Third-party servers receive nothing and are not asked to. For those, the roster is the control plane's claim about what the service will accept; a wrong id fails at the request. The annotations below apply only where Banter controls the server.

---

## What a roster contains

### Providers

Keyed by registry service id. The key being a service id is what makes availability checkable rather than asserted: a provider naming no registered service is a load error. The service's registry entry supplies its host and port, so the roster stores neither.

A service absent from the roster is a service the control plane will not route to. That is the mechanism working, and it is how a deprecated or unwanted service is excluded — by omission, needing no code change and no freeze.

### Models

A model has an identity — this model, these weights — and declares what it is capable of and what it accepts. It does not name a Swift class, a loader, or a directory. Which class serves a request is the server's business, and a roster that named one would be describing the runtime again.

For ASR a model declares its kind: batch, streaming, or both. For TTS it declares what synthesis requires, including whether it can clone and what it demands of a recording, the preset voices it knows by name, whether it is fast enough for the realtime voice loop (`realtime`), and whether its runtime can stream its audio (`streaming`). The voice loop's defaults for a model — how to split text (`chunking`), how many requests to send at once (`concurrency`), and fields every request carries (`requestParams`) — are declared on the model too. A model's capability — speech-to-text or text-to-speech — comes from its provider's registry entry, and decides which fields are required.

**The key is the runtime's, not Banter's.** A model entry carries the identifier each provider's runtime uses to reach it. `pocket-tts` under the FluidAudio server and `mlx-community/pocket-tts` under mlx-audio are one model reached by two runtimes that address it differently — the same relation a voice has to a model that offers her under its own name. What files a key resolves to, in which cache root, under whose conventions, is the runtime's business and the roster does not model it. FluidAudio backends read FluidAudio's cache roots; other runtimes read theirs.

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

A voice is a conceptual identity: a person, with a name. It is not a property of any model, because several may render her, and it is not a recording, because there may be several.

Each voice carries the recordings it was built from and the models that provide it. A recording states what it is — its file, its transcript where one exists, its duration and sample rate. A model entry states how that model reaches this voice: by naming the model's own built-in identifier for her, or by cloning from one of her recordings.

```
voice: example
  name: Example
  references:
    - audio, transcript, duration, sample rate
    - audio, duration, sample rate          (a shorter cut, no transcript)
  models:
    - model: Kokoro       key: af_heart    (the model's own name for her)
    - model: pocket-tts   key: clone        (use a reference below)

model: pocket-tts
  cloning: available, maximum length, transcript required or not
```

**Why one shape for both.** A model may have a voice baked in, or may clone her from a recording, and the same voice can be available both ways. Treating preset and clone as two kinds of entry would make that case unrepresentable.

### Compatibility is derived

Models differ in what cloning demands: a transcript or not, a maximum length, a sample rate. Those demands belong to the model. What a recording *is* belongs to the recording. Whether a model can use a recording is arithmetic over the two, computed at load rather than written down.

What is derived is whether a pairing works, not whether it exists. A voice still names the models that offer her, because that is a decision someone makes — this person is available on that model. What nobody writes down is the compatibility arithmetic: a clone entry whose voice has no recording satisfying that model's requirements fails at load, naming both sides. The failure that matters is the silent one, and this is what makes it loud.

Recording facts are declared, not probed. Voices change rarely; a filesystem read on every load buys protection against an edit that almost never happens, and a stale duration produces audio that sounds wrong — loud enough at this frequency.

### Selection belongs to the consumer

The roster states what exists and what each model can take. Which recording to use when several qualify, and which model when several provide a voice, are decisions — and decisions live with whoever is making the request. The control plane's `config.json` holds only those decisions and the settings a dialog edits; it declares no provider, model or voice.

The roster names no default voice. A default is a selection, which the control plane resolves from its configuration and always sends to the shard. A dispatch naming no voice is refused.

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

Each check kills a failure that has occurred.

**A provider must name a registered service.** Otherwise the roster advertises something with nowhere to route.

**Required fields follow capability**, read from the provider's registry entry, so a model missing what its kind requires fails at startup naming the model.

**Every reference resolves.** A voice claiming clone access to a model that cannot clone, or a clone entry with no recording satisfying that model's requirements. Each is an error naming both sides.

**A synthesis model id is unique across providers.** Definitions are served keyed by model id alone, so a second provider reusing an id would make one of the two unreachable. A node checks this within its registry at load; the assembler checks it across nodes, where it can only exclude and report.

**A fact appears once.** A recording path, a model id, a requirement — one place. The failure being designed out is silence: a mapping edited in one file and not the other produces no error and no symptom until something sounds wrong.

---

## Consequences

**A picker needs the node reachable.** Reading the roster from the API replaces lists compiled into the dashboard. Those work offline with stale options; the roster does not. This is correct — a model on an unreachable node cannot be loaded — but it is a behaviour change, and the roster carries reachability so a picker can show a model as declared-but-unreachable rather than dropping it.

**One voice, several instances.** A voice rendered as a preset by one model and cloned by another will sound like different people. The roster represents this faithfully, so a consumer chooses an instance, not only a voice.

**The assembly generalises.** A node brings its own definitions and the assembler merges one more set. If everything later collapses onto one machine, that machine's roster is the whole roster and the merge is a no-op. Neither case is a migration.

---

## Left to the spec

How a parameter mapped to no variant reaches the model: fixed at load, or supplied per session over the socket. No model declares one yet, and the answer depends on what the first one needs.
