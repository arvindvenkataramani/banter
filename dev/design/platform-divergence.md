# Platform divergence

Where Banter differs from platform (`~/Code/airavatha/sutradhara/platform`), why, and what should happen to each difference. Read this before porting anything from platform. Update it when a port lands or a decision below is made.

Last audited: 2026-10-31, against platform `6703915` and Banter `0c71d6b`; the ports it found landed the same day (see the table below). Of 371 files present in both repos, 143 differed; 123 in-scope files exist only in platform and 37 only in Banter.

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
- `shared/src/registry.ts`: error messages include the bad value.
- `control-plane/src/routes.ts`: OpenAPI definitions for `/api/gateway/defaultAgent`, `/api/gateway/lastSession`, `/api/voice/selection`, `/api/config/reload` and `/api/debug/mic-sample`. They register nowhere at runtime but feed `scripts/generate-api-docs.ts`, so the API reference documents those endpoints; platform's doesn't.
- `shared/types.ts`: `Shard.endpoint` is required; platform's optional field adds four type errors.
- Scripts: `deploy.conf`; `service-control.sh` finding the node from its registry; `fluid-build.sh` preflight checks; `fluid-smoke.sh` and `fluid-smoke-listen.ts`; `control-dev.sh` using the live registry and overridable ports; `shard-registry.sh`, which resolves the shard registry the way the shard does; per-name staging directories, so a control plane and shard on one Mac don't share one; `shard-dev.sh` restoring the production agent on any exit; macOS fallbacks where `lsof` or `systemctl` are missing; the systemd unit rendered from a template; `.build` pruned from the logs scan.
- Dashboard: `eslint.config.js` rules; `gateway-context.tsx` deriving the connection with `useMemo`; `use-session-manager.ts` effect dependencies; `use-wake-lock.ts`'s targeted lint exemption; `services/page.tsx` depending on `[load]`; `src/test-setup.ts` for Node 26's `localStorage`.
- `CONTRIBUTING.md`: the testing table and the human-review list.
- Open-source files with no platform counterpart: `LICENSE`, `NOTICE`, `SECURITY.md`, `.github/`, `.nvmrc`, `install.sh`, `render-plist.sh`, `dashboard/scripts/fetch-models.ts` and the `setup` script, the example registries and config, `services/README.md`, `services/fluid/README.md` and `DEVELOPING.md`.

## Banter is behind: port from platform

Every code change the 2026-10-31 audit found has been ported (see the table). Still open:

- **Docs were not audited.** The audit compared code, scripts and config, not `docs/`. Platform's tests cite `docs/components/voice-turn-taking.md` and `docs/pages/voice-interface.md`, which Banter lacks; the next audit should compare `docs/` too.
- **Lint:** `dashboard/src/lib/voice/turn-manager.ts` has two `prefer-const` errors and `lib/media-engine.ts` an unused lint exemption; check whether platform has fixed them.

### Ported on 2026-10-31

