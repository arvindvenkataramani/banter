# Fluid speech servers

`fluid-stt` and `fluid-tts` are speech servers for a Mac: one for transcription and one for speech. Both are built from this Swift package on [FluidAudio](https://github.com/FluidInference/FluidAudio), which runs speech models through CoreML on Apple Silicon. They are an Apple Silicon option beside the Python adapters, not part of the example registry: `registry.fluid.example.json` in this folder holds their registry entries, and [Registering them](#registering-them) shows how to merge it into yours.

## What they're for

Any server that meets the [speech server API](../../docs/reference/speech-server-api.md) works with Banter. These two are the ones built for its voice loop:

- **Your words appear as you speak.** `fluid-stt` streams transcription over a WebSocket, so text arrives mid-sentence instead of after a silent pause. That makes a slow or stalled system visible: text arriving means the microphone, network, server and model are all working. Streaming costs some accuracy. On benchmark speech, Parakeet Unified streaming scored 0.051 WER against 0.033 in batch.
- **Replies start speaking quickly.** With Pocket TTS, `fluid-tts` streams audio as it's generated. How long first audio takes does not depend on the reply's length: it's about 0.3 s with a short streaming interval, where a batch server took 0.7 s for a short line and 9 s for a long one.
- **Light on the network.** Audio goes up as Opus and comes back as AAC, about a twelfth the size of WAV. That matters for a phone on a mobile connection.
- **Memory comes back.** Each server holds one model at a time and releases it on switch or unload. That suits a control plane that starts and stops services by their `lifecycle` settings. mlx-audio, by contrast, keeps every model it has loaded.
- **Nothing to install around them.** Each is a single native app bundle: no Python environment, no model server.
- **Deepgram clients work too.** `fluid-stt` answers Deepgram's `/listen`, batch and streaming, so a meeting or dictation app with a custom Deepgram endpoint can use it. See [DEVELOPING.md](DEVELOPING.md#deepgram-compatible-listen) for what it supports.

The trade-offs:

- Apple Silicon and macOS 15 or later only. For Linux, see [Speech servers on Linux](../../docs/guide/speech-servers.md#linux); `stt/faster-whisper` and `tts/kokoro` in this repo run there.
- One model is resident at a time, and switching models takes around thirteen seconds.
- A model needs code in the server before the roster can offer it; the roster only chooses among models the server already supports.

## What they can do

`fluid-stt`:

| Model | Kind | Notes |
|---|---|---|
| `parakeet-tdt-v3` | batch | 25 European languages |
| `parakeet-unified-0.6b` | batch and streaming | One model with two modes; `registry.fluid.example.json` sets it as the provider's `defaultModel` |
| `nemotron-streaming-en-0.6b` | streaming | English. Chunk sizes of 560, 1120 or 2240 ms trade update frequency for per-call overhead |

`fluid-tts`:

| Model | Notes |
|---|---|
| `pocket-tts` | Streams. Voices come from a few seconds of reference audio, and it has eight preset voices |
| `kokoro-82m` | 28 preset voices, runs on the Neural Engine. The same model id as a Python Kokoro server serves; `fluid-tts` addresses it by the key `kokoro-ane` |
| `luxtts` | Voices from reference audio of at most 5 s with a transcript. It ships with no voice: add one with a recording, as in [Voices from reference audio](#voices-from-reference-audio) |

Which models each server offers comes from the `roster` section of the registry, not from the command line. [voices-and-models.md](../../docs/guide/voices-and-models.md) covers choosing a default, adding voices, and the roster in general; [Voices from reference audio](#voices-from-reference-audio) below covers cloning.

Model weights are not bundled. The first load of each model downloads it into `~/Library/Application Support/FluidAudio/Models/`, so that load is slow and needs a network connection.

## Registering them

The entries for both servers are in `registry.fluid.example.json`: two `services`, the models they serve (`ttsModels`, `sttModels`), two `roster.providers` (`fluid-stt` and `fluid-tts`), and `roster.voices`. The voices are the same ones as the example registry's (`alloy`, `heart` and so on), plus British Kokoro voices and eight Pocket-TTS presets (`alba`, `marius`, `javert`, `jean`, `fantine`, `cosette`, `eponine`, `azelma`). It merges into your registry by union on id: its `services` are appended, its providers are added, and a model or voice is added only if its id is not already declared. A voice you already have, such as `alloy` with its `kokoro-82m` preset rendering, is not replaced, and it is served by `fluid-tts` without an edit, because `fluid-tts` serves `kokoro-82m` and a voice is available on every runtime that serves a model rendering her.

Set each service's `hostId` to a host in your registry while merging. Run the merge once: a second run leaves the roster as it is but appends the `services` again. On a single machine, with the live registry at `~/services/banter/registry.json`, from the repo root:

```bash
jq --slurpfile f services/fluid/registry.fluid.example.json --arg host this-machine --arg home "$HOME" '
  def fresh($have): map(select(.id as $i | $have | index($i) | not));
  ((.roster.ttsModels // []) + (.roster.sttModels // []) | map(.id)) as $models
  | ((.roster.voices // []) | map(.id)) as $voices
  | .services += ($f[0].services | map(.hostId = $host
      | .ops.env.workingDirectory |= (if startswith("~/") then $home + .[1:] else . end)))
  | .roster.providers += $f[0].roster.providers
  | .roster.ttsModels += ($f[0].roster.ttsModels | fresh($models))
  | .roster.sttModels += ($f[0].roster.sttModels | fresh($models))
  | .roster.voices += ($f[0].roster.voices | fresh($voices))' \
  ~/services/banter/registry.json > registry.merged.json \
  && mv registry.merged.json ~/services/banter/registry.json
```

Replace `this-machine` with your host's id. The command adds a model or voice only when its id is not already declared in the registry (model ids are shared between synthesis and speech-to-text), and it also expands the leading `~/` in each `ops.env.workingDirectory` to your home directory, since nothing downstream expands it. On a shard, merge into the shard's own registry and use its host id; keep each fluid entry on the one node that runs it, since a model or voice id declared on two nodes is dropped from both (see [Two nodes, one model id](../../docs/guide/voices-and-models.md#two-nodes-one-model-id)).

Then set `FLUID_CORS_ORIGINS` on both entries to the origins you open the dashboard from. The file carries `http://localhost:4200,http://localhost:5173`; `ops/install.sh` fills `*_CORS_ORIGINS` only in a fresh registry it seeds, so entries merged afterwards keep what the file says. Point `config.json`'s `voice.stt` and `voice.tts.selection` at the fluid services and models to use them, and reload ([Applying an edit](../../docs/guide/voices-and-models.md#applying-an-edit)).

## Install

1. **Prerequisites.** macOS 15 or later on Apple Silicon, a Swift 6 toolchain (`xcode-select --install`, or Xcode 16), and `brew install opus`.
2. **Build:** `scripts/fluid-build.sh`. It checks the prerequisites first and names anything missing with the command to install it. The servers land in `services/fluid/.build/release/` as `fluid-stt.app` and `fluid-tts.app`. `ops/install.sh` does not build them.
3. **Install:** `ops/control-install-services.sh` on a single machine, or `ops/shard-install-services.sh` on a [shard](../../docs/guide/shard.md). Each copies the app bundles to `~/services/fluid/fluid-stt/` and `~/services/fluid/fluid-tts/`, as each registry entry's `ops.install` declares. A full `ops/control-deploy.sh` does the same. A server that is running is stopped for the swap and started again, and a bundle that hasn't changed is left alone.

After a code change, run the same two scripts again.

Each bundle carries everything its server needs to run: the build copies every FluidAudio resource bundle (`FluidAudio_*.bundle`, which holds the pronunciation data LuxTTS reads) into each app. Once installed, the checkout you built from can go.

FluidAudio is pinned to exactly one upstream release, 0.18.4, of [FluidInference/FluidAudio](https://github.com/FluidInference/FluidAudio); `swift build` fetches it. [verification/README.md](verification/README.md) says what to check before changing the version, and `scripts/fluid-smoke.sh [stt|tts]` runs the checks it starts with, with the network denied.

## Running them

When the registry's `lifecycle` has the control plane start a server (at boot or on first use), it uses the `runner.main` line in its registry entry:

```
fluid-stt.app/Contents/MacOS/fluid-stt --port {port} --registry {registry} --provider fluid-stt
fluid-tts.app/Contents/MacOS/fluid-tts --port {port} --registry {registry} --provider fluid-tts
```

- `--registry` and `--provider` are required: the server reads what that provider serves from the registry's `roster` section, and refuses to start if it can't find or validate them. `{registry}` is filled with the path of the registry the node loaded, so on a shard it is the shard's own `registry.json` at the top of its deployment folder.
- `--bind local` (the default) listens on `127.0.0.1` only, which is what Tailscale Serve proxies to. `--bind all` listens on every interface over plain HTTP.
- `FLUID_CORS_ORIGINS` (comma-separated origins) must include the dashboard's origin, since the browser calls these servers directly. Unset, the servers send no CORS headers. See [Registering them](#registering-them) for how it is set.
- Health is `GET /healthz`.

Each server starts with no model loaded. The dashboard loads the configured model when a voice session starts. `fluid-stt` also loads one on the first request that needs it, the requested model or the roster's `defaultModel`, and releases it after `idleUnloadMs` without work (30 minutes by default).

## Voices from reference audio

`pocket-tts` and `luxtts` clone a voice from a recording. The voice declares the recording under `recordings`, and a rendering with the method `clone` on each model that should use it. A clone rendering carries no key:

```json
{
  "id": "custom-voice",
  "name": "Custom Voice",
  "recordings": [
    {
      "audio": "/Users/alex/services/fluid/refs/custom-voice.wav",
      "text": "/Users/alex/services/fluid/refs/custom-voice.txt",
      "durationS": 4.6,
      "sampleRate": 24000
    }
  ],
  "renderings": [
    { "model": "pocket-tts", "method": "clone" },
    { "model": "luxtts", "method": "clone" }
  ]
}
```

`audio` and `text` are absolute paths, to the audio and to a file holding its transcript, on the machine that declares the voice. `fluid-tts` also expands a leading `~`. `durationS` and `sampleRate` are declared facts about the recording, not probed from the file at load. Every recording names a transcript file, but only a model whose `cloning.requiresText` is true is sent it: `luxtts` is, and it accepts recordings of at most 5 s (`cloning.maxDurationS`), while `pocket-tts` has neither limit, so a recording used for `luxtts` must be 5 s or shorter. A clone rendering whose voice has no recording its model accepts fails at load, naming both. When a voice has several recordings, the first the model accepts, in declared order, is used.

A voice can mix a preset rendering on one model and a clone rendering on another, so the same voice sounds different depending on which model speaks it: `heart` is a Kokoro preset and can also be cloned by `pocket-tts`. `fluid-tts` reads the registry itself (`resolvesVoices` is `true`), so it refuses a voice that is not declared. A change to a voice takes effect when `fluid-tts` is restarted. [voices-and-models.md](../../docs/guide/voices-and-models.md#adding-a-voice-with-reference-audio) covers the general rules.

## More

- [docs/reference/speech-server-api.md](../../docs/reference/speech-server-api.md): the routes and streaming protocol these servers answer.
- [DEVELOPING.md](DEVELOPING.md): how the package is built, the source layout, and fluid-specific API behaviour.
