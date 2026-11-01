# Speech servers

How to connect speech-to-text (STT) and text-to-speech (TTS) servers to Banter: what the example registry gives you, installing a server, checking CORS, adding another server, and the fluid servers as an Apple Silicon option.

Speech is optional. Until a speech server is registered, voice does nothing and typing still works.

Banter installs no speech server and no Python packages. Each server has its own README that says how to install it, and the control plane then starts it as its registry entry says.

Registry and config edits go in the files in your *deployed* folder, not in the repo you cloned; see [Which files to edit](install.md#which-files-to-edit).

## The example registry

`scripts/install.sh` seeds your registry from the example registry. The example registry registers a faster-whisper STT server and a Kokoro TTS server as process runners, both demand-loaded: the control plane starts each on first use and stops it after it has been idle for `idleTimeout`. Keep, change or delete those entries. They are examples of how a speech server is registered, and the control plane starts without either.

To use them, install each on the machine that runs it from its folder's README:

- [`services/stt/faster-whisper/README.md`](../../services/stt/faster-whisper/README.md)
- [`services/tts/kokoro/README.md`](../../services/tts/kokoro/README.md)

Their entries say where they run from (`ops.env.workingDirectory`, `~/services/stt/faster-whisper` and `~/services/tts/kokoro`), and the control plane writes their output to a `logs/` folder there. Each README gives the exact copy, `logs/` and virtual-environment steps.

[`services/README.md`](../../services/README.md) lists every adapter this repo ships, with its routes and `runner.main` form. The setup pages give a registry snippet per server:

- [stt.md](stt.md): speech-to-text servers
- [tts.md](tts.md): text-to-speech servers
- [models.md](models.md): which models exist, what each needs, and which servers run them
- [linux-speech-servers.md](linux-speech-servers.md): servers known to run on Linux

Which models and voices a server offers is declared in the registry's `roster` section, not in `config.json`. [voices-and-models.md](voices-and-models.md) covers changing the voice a conversation uses, adding or removing a voice, and adding a model.

## CORS

The browser calls speech servers directly, so each server needs the dashboard's origin in its CORS allowlist. A missing origin is the usual reason a healthy-looking server fails: it answers `curl`, and the browser refuses it.

Every Python adapter in this repo reads a comma-separated allowlist from an environment variable, set under the service's `ops.env.variables`, and sends no CORS headers when it is unset:

| Server | Variable |
|---|---|
| `stt/faster-whisper` | `FASTER_WHISPER_CORS_ORIGINS` |
| `stt/whisper` | `WHISPER_CORS_ORIGINS` |
| `tts/kokoro` | `KOKORO_CORS_ORIGINS` |
| `tts/neutts-air` | `NEUTTS_CORS_ORIGINS` |
| `fluid-stt`, `fluid-tts` | `FLUID_CORS_ORIGINS` |

Other servers vary; check their own docs.

Check a server with:

```bash
curl -si -X OPTIONS http://YOUR-SERVER/v1/audio/speech \
  -H 'Origin: http://localhost:4200' \
  -H 'Access-Control-Request-Method: POST' | grep -i allow-origin
```

An `access-control-allow-origin` line back means the origin is allowed. Nothing back means the browser will refuse the server even though `curl` reaches it. Use the route the server answers: `/v1/audio/transcriptions` for an STT server, and use the dashboard's real origin.

When it seeds a fresh registry, `scripts/install.sh` sets every `*_CORS_ORIGINS` variable it finds to `http://localhost` and `http://127.0.0.1` on the control plane's port and on `5173`, four origins. Anything added to the registry afterwards, including entries from an example file, keeps the origins written in that file until you edit them. Opening the dashboard from another address, such as a LAN IP or an `https` hostname, means adding that origin to every speech server's allowlist. A shard's example registry carries placeholder `https` tailnet origins; replace them with the origins you use.

The OpenClaw gateway checks browser origins too, separately from any speech server. Add every origin you open the dashboard from to `gateway.controlUi.allowedOrigins`. See [configuration.md](configuration.md#cors) for both.

## Adding another server

Any server that answers the routes in [speech-server-api.md](../speech-server-api.md) works: `POST /v1/audio/transcriptions` for STT, `POST /v1/audio/speech` plus `POST` and `DELETE /v1/models` for TTS, a health path, and CORS.

1. Add a `services` entry to your registry: `capabilityId` `"stt"` or `"tts"`, its host, port and health path, and `"runner": { "type": "external" }` if Banter should not manage its process. A `process` runner marks its port as `{port}` in `runner.main` and writes the number only in `network.port`.
2. Add a `roster.providers` entry keyed by the service id, naming at least one model. [voices-and-models.md](voices-and-models.md#adding-another-model-or-another-speech-server) has the exact shape.
3. Point `config.json` at it: `voice.stt.serviceId`, and `voice.tts.selection` for TTS.
4. Reload and restart the affected provider; see [Applying an edit](voices-and-models.md#applying-an-edit):

   ```bash
   curl -X POST http://localhost:4200/api/config/reload   # your control plane's port
   ```

A service whose `lifecycle` sets `loadStrategy: "demand"` shows as available rather than online until a conversation starts it. If a service shows unhealthy once started, or voice fails once it is healthy, recheck [CORS](#cors) first.

[models.md](models.md) lists known-working servers and what each needs.

## Fluid, an Apple Silicon option

[`services/fluid`](../../services/fluid/README.md) holds `fluid-stt` and `fluid-tts`, speech servers for macOS 15 or later on Apple Silicon. They are an option beside the Python adapters, not a replacement: they stream transcription and audio, and run on CoreML. Their entries are in `services/fluid/registry.fluid.example.json`, which merges into your registry by appending:

- its `services`, to your registry's `services`;
- its `roster.providers`, to `roster.providers`;
- its `fluid-` voices, to `roster.voices`.

Set each appended service's `hostId` to a host in your registry, and expand the leading `~/` in each `ops.env.workingDirectory` to your home directory (nothing downstream expands it; the merge command in the fluid README does both). Its model ids and `fluid-` voice ids do not collide with the example registry's. Set `FLUID_CORS_ORIGINS` on both entries to your dashboard's origins.

Then build and install:

```bash
scripts/fluid-build.sh
scripts/control-install-services.sh   # or scripts/shard-install-services.sh on a shard
```

`fluid-build.sh` compiles the servers in `services/fluid`, first checking its prerequisites (Swift 6 toolchain, `libopus`) and naming what is missing. The install script copies the built app bundles into the deployed tree, as each entry's `ops.install` declares; a full `scripts/control-deploy.sh` does the same. Run both again after any pull that changes the fluid sources.

[`services/fluid/README.md`](../../services/fluid/README.md) has the prerequisites, the merge command, and what the servers offer. On Linux the fluid servers do not build; see [linux-speech-servers.md](linux-speech-servers.md).