| Platform change | Banter commit |
|---|---|
| Off health state (`c5137cc`) | `4e1ddcb` |
| Registry write-back and registry tests (`2b5b76b`, `f8995ef`) | `a5bbccf` |
| Shard memory check and duplicate routes dropped; control test rewrites (`3890c88`, `eb41eaf`, `210393d`, `8b11f21`, `76a2b87`) | `ce5674a` |
| Relative event-log path (`02dbb1d`) | `3e03a98` |
| Mic samples in the temp directory (`4540ca1`) | `dde08d3` |
| Roster schema and design record | `2724ed5` |
| Probe skill test | `8f5ca6b` |
| Unused `Shard.tailscaleServe` dropped | `cdaf8a2` |
| Services page (`09683de`, `0b0333e`, `47f0217`, `f9fc475`) | `8eb9219` |
| Phosphor icons (`8c9a726`) | `a0fefd8` |
| Per-part config reload (`7377b62`) | `bf8a220` |
| Toast close button | `7beef90` |
| Dashboard test rewrites and chat.md sections (`3a6558a`, `2e77149`, `8003a74`) | `6ecf503` |
| PNG app icons, Banter's own art | `55ee45e` |
| Deploys keep voice choices; bash 3.2 (`dadf3c8`, `b53213c`) | `41f170b` |
| Homebrew tools on managed services' PATH (`8809009`) | `e1a79c3` |
| Staging under `/var/tmp` (`bf3a0c3`) | `4ee7bd4` |
| API reference from a pre-commit hook, not the deploy (`b98d076`) | `33974d0` |
| Installs take only what `ops.install` declares (`1c3f19e`) | `260eb99` |
| Shard deploy and dev API-only, `xcrun swiftc` (`d033d09`) | `45de02f` |
| Preflight sibling-directory fix | `ce45495` |
| `probes/browser-audio` | `3c7e68a` |
| FluidAudio pin and tokenizer path (`2f7ef71`, `d880707`) | c527af9 |

## Banter bugs found in audit

Both fixed on 2026-10-31:

- **The shard install could silently skip** (`11f01b7`). It read a registry a staged deploy doesn't have; `scripts/shard-registry.sh` now resolves the registry the way the shard does, and the install fails clearly when there is none.
- **`BANTER_SHARD_HOST`** was not a stray knob: with Banter's http default, a shard on a second machine reached over a LAN without Tailscale must listen beyond loopback. Its comment and `docs/shard-setup.md` now say so (`cdaf8a2`).

## Open decisions

Each needs Arvind's call. Until then Banter keeps its current position.

1. **Naming.** `BANTER_` env prefixes, `com.banter` bundle and plist IDs, "Banter" in titles and device labels, and generic host and person names in tests, examples and comments (`gpu-machine`, `home-server`, `example`, `alex`). Some platform names remain (`@platform/shared`, the `platform_find_jq` helpers, `PLATFORM_DIR` in `shard-runner.swift`).
2. **Styling.** Banter's neutral palette, `--radius` 0.75rem, 15px chat type, the neutral user bubble, `.chat-ambient-wash`, the glow overlay colours, and the Banter logo and favicon. UI icons follow platform (item 8 above).
3. **Where the control port and shard registry live.** Banter reads the control port from the registry's `control` entry; platform keeps it as `CONTROL_PORT` so dev and production can share a machine by port. Banter keeps the shard registry outside the deployed tree (`~/services/shard/registry.json`); platform keeps it in `data/registry.json` and stashes it across deploys. See the install bug above.
4. **Exact dependency pins** in Banter's `package.json` files, against platform's caret ranges.


## Decided

- **Banter keeps http as its default scheme, and does not take platform's origin rule** (2026-10-31). Platform defaults to https except on loopback, because it assumes a tailnet, and its SEN-143 work (`5e5fb7d`, `811bb28`, `dbeb9ee`) builds on that: browsers reach Mac services through the shard's `/svc/<id>/` route (`forward.ts`), every route refuses a page that isn't https unless the registry's `extraOrigins` lists it (`origin.ts`), and the speech servers bind loopback with no CORS lists. Banter keeps http so a LAN or plain-IP install works without Tailscale, and documents why https is safer and how Tailscale provides it. `forward.ts`, `origin.ts`, `extraOrigins`, the `/svc/` endpoint rewrite, whisper's loopback bind and the matching test cases stay out.
- **The PyTorch Kokoro and NeuTTS-Air adapters stay, for Linux** (2026-10-31). Platform retired both (`88b59dd`) because Kokoro runs on `fluid-tts` on a Mac; Banter keeps them as the Linux options.
- **`probes/browser-audio` comes over, documented for anyone debugging speaker crackle while the microphone is open** (2026-10-31).
- **UI icons follow platform** (Phosphor, `8c9a726`).
- **OpenClaw tools stay** (see above).
