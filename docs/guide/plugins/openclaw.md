# OpenClaw voice-mode plugin

Banter ships an OpenClaw plugin that injects voice-specific guidance into the system prompt, so the agent knows it is being spoken to rather than read. It lives in `plugins/openclaw/voice-mode/`.

The plugin is optional: Banter works with OpenClaw without it. It only tells the agent it is being spoken to, so its answers suit being read aloud. It runs inside the OpenClaw gateway and makes no calls to the Banter server, so the server does not need to be up for it to load. It adds its guidance only to sessions whose key starts with `sessionKeyPrefix`, so it has an effect when people talk to the agent through Banter's web app, which opens sessions with keys of the form `agent:<agent-id>:<session>`.

## Install

```bash
cd plugins/openclaw/voice-mode
bun install && bun run build
openclaw plugins install .
```

Build first: OpenClaw loads `dist/index.js`, so an unbuilt plugin installs and does nothing. Point the install at the directory, not the file; the entry point comes from `package.json`.

The plugin works with a dedicated agent for voice: every session of that agent gets the voice guidance, and your other agents are untouched. Session keys are `agent:<agent-id>:<session>`, and the plugin matches them against `sessionKeyPrefix`, which defaults to `agent:voice:`, an agent with the id `voice`. If your voice agent has another id, set `sessionKeyPrefix` to `agent:<that-id>:`, and point Banter at that agent.

`openclaw plugins list` shows the plugin as enabled once installed.

## Changing the plugin

Run `bun run build` in `plugins/openclaw/voice-mode` after every change: the built `dist/` is what OpenClaw loads, which is why `dist/` is committed despite the repo's usual no-build-artifacts posture. Installing with `--link` instead of a plain install makes a rebuild take effect without reinstalling.
