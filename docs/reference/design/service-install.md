# Service install

How a service's built artifacts reach the directory the shard runs it from. Covers compiled services; the same registry field is read on every node.

## Build and install are separate

Stopping a running service, swapping its files, recording what went in and restarting it is the same work for every compiled service. A deploy script per service re-implements it each time, with its own idea of each step, so the work is done once, in the install scripts, and each package supplies only its build.

**A build** is per package. It produces artifacts inside the source tree and touches nothing installed. Packages build differently — SwiftPM, `xcodebuild`, nothing at all for a Python service — so each keeps its own build command. `scripts/fluid-build.sh` checks the toolchain the package needs, then runs `swift build -c release` on `services/fluid`, and nothing else.

**An install** is one mechanism, the same for every service, performed by `scripts/shard-install-services.sh`. It reads what to install from the registry, so it holds no knowledge of any particular service. A shard deploy already runs it; after a build it runs on its own:

```bash
scripts/fluid-build.sh && scripts/shard-install-services.sh
```

## The registry declares a service's artifacts

```json
"ops": {
  "env": { "workingDirectory": "/Users/alex/services/fluid/fluid-stt" },
  "install": {
    "artifacts": [
      { "from": "services/fluid/.build/release/fluid-stt.app", "to": "fluid-stt.app" }
    ]
  }
}
```

`from` is relative to the source tree the install runs from; `to` is relative to the service's `workingDirectory`. One build can feed several services: `fluid-stt` and `fluid-tts` name different binaries from the same `.build/release/`. A service with no `ops.install` is skipped by the artifact steps and still gets the rest.

`ops.install` is the registry's only way to say how a service is installed; runner types derive every start and stop command, so `ops` carries no command strings.

The registry validator in `control/shared/src/registry.ts` checks `ops.install`: a non-empty `artifacts`, each path relative and free of `..`, and a `workingDirectory` to install into. The registry is rewritten from its parsed form whenever the dashboard changes a service, so a field the validator dropped would vanish on the next enable or disable; `registry.test.ts` holds `ops.install` to surviving that write.

## What an install does, per service

1. **Compare.** An artifact identical to what is installed is skipped, and a service whose artifacts are all unchanged is not touched at all. The install runs on every shard deploy, and restarting every service each time would be wrong.
2. **Check.** An artifact missing from the source tree means its build has not run. The service is skipped with a line naming the missing path, and the install carries on; a shard deploy never fails because a service was not built.
3. **Stop.** If the shard answers and reports the service loaded, stop it through `POST /api/services/<id>/stop`. If the shard does not answer — it is mid-deploy — nothing is stopped; the swap below is safe regardless.
4. **Swap.** Copy to `<to>.new` beside the target, then rename over it. A process still running keeps the file it mapped, so the swap never corrupts a live service.
5. **Record.** Write the source commit to `SOURCE-COMMIT.txt` in the working directory, suffixed `-dirty` when the source tree has uncommitted changes, and append a `service.installed` event (below).
6. **Logs.** Create `logs/` in the working directory, which the process runner writes into.
7. **Restart** what step 3 stopped, and only that.

**Failures surface; they do not stop the rest.** The scripts read `registry.json` with `jq`, not through the validator, so they apply the same path rule themselves: an entry with no absolute working directory, or an artifact path that is empty, absolute or climbs out with `..`, is skipped with an error and installs nothing. An unreadable registry, such an entry, or a service stopped for the install that would not start again makes the install exit non-zero after everything else is installed. A deploy calls the install while its own service is stopped, so it brings that service back regardless and reports the failure at the end, exiting non-zero.

Plist installation for launchd runners is unchanged and stays registry-driven through `runner.plist`.

The per-service steps live in `scripts/install-artifacts.sh`, sourced by both `shard-install-services.sh` and `control-install-services.sh`, so every node reads the same field the same way.

## Install is never an endpoint

Installing runs only as a script on the machine. The control API has no authentication and every device that can reach the control plane's port can call it; an endpoint that writes executables and restarts them would turn that reach into code execution on the host. Start and stop stay on the API because they run only what an operator already installed.

## Out of scope

**Python services.** Installing one means syncing dependencies into its venv, not placing artifacts, and it stays the manual procedure in [`speech-servers.md`](../../guide/speech-servers.md#linux). They still get `logs/` and plists from the same script.


## Deploying from `main` deploys the shard only

`shard-deploy.sh main` extracts a `git archive`, which holds no `.build/`. It skips the artifact steps outright rather than reporting every compiled service as unbuilt; plists and `logs/` are installed as usual. Compiled services are installed from a working tree, by a build followed by `shard-install-services.sh`.

## Every install is recorded as an event

An install appends `service.installed` to the node's `events.jsonl`, carrying the source commit, whether the tree was dirty, and each artifact's installed path and sha256. The script writes the line itself; `appendEvent` writes single lines in append mode, so a script's line cannot interleave with the shard's.

The event is a record, not a health signal. Health derivation skips it, so a stopped service still reads `down` after an install rather than `unknown` until its next start. The last `service.installed` for a service is what install and deploy scripts read to learn what is installed and from which commit; `installed_record` in the shared script returns it.
