# OpenClaw voice-mode plugin

Banter ships an OpenClaw plugin that injects voice-specific guidance into the system prompt, so the agent knows it is being spoken to rather than read. It lives in `plugins/voice-mode/`.

## Install

```bash
cd plugins/voice-mode
bun install && bun run build
openclaw plugins install .
```

Build first: OpenClaw loads `dist/index.js`, so an unbuilt plugin installs and does nothing. Point the install at the directory, not the file; the entry point comes from `package.json`.

Set `sessionKeyPrefix` in the plugin's config to `agent:<your-agent-id>:`. Session keys are `agent:<agent-id>:<session>`, and the agent id comes from your gateway. The shipped default is a placeholder and matches nothing.

`openclaw plugins list` shows the plugin as enabled once installed.

## Changing the plugin

Run `bun run build` in `plugins/voice-mode` after every change: the built `dist/` is what OpenClaw loads, which is why `dist/` is committed despite the repo's usual no-build-artifacts posture. Installing with `--link` instead of a plain install makes a rebuild take effect without reinstalling.
