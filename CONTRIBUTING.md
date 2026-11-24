# Contributing

## Testing

Run what covers the change before committing it. The commands are in the [developer guide's Tests section](docs/reference/README.md#tests).

| Area | Run |
|---|---|
| Control plane and shard | The control tests |
| Dashboard and voice engine | The dashboard's tests, lint and typecheck |
| dsh plugin | The plugin's tests, lint and typecheck |
| Fluid servers | The Swift tests, in `services/fluid/` |
| `fluid-stt` as deployed | `scripts/fluid-smoke.sh`, after changes to `services/fluid` or the dashboard's voice clients |

`fluid-smoke.sh` deploys into a scratch directory under a throwaway bundle identifier, so it never touches a running server, and removes everything it deployed on exit. [services/fluid/DEVELOPING.md](services/fluid/DEVELOPING.md) has the details.

A change these cover can be committed on a green run, without anyone trying it by hand. A skipped check, or a failure that is explained away rather than fixed, is not green: say what was skipped and why.

## Changelog

[CHANGELOG.md](CHANGELOG.md) is written for someone updating an installation or the dsh plugin from the previous release. A change a user would notice adds its line under **Unreleased** in the same commit as the change. Releasing renames that heading to the version, and the release workflow publishes that section as the release notes; it refuses a tag whose version has no section.

Each release's section has up to four groups, in this order, and leaves out any that are empty:

1. **Action needed.** What someone updating must do: a renamed or removed config or registry field, an entry that now needs something it didn't, a plugin that must match the server's version.
2. **New.** Something a user can now do, or a new API, setting or guide worth knowing about.
3. **Changed.** Behaviour a user would notice that works differently now.
4. **Fixed.** Bugs a user could have hit. Last, because few of them matter to most users.

One line per item, in plain words, naming the setting, field or route and linking its doc where there is one. No commit hashes, and no internal labels such as a build phase.

Left out: specs, tests, `dev/` changes, refactors, the release commit itself, and internal changes with no visible effect unless they change what a user must do. Doc edits are left out unless they add a page worth knowing about.

## Git hooks

`scripts/git-hooks/` holds the hooks every clone should run. `ops/install.sh` enables them in a git checkout; in a clone that skipped it, run `git config core.hooksPath scripts/git-hooks`. The `pre-commit` hook regenerates `docs/reference/api.md` (`bun run docs`) on any commit that touches `control/` and adds it to that commit, so the reference always matches the routes beside it.

## Changes that need human review

Some changes no automated run can clear. Whoever makes one, a person or an agent, prepares it, says what needs checking, and stops: it is not committed, deployed or run until a human has reviewed it. A passing test suite does not change that.

- **Live state.** Deploying; editing a deployed `registry.json` or `config.json`; stopping, starting or replacing a running service; anything on a shard machine or in Tailscale Serve. The repo is only the source; a deployed tree is what people are using.
- **Exposure and access.** CORS origins, `--bind all`, `tailscaleServe`, gateway tokens and authentication, and anything else that changes who can reach a service. See [SECURITY.md](SECURITY.md) and [Hardening](README.md#hardening).
- **Downloads and credentials.** Fetching model weights or other large downloads, and anything that reads, writes or needs tokens or keys.
- **What only a person can judge.** Audio quality, how latency feels, microphone, turn-taking and barge-in behaviour, how the dashboard looks and reads, and behaviour with third-party clients (a Deepgram-compatible meeting app, say).
- **Results that don't add up.** A failure or skip with no explanation, or a fix that works by loosening a check, widening a timeout or deleting a test.
- **What can't be undone by reverting a commit.** Deleting data, logs, models or event history; migrating deployed files; rewriting git history.
