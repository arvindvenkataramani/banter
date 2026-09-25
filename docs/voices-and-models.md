# Voices and models

How Banter's speech servers declare what they offer, and how to customise it. This is where you change the default voice, add or remove a voice on a model, add a voice built from reference audio, or add another model or speech server.

For what every field means, see the Roster section of [docs/components/registry.md](components/registry.md#roster). This page is about editing it.

Every edit below goes in your deployed `registry.json` (`~/services/banter/control/control-plane/data/registry.json`, or wherever `BANTER_PROD` points), not the `.example.json` in the repo — see the README's "Connect your speech servers" section for that distinction. A server hosted on a shard gets its roster entry in that shard's own registry instead.

---

## The pieces

Each speech server's registry declares a `roster`: what it offers, and how config.json refers to it.

- **A provider** is a speech server, keyed by its registry service id. It lists `ttsModels` and/or `sttModels`, and (for TTS) the `responseFormat` it returns.
- **A model** is one set of weights on that provider — an id, a display `name`, and the runtime's own `key` for it. A TTS model may list **preset voices**: names the model already knows, needing no recording.
- **A roster voice** maps a voice id onto one or more `{serviceId, model, key}` links — usually a preset key, or the special key `clone` to render from a reference recording.

`control/control-plane/data/registry.example.json` ships `fluid-tts` and `fluid-stt` as providers, with Kokoro's 28 English presets and 28 matching roster voices (`alloy`, `heart`, `sarah`, and so on — each just a thin wrapper naming a Kokoro preset). Here is one, trimmed:

```json
"roster": {
  "providers": {
    "fluid-tts": {
      "responseFormat": "aac",
      "ttsModels": [
        {
          "id": "kokoro-ane",
          "name": "Kokoro 82M (ANE)",
          "key": "kokoro-ane",
          "presetVoices": [
            { "id": "af_heart", "name": "Heart" },
            { "id": "af_alloy", "name": "Alloy" }
          ]
        }
      ]
    }
  },
  "voices": [
    {
      "id": "heart",
      "name": "Heart",
      "models": [
        { "serviceId": "fluid-tts", "model": "kokoro-ane", "key": "af_heart" }
      ]
    }
  ]
}
```

`config.json`'s `voice.tts.selection` and `voice.stt` name roster ids only — a service id, a model id, and (for TTS) a roster voice id or a preset id the roster doesn't wrap:

```json
"tts": {
  "selection": { "serviceId": "fluid-tts", "model": "kokoro-ane", "voice": "heart", "speed": 1 }
}
```

`voice.tts.providers` does not exist in config.json — the provider catalogue lives entirely in the registry's roster now. `GET /api/voice` returns the assembled roster under `tts.providers` for the dashboard to read; nothing writes that back into config.json.

One wrinkle worth knowing: a roster voice that claims a preset key suppresses that preset from appearing under its own id. `heart` claims `af_heart`, so `"voice": "heart"` is what works — `"voice": "af_heart"` is only selectable if no roster voice claims it. The dashboard's settings dialog handles this for you; if you're editing `config.json` by hand, use the roster voice id.

Note also that a hand edit to `config.json` isn't checked against the roster the way the dashboard's own writes are — the control plane just parses the file at load and on reload. If you type a `voice` id that doesn't exist, you won't find out until the app tries to use it.

---

## Changing the default voice

Edit `voice.tts.selection.voice` in `config.json` to another roster voice id (or a bare preset id nothing else claims):

```json
"selection": { "serviceId": "fluid-tts", "model": "kokoro-ane", "voice": "sarah", "speed": 1 }
```

Reload for it to take effect (see [Applying an edit](#applying-an-edit) below) — this is a `config.json` change, not a roster change, so no restart is needed.

---

## Adding or removing a voice on an existing model

To add another Kokoro preset as a roster voice, append to `roster.voices` in the registry:

```json
{
  "id": "nova",
  "name": "Nova",
  "models": [
    { "serviceId": "fluid-tts", "model": "kokoro-ane", "key": "af_nova" }
  ]
}
```

The key must be one of the model's `presetVoices` — the registry fails to load if it isn't.

To remove one, delete its entry from `roster.voices`. If you also want the underlying preset gone entirely (so it can't be selected under its own id either), delete its entry from the model's `presetVoices` too — but only after removing every roster voice that claims it, or the load fails with an error naming the voice and the preset it claims but the model no longer offers.

A `voices[]`-only edit (adding, renaming, or removing a roster voice against presets the model already declares) takes effect on a config reload alone, since the control plane assembles voices itself. Changing what a model or provider offers — a new preset, a new model — needs the provider restarted; see below.

---

## Adding a voice with reference audio

Supported: a roster voice's model link can use the key `clone` instead of a preset id, which tells the model to render from a reference recording rather than a name it already knows. Declare the recording under the voice's `references` array:

```json
{
  "id": "custom-voice",
  "name": "Custom Voice",
  "references": [
    { "audio": "~/services/fluid/refs/custom-voice.wav", "durationS": 8.2, "sampleRate": 24000 }
  ],
  "models": [
    { "serviceId": "fluid-tts", "model": "pocket-tts", "key": "clone" }
  ]
}
```

`audio` is a path the TTS server resolves on its own machine (fluid-tts expands a leading `~`). `durationS` and `sampleRate` are declared facts about the recording, not probed from the file at load — if they're wrong, validation and rendering both trust the wrong numbers. `text` is optional and only needed if the model requires a transcript.

The model must declare `cloning.available: true`, and at least one reference must meet what it requires — `cloning.requiresText`, `minDurationS`, `maxDurationS`, `sampleRate`. In the shipped roster, `pocket-tts` clones without requiring text; `luxtts` requires a transcript, so a reference used for it needs `text` set. A voice with no reference meeting its model's requirements fails at load, naming both.

A voice can mix a preset link on one model and a `clone` link on another — the same voice, rendered differently depending on which model speaks it.

---

## Adding another model or another speech server

**Another model on an existing provider:** append to that provider's `ttsModels` or `sttModels` in the registry. A TTS model needs `id`, `name`, `key`, and (if it can clone) a `cloning` block; preset voices go in `presetVoices`. An STT model needs `id`, `name`, `key`, and `kind` (`"batch"`, `"streaming"`, or `"both"`).

**Another speech server:** add a `services` entry for it — capability `tts` or `stt`, its own host, port and health path — the same as any other service (see [configuration.md](configuration.md#adding-a-service)). Then add a `roster.providers` entry keyed by that service's id, with at least one model:

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
  "providers": {
    "my-tts-server": {
      "responseFormat": "wav",
      "ttsModels": [
        {
          "id": "my-model",
          "name": "My Model",
          "key": "my-model",
          "presetVoices": [
            { "id": "voice-a", "name": "Voice A" }
          ]
        }
      ]
    }
  }
}
```

A provider naming no registered service fails at load — the service entry has to exist first. A model needs at least one `presetVoices` entry (or a roster voice claiming it via `clone`) or nothing can select it. `responseFormat` is the audio format `/v1/audio/speech` returns; absent means `mp3`, so set it explicitly if the server returns something else, or the dashboard decodes the wrong format. Give it its own roster voices in `roster.voices` too, the same way as any other provider.

For a server Banter didn't build, the roster is Banter's claim about what that server will accept — nothing here is checked against the server itself. A wrong model id or preset key fails at the request, not at load.

---

## Applying an edit

1. `POST /api/config/reload` on the control plane (this also re-reads the registry and, on a multi-node setup, reloads and re-polls every shard in one call).
2. If the response's `warnings` names a `provider-changed` warning for a service, restart that service: `POST /api/services/<id>/restart`, or `scripts/service-control.sh restart <service>` as a backup path. `fluid-stt` and `fluid-tts` read their roster section once, at startup, so a changed provider (a new model, a changed `presetVoices` list, and so on) only takes effect after the restart.

A `voices[]`-only change never triggers that warning and needs no restart — the assembled voice list is rebuilt on every reload.

---

## Two nodes, one model id

A TTS model id must be unique within a single registry — the registry fails to load if two providers in the same file declare the same id. Across nodes it's softer but still enforced: if the control plane and a shard both declare a model with the same id, the assembler excludes that id from *both* nodes' providers and reports the collision, rather than picking a silent winner. Voice ids merge instead of colliding — the same voice id on two nodes becomes one voice with links from both, using the first-seen name; if the names differ, that's reported too.

This matters when you move the fluid servers from the control plane onto a shard. The plane's shipped registry and the shard's shipped registry both declare `fluid-stt` and `fluid-tts` with the same model ids (`kokoro-ane`, `pocket-tts`, and so on), because both examples assume you're using whichever one actually runs them. If you set up a two-machine deployment with the shard running fluid, remove the `fluid-stt`/`fluid-tts` service entries *and* their `roster.providers`/`roster.voices` entries from the control plane's registry — otherwise every one of those model ids collides with itself across the two nodes and disappears from both.
