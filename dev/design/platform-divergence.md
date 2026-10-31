# Platform divergence

Where Banter differs from platform (`~/Code/airavatha/sutradhara/platform`), why, and what should happen to each difference. Read this before porting anything from platform. Update it when a port lands or a decision below is made.

Last audited: 2026-10-31, against platform `bcead8b` and Banter `5075d1f`. Of 380 files present in both repos, 130 differed; 28 files exist only in Banter.

## The rule

Banter matches platform except where a difference exists for one of two reasons:

1. **Banter leaves out a platform feature.** Banter is platform's chat, voice and services system and nothing else. Home, media, workspace, prompts, the vault and Obsidian, journaling and rituals, and the chat controls that live on other pages stay out.
2. **Banter is meant to become harness-agnostic.** Shared code should not assume one agent harness or gateway. Harness-specific tools, such as the OpenClaw plugin and probe, stay (see [OpenClaw support stays](#openclaw-support-stays)).

Everything else converges on platform. Arvind tests UI and features in platform before they are ported, so a clean port of shared chat and voice code needs no human test here. Review is for the Banter-specific delta: code adapted rather than copied, Banter's own surroundings the code relies on (theme tokens, config), flows platform never runs, and the live-state items in [CONTRIBUTING.md](../../CONTRIBUTING.md).

This supersedes the migration plan's "Banter's UI stays as it is". The services page and other shared UI converge too.

Four kinds of difference are not settled by the rule. They are listed under [Open decisions](#open-decisions), with the position Banter takes until they are decided.

## How to audit

List the tracked files in both repos (excluding `dev/` and `docs/`), compare the ones present in both, and read each differing file hunk by hunk. `git log -3 -- <file>` in both repos tells whether platform moved after the last port (Banter is behind) or Banter changed something platform lacks (Banter is ahead). Classify each hunk with the categories below.

## Keep: features Banter leaves out

These hunks are removals and stay removed.

- **Media:** the media page and player, media generation and jobs (`media-job.ts`, `/api/jobs` routes, the job sweep, `JobBusyTracker`), media slots and voices in `config.json`, `media.*` event types, and the media tab in settings.
- **Home:** the home page, `BottomBand`, time-of-day, the home CSS primitives and their tokens (area, TOD, `--sp-*`, `--float-*`), the Caveat font, and `shared/pick.ts`.
- **Vault and workspace:** `config.vault`, `VaultPaths`, `/api/content` and `registerContentConfig`, workspace routes, the Obsidian links in tool cards and the nav bar, and the probe's vault-read scenario.
- **Prompts:** the `@prompts` alias and `setGatewayConnection`.
- **Platform-only services:** the legacy `platform-control` and `platform-dashboard` units, and the dev/main branch flow in `branch-status.sh`.
- **Structure kept for a future player:** `lib/media-voice-mode.ts` and `lib/media-engine.ts` stay, unused, so chat files match platform's.

## OpenClaw support stays

Harness-agnostic means Banter can work with other harnesses, not that it drops OpenClaw. The OpenClaw tools are useful and stay, ported from platform like everything else:

- `plugins/voice-mode/`, the OpenClaw voice-mode plugin.
- `control/probe/`, the OpenClaw gateway probe.
- `dashboard/src/lib/gateway-types.ts`, OpenClaw's protocol types.

The agnostic work is adding seams so another harness can sit beside OpenClaw. A port should not spread OpenClaw assumptions into shared code that doesn't need them. Two places where shared code names OpenClaw, worth revisiting when a second harness arrives:

- `scripts/deploy-preserve-config.sh` names `.integrations.openclaw.lastSessionByAgent`.
- "Voice chat platform for OpenClaw" in `dashboard/index.html`, `manifest.webmanifest` and `scripts/generate-api-docs.ts`.

[agent-backend-abstraction.md](agent-backend-abstraction.md) covers what a second backend costs.

## Banter is ahead: send to platform

Banter changes that platform lacks. They stay, and should be offered back to platform so the two converge.

- `control-plane/src/shard-client.ts`: shard errors carry a bounded, sanitised snippet of the response, with a hint when an https endpoint is spoken to as http.
- `control-shard/src/paths.ts`: testable path resolution, preferring lowercase `~/services`.
- `shared/src/registry.ts`: the `--port` mismatch check only for process runners, the endpoint re-derivation on patch matching the loader, and error messages that include the bad value. Tests: `endpoint-derivation.test.ts`, `shard-client-errors.test.ts`, the patch tests in `registry.test.ts`, the `intervals-changed` tests in `registry-reload.test.ts`.
- Scripts: `deploy.conf` support; `service-control.sh` finding the node from its registry rather than from the OS; `fluid-build.sh` preflight checks; `control-dev.sh` using the live registry and overridable ports; macOS fallbacks where `lsof` or `systemctl` are missing; `control-install-services.sh` rendering the unit from a template and reading the port from the registry.
- Dashboard: `eslint.config.js` rules; `gateway-context.tsx` deriving the connection with `useMemo`; `use-session-manager.ts` effect dependencies; `src/test-setup.ts` for Node 26's `localStorage`.
- `CONTRIBUTING.md`: the testing table and the human-review list.
- Open-source files with no platform counterpart: `LICENSE`, `NOTICE`, `SECURITY.md`, `.github/`, `.nvmrc`, `install.sh`, `render-plist.sh`, the example registries and config.

## Banter is behind: port from platform

Platform changes Banter has not taken. Most important first.

1. **`scripts/deploy-preserve-config.sh`.** Platform preserves `.voice.tts.selection`, `.voice.stt.serviceId` and `.voice.stt.model` across a deploy; Banter preserves only the OpenClaw session key, so a deploy reports the user's voice choices as drift and an overwrite drops them. Banter's `declare -A` also fails under macOS's bash 3.2; platform's version is bash-3.2-safe and takes a `<plane|shard>` argument (`dadf3c8`, `b53213c`).
2. **FluidAudio pin.** Platform pins `568fef9f`, which adds upstream #942, the LuxTTS mid-phrase pause fix (`2f7ef71`). Banter pins `6843a35b`. Update `Package.swift`, `Package.resolved`, and the pin text in the README and patches README.
3. **Pocket-TTS tokenizer path** in `patches/verification/PocketTtsChunkProbeTests.swift` and `tokenizer_parity.py`: platform reads `pocket-tts-coreml/constants_bin/tokenizer.model`, the tree fluid-tts loads (`d880707`). Keep Banter's `POCKET_PROBE_DIR` requirement.
4. **`ref_text` for cloned voices** in `voice-roster.ts`, sent only when `cloning.requiresText` is true, with its two tests (`b0ce3bf`).
5. **Services page.** Platform's redesign: a two-row card, tabbed detail, history inside the detail, and a registry `notes` field (`47f0217`). Banter's form sends `undefined` for an emptied field, which JSON drops, so clearing a value never clears it; platform sends `null` (`f9fc475`).
6. **Deploy and install scripts.**
   - `control-runner.sh` exports Homebrew's bin directories on `PATH` so managed services can find brew tools (`8809009`).
   - Deploys stage under `/var/tmp`, not tmpfs `/tmp`, which fails on a Pi (`bf3a0c3`).
   - `deploy-source.sh` and the shard's `--reset-config` with config stash and restore (`dadf3c8`).
   - Install scripts install only what the registry's `ops.install` declares, not every script in `services/` (`1c3f19e`).
   - `shard-deploy.sh` and `shard-dev.sh` still build and serve the dashboard; platform's shard is API-only (`d033d09`).
   - `xcrun -f swiftc` with a clear error when the toolchain is missing.
   - `deploy-preflight.sh`: the `%h` prefix test matches `"$PROD"/*`, not `"$DEST"*`.
7. **Smaller items.**
   - A relative `eventsPath` resolves against the deployment root, not the working directory (`02dbb1d`).
   - `MIC_SAMPLE_DIR` defaults to the OS temp directory: debug captures are scratch (`4540ca1`).
   - The nav bar's reload uses `postConfigReload` and reports each part's result.
   - `<Toaster closeButton />`.
   - The apple-touch-icon is an SVG, which iOS ignores; it needs a PNG.
   - Lost tests: the two `healthExpect` tests in `shared/test/lifecycle.test.ts` (`a94f31e`) and the ping test in `control-shard/test/idle.test.ts` (`ddaaed5`).

## Open decisions

Each needs Arvind's call. Until then Banter keeps its current position.

1. **Naming.** `BANTER_` env prefixes, `com.banter` bundle and plist IDs, "Banter" in titles and device labels, and generic host and person names in tests, examples and comments (`gpu-machine`, `home-server`, `example`, `alex`). An open-source repo cannot carry personal machine and agent names, which argues for keeping them. Some platform names remain (`@platform/shared`, the `platform_find_jq` helpers).
2. **Styling.** Banter's neutral palette (chroma 0, against platform's warm paper hue), `--radius` 0.75rem, 15px chat type, the neutral user bubble, `.chat-ambient-wash`, the glow overlay colours, and the Banter logo and favicon. An earlier note kept styling as Banter's; the rule above does not list it.
3. **Default endpoint scheme.** Platform defaults to https except on loopback, because it assumes a tailnet. Banter defaults to http, so a LAN or plain-IP install works without Tailscale. Banter's tests pin http.
4. **Where the control port and shard registry live.** Banter reads the control port from the registry's `control` entry; platform keeps it as `CONTROL_PORT` so dev and production can share a machine by port. Banter keeps the shard registry outside the deployed tree (`~/services/shard/registry.json`), so a deploy cannot overwrite it; platform keeps it in `data/registry.json`. Exact dependency pins in Banter's `package.json` files, against platform's caret ranges, belong to the same kind of question.
