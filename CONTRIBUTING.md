# Contributing

## Testing

Run what covers the change before committing it:

| Area | Command |
|---|---|
| Control plane and shard | `bun test ./control` |
| Dashboard | `bunx tsc -b` and `bunx vitest run`, in `dashboard/` |
| Fluid servers | `swift test`, in `services/fluid/` |
| `fluid-stt` as deployed | `scripts/fluid-smoke.sh`, after changes to `services/fluid` or the dashboard's voice clients |

`fluid-smoke.sh` deploys into a scratch directory under a throwaway bundle identifier, so it never touches a running server, and removes everything it deployed on exit. [services/fluid/DEVELOPING.md](services/fluid/DEVELOPING.md) has the details.

A change these cover can be committed on a green run, without anyone trying it by hand. A skipped check, or a failure that is explained away rather than fixed, is not green: say what was skipped and why.

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
