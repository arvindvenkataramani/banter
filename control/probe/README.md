# Gateway probe

A headless OpenClaw gateway client for answering protocol questions from
the wire rather than from source or documentation.

It exists because the dashboard cannot be used as an instrument. Reading
the dashboard's behaviour tells you what the dashboard understands, which
is the thing under test. The probe connects as its own paired device,
advertises the capabilities we want to study, and records every frame
raw — before any normalization — so a capture is evidence rather than
interpretation.

Built to settle how tool calls arrive during an agent run.

## Why it has its own identity

The probe pairs as a separate device with its own Ed25519 keypair. It
does not reuse the CLI identity at `~/.openclaw/identity/` or any other
client's credentials.

Borrowing a credential makes protocol anomalies indistinguishable from
bugs in whichever client lent it — and a shared identity cannot be
revoked without revoking that client too. `openclaw devices list` shows
the probe as **"Banter gateway probe"**, revocable on its own.

## Setup

Pair once:

```bash
bun run control/probe/run.ts --pair
```

The first run fails with `pairing required` and prints the device id.
Approve it, then run again to confirm the handshake. It should report
`handshake ok`, and the device should appear in `openclaw devices list`.

## Running

```bash
# One scenario
bun run control/probe/run.ts --scenario text-slow-tool-text

# Everything
bun run control/probe/run.ts --all

# Pin the model (default is a local LM Studio model)
bun run control/probe/run.ts --model anthropic/claude-haiku-4-5 --scenario multi-tool
```

Scenarios are defined in `scenarios.ts`, each with an `intent` recording
what it is meant to reveal. They run against a scratch agent, by default in
session `agent:example:probe` (override with `PROBE_AGENT_ID`/`PROBE_SESSION`),
because scenarios run shell commands and should not land in a session anyone
is reading.

Model behaviour varies enough to matter. Tool-calling reliability
differs between models, and at least one (`ornith`) has produced
schema-rejection errors on larger tool payloads. If a scenario produces
no tool events, check whether the model actually called a tool before
concluding anything about the gateway.

### Listening without sending

```bash
bun run control/probe/listen.ts
```

Subscribes and records, never sends. This is the position of a client
attaching to a run it did not start — which is the only way to observe
`session.tool`, since run originators are deduplicated out of that
broadcast.

### Reading captures

```bash
bun run control/probe/analyze.ts control/probe/captures/<file>.jsonl
```

Captures are JSONL, so `jq` works directly:

```bash
jq -r 'select(.frame.event=="agent") | .frame.payload.stream' capture.jsonl | sort | uniq -c
```

## Data

| Path | What | Committed |
|------|------|-----------|
| `identity.json` | paired device credential, mode 0600 | no |
| `captures/` | recorded frames | no |

Both are gitignored and live here rather than in a hidden home directory,
so they are visible on a plain `ls` and obvious enough to manage.

**Captures may contain conversation content.** By default a capture keeps
full frames only for the probe's own session; every other session is
reduced to an envelope — routing fields, phases, timestamps, no message
text. `--all-sessions` disables that and records everything the operator
role can read, including unrelated conversations. Use it only when a
scenario needs it, and treat the result as sensitive.

Compaction summaries are always stripped, replaced by
`{omitted: true, bytes: N}` so the omission stays visible. Auth tokens
and device tokens are redacted.

Captures are pruned to the newest 20 on each run.

## Design constraints

Two rules the code holds to, both learned expensively.

**Every event family is recorded.** The previous capture tooling was
typed `'chat' | 'session.message'`, which is why a third stream stayed
invisible for three weeks. Nothing in the capture path may narrow by
event name.

**Frames are tapped raw, before parsing or dispatch.** A frame the probe
fails to understand still lands on disk intact. Normalization is our
interpretation; the question a capture answers is what the gateway sent.

## Tests

```bash
cd control && bun test
```

`test/probe-capture.test.ts`, `probe-identity.test.ts` and
`probe-connection.test.ts` cover session filtering, redaction, compaction
stripping, identity derivation and challenge signing, and the handshake
against a mock gateway. No test touches the real gateway.
