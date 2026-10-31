# Platform divergence

Where Banter differs from platform (`~/Code/airavatha/sutradhara/platform`), why, and what should happen to each difference. Read this before porting anything from platform. Update it when a port lands or a decision below is made.

Last audited: 2026-10-31, against platform `6703915` and Banter `0c71d6b`. Of 371 files present in both repos, 143 differed; 123 in-scope files exist only in platform and 37 only in Banter.

## The rule

Banter matches platform except where a difference exists for one of two reasons:

1. **Banter leaves out a platform feature.** Banter is platform's chat, voice and services system and nothing else. Home, media, workspace, prompts, the vault and Obsidian, journaling and rituals, the trace panel, and the chat controls that live on other pages stay out.
2. **Banter is meant to become harness-agnostic.** Shared code should not assume one agent harness or gateway. Harness-specific tools, such as the OpenClaw plugin and probe, stay (see [OpenClaw support stays](#openclaw-support-stays)).

Everything else converges on platform. Arvind tests UI and features in platform before they are ported, so a clean port of shared chat and voice code needs no human test here. Review is for the Banter-specific delta: code adapted rather than copied, Banter's own surroundings the code relies on (theme tokens, config), flows platform never runs, and the live-state and exposure items in [CONTRIBUTING.md](../../CONTRIBUTING.md).

This supersedes the migration plan's "Banter's UI stays as it is". The services page and other shared UI converge too.

Some differences are not settled by the rule. They are listed under [Open decisions](#open-decisions), with the position Banter takes until they are decided.

## How to audit

List the tracked files in both repos (excluding `dev/` and `docs/`), and sort them into three lists: in both, only in platform, only in Banter. Compare the files in both hunk by hunk. `git log -3 -- <file>` in both repos tells whether platform moved after the last port (Banter is behind) or Banter changed something platform lacks (Banter is ahead). Check every finding against the code before recording it: audits by agents have reported deploys that could not happen and tests as lost that platform had rewritten.

## Keep: features Banter leaves out

These hunks are removals and stay removed.

- **Media:** the media page and player, media generation and jobs (`media-job.ts`, `media-routes.ts`, `media-store.ts`, `slot-declarations.ts`, `/api/jobs`, the job sweep, `JobBusyTracker`, `ResultStore`), media slots and voices in `config.json`, `media.*` event types, the media tab in settings, `audio-coordinator.ts`, and the media tests and fixtures.
- **Home:** the home page and surfaces (`home-routes.ts`, `home-surfaces/`), `BottomBand`, `chat-control-cluster.tsx`, `marginalia.tsx`, time-of-day, weather, areas, recency, the home CSS and its tokens (area, TOD, `--sp-*`, `--float-*`), the Caveat font, `shared/pick.ts`, and `cancelArm()` in `App.tsx`.
- **Vault and workspace:** `config.vault`, `VaultPaths`, `/api/content`, `workspace.ts`, `workspace-routes.ts`, `frontmatter.ts`, the Obsidian links in tool cards and the nav bar. The probe's vault-read scenario is rewritten as `read-dir`, not removed.
- **Prompts and trace:** `lib/prompts/`, `lmstudio.ts`, the `@prompts` alias, `setGatewayConnection`, `trace-panel.tsx`.
- **Platform-only services and machines:** piper, embedding, searxng, openclaw-mcp, tts-mlx-audio, lm-studio, zotero-mcp, pdf-ocr; `services/tts/mlx-voxtral-swift`, `omnivoice`, `call-contracts`; the legacy `platform-control` and `platform-dashboard` units; the live `config.json` and `registry.json`.
- **Platform's branch flow:** the dev/main prompts in `deploy-source.sh` and `branch-status.sh`, the pre-commit refusal to commit on main, the Pi deploy hand-off in `post-merge`, and `session-start.sh`. Banter commits on main.
- **Structure kept for a future player:** `lib/media-voice-mode.ts`, `lib/media-engine.ts` and `components/media/transport-atoms.tsx` stay, unused, so chat files match platform's.

## OpenClaw support stays

Harness-agnostic means Banter can work with other harnesses, not that it drops OpenClaw. The OpenClaw tools are useful and stay, ported from platform like everything else:

- `plugins/voice-mode/`, the OpenClaw voice-mode plugin.
- `control/probe/`, the OpenClaw gateway probe, including `skill-test.ts` (not yet ported; see below).
- `dashboard/src/lib/gateway-types.ts`, OpenClaw's protocol types.

The agnostic work is adding seams so another harness can sit beside OpenClaw. A port should not spread OpenClaw assumptions into shared code that doesn't need them. Two places where shared code names OpenClaw, worth revisiting when a second harness arrives:

- `scripts/deploy-preserve-config.sh` names `.integrations.openclaw.lastSessionByAgent`.
- "Voice chat platform for OpenClaw" in `dashboard/index.html`, `manifest.webmanifest` and `scripts/generate-api-docs.ts`.

[agent-backend-abstraction.md](agent-backend-abstraction.md) covers what a second backend costs.

## Banter is ahead: send to platform

Banter changes that platform lacks. They stay, and are offered back in [banter-ahead-of-platform.md](../analysis/banter-ahead-of-platform.md).

- `control-plane/src/shard-client.ts`: shard errors carry a bounded, sanitised snippet of the response, with a hint when an https endpoint is spoken to as http. Test: `shard-client-errors.test.ts`.
- `control-shard/src/paths.ts`: testable path resolution, preferring lowercase `~/services`.
- `shared/src/registry.ts`: error messages include the bad value. (Endpoint re-derivation on patch is obsolete: platform's `2b5b76b` validates the whole file on every patch. The `--port` check is equivalent in both, since only process runners have `main`.)
- Scripts: `deploy.conf`; `service-control.sh` finding the node from its registry; `fluid-build.sh` preflight checks; `fluid-smoke.sh` and `fluid-smoke-listen.ts`; `control-dev.sh` using the live registry and overridable ports; macOS fallbacks where `lsof` or `systemctl` are missing; the systemd unit rendered from a template; `.build` pruned from the logs scan.
- Dashboard: `eslint.config.js` rules; `gateway-context.tsx` deriving the connection with `useMemo`; `use-session-manager.ts` effect dependencies; `use-wake-lock.ts`'s targeted lint exemption; `services/page.tsx` depending on `[load]`; `src/test-setup.ts` for Node 26's `localStorage`.
- `CONTRIBUTING.md`: the testing table and the human-review list.
- Open-source files with no platform counterpart: `LICENSE`, `NOTICE`, `SECURITY.md`, `.github/`, `.nvmrc`, `install.sh`, `render-plist.sh`, `dashboard/scripts/fetch-models.ts` and the `setup` script, the example registries and config, `services/README.md`, `services/fluid/README.md` and `DEVELOPING.md`.

## Banter is behind: port from platform

Platform changes Banter has not taken, most important first. **Review** marks items CONTRIBUTING says need a person before commit.

1. **Tests.** Platform rewrote its control and dashboard suites from its docs and deleted many tests (`210393d`, `f8995ef`, `8b11f21`, `76a2b87`, `3a6558a`, `2e77149`, `8003a74`). Take platform's files, rename hosts, and delete the Banter files they replace:

   | Banter file | Platform now |
   |---|---|
   | `shared/test/lifecycle`, `serve-outcome`, `serve-retry` | `shared/test/lifecycle`, `tailscale` |
   | `control-shard/test/lifecycle`, `idle`, `memory` | same names, rewritten |
   | `control-shard/test/integration`, `shard-api`, `test/shard-reload` | `control-shard/test/shard-api` |
   | `test/shard-app`, `shard-client`, `shard-poller`, `registry-sharing` | `test/shard-link` and `test/fixtures/fake-shard.ts` |
   | `test/registry-patch` | `shared/test/registry` |
   | `shared/test/registry`, `atomic-write`, `test/registry-reload` | same names, rewritten |
   | `shared/test/health`, `events`, `api`, `executor`, `exec` | same names, rewritten |
   | dashboard `run-state`, `conversation`, `conversation-store`, `voice/floor`, `voice/human/mute-store` tests | same names, rewritten |

   The lifecycle, idle, memory, executor, exec, tailscale, atomic-write and health suites pass against Banter's code as they are. The rest need the source ports below. The dashboard tests cite a "Run state" section platform added to `docs/components/chat.md`; port that too. Banter's own tests stay: `runtime-settings`, `config-reload` (media-free), `endpoint-derivation` (http default), `shard-client-errors`.
2. **Services page.** Copy platform's `service-card.tsx`, `service-detail.tsx`, `service-history.tsx` and `page.tsx` (`09683de`, `0b0333e`, `47f0217`, `f9fc475`), keeping `[load]`. Brings the two-row card, tabbed detail with history inside, the `notes` field, and `null` for a cleared field. Banter sends `undefined`, so clearing a value never clears it. The server already accepts `null` and `notes`.
3. **"Off" health state** (`c5137cc`): services not meant to run read as off, not down. Copy `events.ts`, `api.ts` and `health-badge.ts`; add `"off"` to `HealthState` in `shared/types.ts` and `schemas.ts`; `shard-api.ts` uses `deriveServiceHealth` in `/status`.
4. **Registry write-back** (`2b5b76b`): an edit writes back only what it changed, so defaults stay defaults. Banter writes the whole loaded copy, which pins every default into the file on one dashboard edit. Copy `registry.ts`, then re-apply the http scheme default (open decision 3).
5. **Shard cleanup** (`3890c88`, `eb41eaf`): drop the memory budget check, which approved every load, from `memory.ts`, `shard-api.ts`, `routes.ts` and `index.ts`; drop the shard's own `/api/health`, `/api/services` and `/api/events`, which the shared app always answered.
6. **`scripts/deploy-preserve-config.sh`** (`dadf3c8`, `b53213c`). **Review** (live config). Preserve `.voice.tts.selection`, `.voice.stt.serviceId` and `.voice.stt.model` across a deploy; Banter preserves only the OpenClaw session key, so a deploy reports the user's voice choices as drift and an overwrite drops them. Replace `declare -A`, which fails under macOS's bash 3.2, and GNU-only `stat -c` with platform's `mtime_of`. Skip the `<plane|shard>` argument and `mediaGeneration.voices`.
7. **FluidAudio pin** `568fef9f` (`2f7ef71`), the LuxTTS mid-phrase pause fix, and the Pocket-TTS tokenizer path (`d880707`). Done in the working tree and `swift test` passes; `scripts/fluid-smoke.sh` is still to run before commit.
8. **Phosphor icons** (`8c9a726`): chat, services and nav-bar icons move from lucide to `@phosphor-icons/react` (already installed), `strokeWidth` becoming `weight`. Copy exact weights from platform. `components/ui/*` stays on lucide in both.
9. **Config reload** (`7377b62`): `postConfigReload` in `api.ts` and per-part results in the nav bar. Banter's server already returns that shape.
10. **Deploy and install scripts.**
    - `control-runner.sh` exports Homebrew's bin directories on `PATH` so managed services find brew tools (`8809009`). **Review.**
    - Deploys stage under `/var/tmp`, not tmpfs `/tmp`, which fails on a Pi (`bf3a0c3`). **Review.**
    - `control-deploy.sh` stops running `bun run docs`, which dirtied the checkout; platform keeps the API reference current with a pre-commit hook instead (`b98d076`). Banter would need the hook without the main-branch refusal, and a way to set `core.hooksPath`.
    - Install scripts stop mirroring `services/` scripts and plists, installing only what the registry's `ops.install` declares (`1c3f19e`). **Review.**
    - `shard-deploy.sh`: one shared cleanup trap, `xcrun -f swiftc`, and API-only with no dashboard build (`d033d09`); `shard-dev.sh` likewise.
    - `deploy-preflight.sh`: the `%h` test matches `"$DEST"*`, which also matches sibling folders; use `"$PROD"/*`.
11. **Smaller items.**
    - A relative `eventsPath` resolves against the deployment root, not the working directory (`02dbb1d`), with its test.
    - `MIC_SAMPLE_DIR` defaults to the OS temp directory (`4540ca1`).
    - `<Toaster closeButton />`.
    - `schemas/platform.schema.json`: Banter's `Roster.swift` cites it and it doesn't exist. Copy it, retitled.
    - `control/probe/skill-test.ts`: copy, with generic agent names.
    - The apple-touch-icon is an SVG, which iOS ignores, and the PNG favicons are missing. Use Banter's own art; `.gitignore` needs an exception for the PNGs.
    - `Shard` in `shared/types.ts` has an unused `tailscaleServe` and a required `endpoint`; platform has neither.
    - Five route definitions in `control-plane/src/routes.ts` (`patchGatewayDefaultAgent`, `patchGatewayLastSession`, `patchVoiceSelection`, `postConfigReload`, `postDebugMicSample`) are registered nowhere and platform doesn't have them.

## Banter bugs found in audit

- **The shard install can silently skip.** `shard-install-services.sh` reads `$SRC/control/control-shard/data/registry.json`, which git ignores, so a deploy staged from git has none and the plist and artifact steps are skipped without an error. The shard itself reads `~/services/shard/registry.json`, and `service-control.sh` looks in a third place. Follows from open decision 4.
- **`BANTER_SHARD_HOST`** lets the shard bind something other than loopback, against its own comment ("loopback, fronted by Tailscale Serve"). Platform hardcodes `localhost`. An unexplained exposure knob.

## Open decisions

Each needs Arvind's call. Until then Banter keeps its current position.

1. **Naming.** `BANTER_` env prefixes, `com.banter` bundle and plist IDs, "Banter" in titles and device labels, and generic host and person names in tests, examples and comments (`gpu-machine`, `home-server`, `example`, `alex`). Some platform names remain (`@platform/shared`, the `platform_find_jq` helpers, `PLATFORM_DIR` in `shard-runner.swift`).
2. **Styling.** Banter's neutral palette, `--radius` 0.75rem, 15px chat type, the neutral user bubble, `.chat-ambient-wash`, the glow overlay colours, and the Banter logo and favicon. UI icons follow platform (item 8 above).
3. **Default endpoint scheme, and the origin rule.** Platform defaults to https except on loopback, because it assumes a tailnet; Banter defaults to http, so a LAN or plain-IP install works without Tailscale. Platform's SEN-143 work (`5e5fb7d`, `811bb28`, `dbeb9ee`) now builds on https: browsers reach Mac services through the shard's `/svc/<id>/` route (`forward.ts`), every route refuses a page that isn't https unless it is listed in the registry's `extraOrigins` (`origin.ts`), and fluid-stt, fluid-tts and whisper bind loopback and drop their CORS lists. Banter has no origin checks at all and its dashboard calls speech servers directly. Taken as is, the rule would refuse Banter's http LAN dashboard and `http://localhost` dev. It is exposure work and needs review whichever way it goes; don't port pieces of it alone.
4. **Where the control port and shard registry live.** Banter reads the control port from the registry's `control` entry; platform keeps it as `CONTROL_PORT` so dev and production can share a machine by port. Banter keeps the shard registry outside the deployed tree (`~/services/shard/registry.json`); platform keeps it in `data/registry.json` and stashes it across deploys. See the install bug above.
5. **Exact dependency pins** in Banter's `package.json` files, against platform's caret ranges.
6. **The PyTorch Kokoro and NeuTTS-Air adapters.** Platform retired both (`88b59dd`); Kokoro now runs on `fluid-tts`. Banter still ships them as installable, and its docs present them as the Linux options (`docs/models.md`, `docs/linux-speech-servers.md`, `services/README.md`).
7. **`probes/browser-audio`**, platform's probe for speaker crackle while the microphone is open. Voice-related, not excluded by the rule, not yet in Banter.
