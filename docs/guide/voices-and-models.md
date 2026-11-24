# Voices and models

How Banter's speech servers declare what they offer, and how to customise it. This is where you change the default voice, add or remove a voice, add a cloned voice built from a recording, or add another model or speech server.

For what every field means, see the Roster section of [docs/reference/components/registry.md](../reference/components/registry.md#roster). This page is about editing it.

Every edit below goes in your deployed `registry.json` (`~/services/banter/registry.json`, or wherever `BANTER_PROD` points), not the `.example.json` in the repo — see [Which files to edit](install.md#which-files-to-edit) for that distinction. A server hosted on a shard gets its roster entry in that shard's own registry instead.

---

## The pieces

Each node's registry declares a `roster`: what that node offers, and how config.json refers to it. Three things are declared, each once.

- **A model** is one set of weights, declared once per node in `ttsModels` or `sttModels` with an id and a display `name`, however many runtimes serve it. A TTS model that can clone declares a `cloning` block saying what it demands of a recording; a model with no `cloning` block cannot clone. Kokoro is one model, `kokoro-82m`, whichever speech server runs it.
- **A provider** is a speech server (a runtime), keyed by its registry service id. Its `serves` list names each model it runs by model id, with `key`, the runtime's own name for that model, which may differ from the id. A TTS provider also says whether it resolves voices itself (`resolvesVoices`). The audio format it returns, and how Banter calls it, are declared in its service entry's `provides`, not here.
- **A voice** is a person with a name, independent of any model. Its `renderings` say which models produce it and how: a `preset` rendering carries the model's own key for her (`af_heart`), and a `clone` rendering has no key and is made from one of the voice's `recordings`. A rendering names a model, never a runtime. A voice is available on a runtime when some model renders her and that runtime serves that model.

The example registry (`control/control-plane/data/registry.example.json`) declares a roster for its two speech servers, and this page uses it as the worked example: the TTS provider `tts-kokoro` serves one model, `kokoro-82m`, and the roster has 20 voices (`alloy`, `heart`, `sarah`, and so on), each with one preset rendering on it. The STT provider `stt-faster-whisper` serves one batch model, `faster-whisper`. Here is the TTS side, trimmed:

```json
"roster": {
  "ttsModels": [
    { "id": "kokoro-82m", "name": "Kokoro 82M" }
  ],
  "providers": {
    "tts-kokoro": {
      "resolvesVoices": false,
      "serves": [
        { "model": "kokoro-82m", "key": "kokoro-82m", "realtime": false, "streaming": false }
      ]
    }
  },
  "voices": [
    {
      "id": "heart",
      "name": "Heart",
      "renderings": [
        { "model": "kokoro-82m", "method": "preset", "key": "af_heart" }
      ]
    }
  ]
}
```

`resolvesVoices` says who turns the selected voice into what the runtime needs. `true` means the runtime reads the registry itself (the fluid servers, started with `--registry`). `false` means it does not, so the shard on its machine resolves for it. Set it to `false` for any server Banter did not build. `streaming` and `realtime` say whether this runtime can stream the model's audio and is fast enough for the realtime voice loop; absent means no.

`config.json`'s `voice.tts.selection` and `voice.stt` name roster ids only: a service id, a model id, and for TTS a voice id:

```json
"tts": {
  "selection": { "serviceId": "tts-kokoro", "model": "kokoro-82m", "voice": "heart", "speed": 1 }
}
```

The roster lives in the registry, not in `config.json`. `GET /api/voice` returns it assembled under `tts.models`, `tts.providers` (each with what it `serves`) and `tts.voices` (each with its renderings, without the preset keys), for Banter to read; nothing writes that back into config.json. It also returns `tts.selection.resolution`, which the browser's speech adapter encodes into a request to the runtime for the stored selection. The shard on the runtime's machine produces it through `POST /api/voices/resolve`, and when the selection cannot be resolved, `resolutionError` says why. A voice that is not declared in the roster does not exist: a selection naming it is refused rather than passed to the runtime.

Note also that a hand edit to `config.json` isn't checked against the roster the way Banter's own writes are — the control plane just parses the file at load and on reload. If you type a `voice` id that doesn't exist, or a voice with no rendering on the selected model, you won't find out until `GET /api/voice` reports a `resolutionError` for the selection.

---

## Changing the default voice

Edit `voice.tts.selection.voice` in `config.json` to another voice id. The voice needs a rendering on the selected `model`, and the selected `serviceId` has to serve that model:

```json
"selection": { "serviceId": "tts-kokoro", "model": "kokoro-82m", "voice": "sarah", "speed": 1 }
```

Reload for it to take effect (see [Applying an edit](#applying-an-edit) below) — this is a `config.json` change, not a roster change, so no restart is needed.

---

## Adding or removing a voice on an existing model

To make a voice available on a model, append to `roster.voices` in the registry. The example roster already declares 20 voices, so this is the entry for `nova` (the shape to use after removing one, or for another preset the model has):

```json
{
  "id": "nova",
  "name": "Nova",
  "renderings": [
    { "model": "kokoro-82m", "method": "preset", "key": "af_nova" }
  ]
}
```

`key` is the model's own name for the voice, the one its server expects. The registry does not check it against the model, since the roster holds no list of every preset a model has: a wrong key shows up when the voice is spoken, not at load. Give the voice a readable id of your own (`nova`), not the model's key.

A voice with several renderings uses the first listed that is on the selected model, so reordering them changes which one wins. One voice can have a preset rendering on one model and a clone rendering on another.

To remove a voice, delete its entry from `roster.voices`, and change any `voice.tts.selection` that names it.

A voice edit takes effect on a config reload alone when the runtime that speaks it does not read the registry itself (`resolvesVoices: false`), since the shard resolves from the registry it has loaded. A runtime that reads the registry reads it once, at startup, so it needs restarting; see below.

---

## Adding a voice with reference audio

Supported by models that declare `cloning`: a voice gets a `clone` rendering on the model, which has no key, and one or more `recordings` for the model to imitate her from:

```json
{
  "id": "custom-voice",
  "name": "Custom Voice",
  "recordings": [
    {
      "audio": "/home/alex/refs/custom-voice.wav",
      "text": "/home/alex/refs/custom-voice.txt",
      "durationS": 4.6,
      "sampleRate": 24000
    }
  ],
  "renderings": [
    { "model": "<model id>", "method": "clone" }
  ]
}
```

`audio` and `text` are absolute paths, on the machine that declares the voice, to the recording and to a file holding its transcript. `durationS` and `sampleRate` are declared facts about the recording, not probed from the file at load; if they are wrong, validation and rendering both trust the wrong numbers. Whether a model is sent the transcript is the model's decision (`cloning.requiresText`), but every recording names one.

The model must declare `cloning`, and at least one recording must satisfy what it demands: `requiresText`, `minDurationS` and `maxDurationS` (both inclusive), and `sampleRate`. Banter works out whether a recording suits a model; nothing is written down for it. A clone rendering on a voice with no recording the model accepts fails at load, naming both. A voice with a recording but no rendering is offered on no model: a recording alone links nothing, and which cloning models produce her is up to you. With several recordings, the first the model accepts, in declared order, is used. The example roster declares no cloning model. [`services/fluid`](../../services/fluid/README.md#voices-from-reference-audio) has a worked example with models that clone.

A voice can mix a preset rendering on one model and a clone rendering on another: the same voice, produced differently depending on which model speaks it.

---

## Adding another model or another speech server

**Another model on an existing provider:** declare it once in `ttsModels` or `sttModels`, then add it to that provider's `serves`. A TTS model needs `id` and `name`, and a `cloning` block if it can clone. An STT model needs `id`, `name`, and `kind` (`"batch"`, `"streaming"`, or `"both"`). The serving is `{ "model": "<model id>", "key": "<the runtime's name for it>" }`. If another provider on the same node already serves the model, add only the serving; the model is declared once. Model ids are unique across TTS and STT. A model has no voices of its own: it speaks the voices that have a rendering on it, so add renderings to voices (or new voices) to make a TTS model selectable.

**Another speech server:** it has to answer the routes in [speech-server-api.md](../reference/speech-server-api.md). Add a `services` entry for it — capability `tts` or `stt`, its own host, port and health path — the same as any other service (see [configuration.md](../reference/configuration.md#adding-a-service)). Then add a `roster.providers` entry keyed by that service's id, serving at least one model, and declare the model and a voice for it:

```json
"services": [
  {
    "id": "my-tts-server",
    "name": "My TTS Server",
    "capabilityId": "tts",
    "hostId": "box",
    "permissions": { "enabled": true, "protected": false },
    "runner": { "type": "external" },
    "network": { "port": 9000, "healthPath": "/health" }
  }
],
"roster": {
  "ttsModels": [
    { "id": "my-model", "name": "My Model" }
  ],
  "providers": {
    "my-tts-server": {
      "resolvesVoices": false,
      "serves": [
        { "model": "my-model", "key": "my-model" }
      ]
    }
  },
  "voices": [
    {
      "id": "voice-a",
      "name": "Voice A",
      "renderings": [
        { "model": "my-model", "method": "preset", "key": "voice-a" }
      ]
    }
  ]
}
```

A provider naming no registered service fails at load — the service entry has to exist first. A serving must name a declared model, and a TTS provider must state `resolvesVoices`. A model with no rendering on any voice can be selected by nothing. The audio format a speech server returns is stated on its service entry, as the `response_format` its `openai.audio.speech` provision accepts; see [tts.md](tts.md). A service a provider names must declare a `provides` for what it is called for, or the registry does not load.

If the voice is already declared (another model renders her), add a rendering to that voice instead of declaring her again; she is then available on the new model too.

For a server Banter didn't build, the roster is Banter's claim about what that server will accept — nothing here is checked against the server itself. A wrong serving `key` or rendering `key` fails at the request, not at load.

---

## Applying an edit

1. `POST /api/config/reload` on the control plane (this also re-reads the registry and, on a multi-node setup, reloads and re-polls every shard in one call).
2. If the response's `warnings` names a `provider-changed` warning for a service, restart that service: `POST /api/services/<id>/restart`, or `ops/service-control.sh restart <service>` as a backup path. A server that reads its roster section once, at startup (the fluid servers do), only sees a changed provider, a changed model it serves, or a changed voice (a new rendering, a new recording) after the restart.

A voice edit for a runtime the shard resolves for never triggers that warning and needs no restart — the shard resolves from the roster it has loaded, and the assembled voice list is rebuilt on every reload.

---

## Two nodes, one model id

A model id and a voice id must each be declared once per node, and the registry fails to load if a model id repeats across `ttsModels` and `sttModels` or a voice id repeats within `voices`. Across nodes it's softer but still enforced: if the control plane and a shard both declare a model or a voice with the same id, the assembler excludes that id from *both* nodes and reports the collision, rather than picking a silent winner. A voice excluded this way is offered on no model; a model excluded this way is offered by no provider.

This matters when you move a speech server from the control plane onto a shard. The two example registries declare the same speech services, model ids and voice ids (`tts-kokoro` with `kokoro-82m`, `stt-faster-whisper` with `faster-whisper`, and the same 20 voices), so a two-machine registry that keeps both copies collides. Keep each service, with its `roster.providers` entry, the models it serves and the voices only it renders, in the registry of the one node that runs it: remove them from the other. Otherwise every one of those ids collides with itself across the two nodes and disappears from both.
