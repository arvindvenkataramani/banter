# Gateway tool & message event streams

*Created: 2026-05-01. Rewritten 2026-08-06 against OpenClaw 2026.7.1
(commit `2d2ddc4`), protocol v4. Verified on the wire 2026-08-07.*

**Verification status is marked per-section.** Sections tagged [WIRE] were
observed against the the control host gateway. Sections tagged [SOURCE] are read
from the OpenClaw source at the pinned commit and have **not** been
confirmed on the wire.

The 2026-08-07 capture pass promoted the tool-stream sections to [WIRE]
and **overturned the timing premise the redesign was built on** — see
"Timing". Captures came from a dedicated probe client
(`control/probe/` in this repo) with its own paired device
identity, advertising `caps: ["tool-events"]`, recording every event
family raw with dual timestamps. 22 tool calls across 7 tool types
(`exec`, `read`, `write`, `edit`, `memory_search`, `sessions_list`,
`process`) and 4 models (3 local, plus Haiku 4.5).

---

## The contract, in one line

**`session.message` is a transcript/output projection, not execution
telemetry. `agent` events are the live run telemetry.**

Confirmed by OpenClaw upstream (2026-08-07), and it explains every
surprise in this document. Reading tool activity out of the transcript is
not a fragile technique that needs hardening — it is using the wrong
surface, and upstream never intended it to work.

The corollary for anything latency- or correctness-sensitive:

| Need | Source |
|------|--------|
| text as generated | `chat` deltas |
| what the agent is doing right now | `agent` events (`stream: "tool"`, `lifecycle`, …) |
| authoritative history, reload, recovery | `session.message` / `chat.history` |

See `gateway-run-state-model.md` for how a client assembles these into a
run-state model, which is application work — the client packages do not
provide one.

---

## The problem this document exists to solve

A client rendering an agent run needs three things that pull in different
directions:

1. **Text as it is generated**, so voice playback and typing indicators
   don't wait for a complete message.
2. **Tool calls as structured data**, to render what the agent is doing.
3. **An authoritative final transcript**, to render history correctly on
   reload.

No single event family provides all three. Choosing the wrong combination
is easy and the failure is silent.

---

## Four streams, not two

An agent run emits these concurrently:

| Stream | Granularity | Carries | Requires |
|--------|-------------|---------|----------|
| `chat` | token | text deltas only | nothing |
| `session.message` | message | full transcript message incl. all block types | `sessions.messages.subscribe` |
| `agent` w/ `stream: "tool"` | tool event | structured tool lifecycle, run-scoped | `caps: ["tool-events"]` |
| `session.tool` | tool event | same payload, session-scoped | `sessions.subscribe` + read scope |

`agent` also carries `command_output`, `patch`, `item`, `approval`, and
`lifecycle` streams. `agent.compaction` is handled separately by the
dashboard.

**The 2026-05 version of this document described only the first two**, and
concluded that tool calls "live in `session.message`, not `chat`". That is
true but incomplete, and the incompleteness drove a bad design. See the
postmortem.

---

## Which stream for which job

**Text for streaming playback → `chat`.** [WIRE] Token-granular, arrives
with no subscription as a side effect of `chat.send`. Nothing else gives
sub-message latency. Voice must feed from this.

**Tool activity signalling → `stream: "tool"` / `session.tool`.** [WIRE]
Fires at the actual tool boundary with `phase`, `toolCallId`, `name`, and
`args`. The correct source for "a tool started/finished" — it is the only
one that fires reliably across models.

**Final transcript → `session.message`.** [WIRE] Authoritative per-message
state including every content block type. Correct for history rendering;
wrong as a low-latency signal (see timing).

**In-flight tool output → `agent` `stream: "command_output"`.** [WIRE]
Incremental stdout during a long-running tool, with `toolCallId`,
`phase: "delta" | "end"`, `exitCode`, `durationMs`. Only for tools that
stream output — observed for `exec`, absent for `read`, `memory_search`
and `sessions_list`.

**File change summaries → `agent` `stream: "patch"`.** [SOURCE] Still
unverified. The file-edit scenario produced `write` and `edit` tool
events but no `patch` stream event, so either it needs a different edit
path or the claim is wrong.

**Also on the wire, and not previously documented: `stream: "item"`.**
[WIRE] Every tool call is *also* reported as an item event, twice — once
`kind: "tool"` and once `kind: "command"` — carrying the same
`toolCallId` plus a human-readable `title` ("exec run sleep 8 → print
text"). It has `phase: "start" | "update" | "end"` and fires within a few
ms of `stream: "tool"`. For rendering tool cards this is arguably the
better source: the title is already presentation-ready. Note it fires
twice per call, so a renderer must pick one `kind` or dedupe on
`toolCallId`.

---

## `stream: "tool"` and `session.tool` [WIRE]

Both carry the same `AgentEventPayload` shape with tool data in `data`.
Defined in `src/infra/agent-events.ts`.

**Phases are `start` | `update` | `result`, not `start` | `end`.** The
source type suggested `end`; the wire says `result`. `update` appears
only for tools with progress (`exec`); `read`, `memory_search` and
`sessions_list` go straight `start` → `result`. A client keying on `end`
would never fire.

**The `session.tool` mirror is verified, both directions.** [WIRE] The
run-originating connection receives run-scoped `agent` tool events and
**zero** `session.tool` — the documented dedupe working as intended. A
second listen-only connection (`control/probe/listen.ts`: subscribes,
never sends, so never registered as a run recipient — the position of a
dashboard attaching to an in-flight session) received `session.tool` with
the same `start`/`update`/`result` phases, lagging the run-scoped event by
**1–8ms** wall-clock. The mirror is equivalent in content and latency.

```jsonc
{
  "runId": "run-...",
  "seq": 1,
  "stream": "tool",
  "ts": 1777604400282,
  "sessionKey": "agent:<agentId>:<sessionName>",
  "data": {
    "phase": "start" | "update" | "result",
    "name": "exec",
    "toolCallId": "tool-...",
    "args": { "command": "echo hi" }
  }
}
```

**Why both exist.** Run-scoped `stream: "tool"` events go only to
connections registered as recipients *for that run* — which requires
knowing the `runId`, which requires having started it. A client attaching
to an already-running session cannot register. `session.tool` mirrors the
same payload to session subscribers so late-attaching operator UIs can
render live tool state without polling history. The source comment at
`src/gateway/server-chat.ts:1353` states this directly.

Delivery is deduplicated: session subscribers already receiving the
run-scoped event are excluded from the `session.tool` broadcast.

**Delivery preconditions — background cron runs deliver.** [WIRE] A cron
job on a test (isolated session, `--at` schedule, manually triggered
via `openclaw cron run`) delivered the full event suite to a plain
subscribed operator connection that had never touched the cron session:
`session.tool` `start`/`update`/`result`, `item`, `command_output`,
`assistant`, `chat`, `session.message`, and lifecycle events.
`isControlUiVisible` did not suppress this cron path. Whole-gateway
capture was not needed: envelope-only capture (routing fields, no
content) was enough to prove delivery. Cron session keys have the form
`agent:<agentId>:cron:<jobId>:run:<runUuid>`.

[SOURCE, still unverified] `isControlUiVisible` is forced `false` for
heartbeats and possibly other cron paths; when false, tool events fall
back to `sendAgentPayload` with `dropIfSlow: true`, reaching only
per-session message subscribers. Heartbeat-run delivery remains untested.

---

## Still unverified after the 2026-08-07 pass

Recorded so the next investigation starts from the gaps rather than
rediscovering them.

- **Heartbeat runs** — cron delivery is confirmed (see "Delivery
  preconditions"), but heartbeats take a different path that forces
  `isControlUiVisible` false. Untested.
- **`textSignature` phases** — assistant text blocks reportedly carry a
  `commentary` vs `final_answer` phase (see "Content a client must never
  speak"). Read from the UI source, never decoded from our captures.
- **Inter-stream ordering** — `stream: "tool"` consistently trailed the
  last `chat` delta by a few ms in every capture, but upstream states no
  ordering guarantee *between* families. Treat the observation as
  typical, not contractual. **Confirmed instance of this, live 2026-08-09:**
  `lifecycle:end` regularly arrives ~30-60ms *before* the trailing chat
  delta/final of the same run (e.g. one repro: chat text fed so far was 983
  chars at `lifecycle:end`, vs. 1018 chars in the chat final that followed —
  the 35-char tail `" of the same scene this whole time."` arrived only
  after lifecycle had already signaled the run over). This is why TTS finish
  authority must key off chat terminals only, never lifecycle — see the
  correction appended to `gateway-run-state-model.md` and
  `dashboard/src/lib/voice/turn-manager.ts`.
- **13 of 17 agent stream kinds** — the server emits 17; we provoked 7.
  Deliberately not catalogued: the schema is documented as extensible,
  and a correct reducer treats unrecognised-but-active as
  `active/unknown`, so the list changes nothing about the design.
- **`stream: "patch"`** — the file-edit scenario produced `write`/`edit`
  tool events but no `patch` event.
- **Approval prompts** — the exec policy auto-approved everything the
  scenarios attempted, so no approval event was seen.
- **Anthropic-backed runs** — all captures used local LM Studio models.
  Since `toolCall` presence in `session.message` turned out to be
  model-dependent, cloud models may behave differently again.

---

## `session.message` payload shape [WIRE]

```jsonc
{
  "sessionKey": "agent:<agentId>:<sessionName>",
  "messageId": "<short hash>",
  "messageSeq": 238,
  "message": {
    "role": "user" | "assistant" | "tool" | "tool_result" | ...,
    "content": ContentBlock[] | string,
    "timestamp": 1777604400282,
    "__openclaw": { "id": "07ff6803", "seq": 238 }
  },
  "session": {
    // FULL session metadata, including the entire compaction summary
    // under session.latestCompactionCheckpoint.summary. Multi-KB on
    // long-running sessions — don't naïvely log raw payloads.
  }
}
```

Tool calls appear as content blocks typed `toolCall` — not the standard
Anthropic `tool_use`. Accept both.

**Whether tool calls appear here at all is model-dependent.** [WIRE] This
is the finding that most damages the current transcript-scraping design.

- `gemma-4-26b-a4b`: tool calls appear as `toolCall` blocks.
- `claude-haiku-4-5`: `toolCall` blocks appear, paired with `thinking`
  blocks.
- `qwen3-coder-30b`, `qwen3.5-35b-a3b`, `ornith-1.0-35b`: **no `toolCall`
  blocks at any point** in the same scenarios. Only `text` blocks and
  plain strings — while `stream: "tool"` fired normally for every call.

The split is per-model, not local-vs-cloud. It is not predictable from
anything a client can see at connect time, which is why the transcript
cannot be used as a tool signal at all.

A client sourcing tool activity from `session.message` therefore sees
**nothing at all** on most of our local models. This is not a dedupe or
race problem that careful block handling can fix; the data is absent.

**Block rollout was not reproduced.** [WIRE] Where `toolCall` blocks did
appear, each arrived as its own single-block message with a distinct
`messageSeq` and a unique id:

```
seq 62  [text]
seq 64  [toolCall p0oel2My…]
seq 66  [toolCall ZC0XoNE4…]
seq 68  [toolCall W1hq2g7n…]
seq 70  [toolCall ILDvDuN0…]
seq 72  [text]
```

No payload contained multiple blocks, and none dropped an earlier one, so
the 2026-05 observation of rolling full-state payloads did not recur.
Dedupe by id remains cheap insurance, but it is not load-bearing here.

---

## Timing [WIRE]

**The lead time is real but negligible: `stream: "tool"` beats
`session.message` by a mean of 7ms.** 22 tool calls, range +3.4ms to
+14.0ms, consistent across `exec`, `read`, `write`, `edit`,
`memory_search`, `sessions_list` and `process`, and across three models.

That refutes the premise of the 2026-08-06 redesign, which assumed
`session.message` lagged the tool boundary by ~1s and that `stream:
"tool"` would recover that second. It does not. At the tool boundary all
three streams arrive together — a typical window:

```
t=7721.4ms  session.message   (assistant text before the tool)
t=7724.9ms  chat delta        (same text)
t=7727.7ms  agent stream=tool phase=start
```

**Where the ~1s actually goes.** The 2026-05 measurement was real but
misattributed. The gap is not before the tool — it is *after* the tool
finishes, before the model resumes speaking:

| tool | duration | first `chat` delta after tool end |
|------|----------|-----------------------------------|
| `sleep 8` | 8.1s | +1116ms |
| `echo` | 1.3s | +852ms |
| `echo` | 0.1s | +652ms |
| `sleep 10` | 10.1s | +1479ms |
| `echo` | 0.0s | +10941ms |

So the silence a voice interface has to cover is the tool's own duration
plus a post-tool model latency of roughly 0.7–1.5s (occasionally much
worse). Flushing 7ms earlier does not touch it.

**Consequence for the design.** Re-sourcing `onToolCall` from
`stream: "tool"` cannot be justified on latency grounds. The remaining
arguments for it are correctness ones, and they are strong — see
"Consequences for the voice interface".

---

## Consequences for the voice interface

Voice needs speech flushed *before* the silent pause, not after it, so
buffered text plays while the agent works instead of stalling.

The dashboard implements the flush as
`session.onToolCall → turnManager.recommendFlush()`. The mechanism is
sound; its **input** is the problem — but not for the reason previously
recorded.

Sourcing `onToolCall` from `session.message` means:

- **it does not fire at all on most of our models** [WIRE] — no
  `toolCall` blocks are emitted, so the flush never triggers. This is the
  real defect, and it is a correctness failure rather than a latency one;
- there is no lifecycle signal, so speech can only flush and wait — it
  cannot resume in step with the agent;
- ~~it fires ~1s late~~ — **wrong**. It is ~7ms behind `stream: "tool"`.
  See "Timing".

`stream: "tool"` fires reliably for every tool on every model tested,
carries a stable `toolCallId`, and has `phase: "start" | "update" |
"result"` so speech can resume on completion. `command_output` gives
progress during a long tool, but only for tools that stream output —
`exec`, not `read` or `memory_search`.

The case for re-sourcing is **reliability and the `result` signal**, not
speed. Anyone re-reading this to justify latency work should stop here.

Re-sourcing does not change how text streams. `chat` continues to drive
playback; only the tool signal moves.

---

## Content a client must never speak [SOURCE]

Read from the OpenClaw UI at 2026.7.1, not yet confirmed on our wire.
Every item here is text a naive TTS layer would pronounce aloud.

**Extract text with an allowlist, never a denylist.** The UI keeps only
`text`, `input_text`, `output_text` (`src/shared/chat-message-content.ts`)
and drops everything else by omission — `thinking`, `reasoning`,
`tool_use`, `tool_result`, images, and any block type added later. A
denylist leaks each new type as upstream adds it.

**Reasoning is separable and should stay unspoken.** Thinking arrives
both as `stream: "thinking"` agent events and as `thinking` content
blocks. The UI ignores the stream entirely and renders the blocks behind
a user toggle, visually distinct. Speak neither; showing it on screen is
a display choice.

**Markers that are not prose:**

| Marker | Where | Effect if spoken |
|--------|-------|------------------|
| `NO_REPLY` | silent-reply messages | reads "NO_REPLY" aloud |
| `HEARTBEAT_OK` | heartbeat acks | reads the token aloud |
| `<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>…` | inline in text | reads internal context aloud |
| `[[audio_as_voice]]`, `[[reply_to:…]]` | inline directives | reads the directive aloud |

Silent replies are filtered *during* streaming, not only at commit — a
delta-consuming client must check before speaking, not after.

**`textSignature` phases.** Assistant text blocks reportedly carry
`{v, id, phase}` with `phase: "commentary" | "final_answer"`, and the
UI's extractor prefers `final_answer`. If it holds on our models, it is a
native way to speak the answer and skip running commentary. Unverified —
see "Still unverified".

---

## Speaking the same text twice [SOURCE]

Three distinct ways a speech client double-speaks. All are avoidable and
none are obvious.

**1. Delta accumulation is a hybrid.** `payload.message` is cumulative
(the full text so far — matching our captures); `payload.deltaText` is
incremental. The rule: **append `deltaText`, or replace with `message` —
never append `message`.** Honour `payload.replace === true` as a full
reset. The UI additionally verifies the append against the snapshot and
self-heals to the snapshot on mismatch, which also covers dropped deltas.

**2. `stream: "assistant"` duplicates the `chat` deltas.** The server
emits both; the UI consumes only `chat`. Consuming both speaks
everything twice.

**3. The terminal message repeats the deltas.** When the run finalises,
the full assistant text arrives again. Track a per-run high-water mark of
what has been spoken and speak only the suffix.

---

## Approvals are not on the chat stream [SOURCE]

A blocked run is invisible to a client watching only chat and agent
events — which is why our capture scenarios never triggered one.

Approvals travel as top-level gateway events, `exec.approval.requested`
and `plugin.approval.requested` (scope: `operator.approvals`), and the UI
renders them as an application-shell modal outside the run model
entirely. There is also a `stream: "approval"` agent event, which the UI
ignores.

The run genuinely blocks. The payload carries `command`, `cwd`, `host`,
`agentId`, `sessionKey` and `allowedDecisions`
(`allow-once` / `allow-always` / `deny`), which maps onto a spoken
three-way prompt. Two constraints for voice: there is a hard expiry
(`expiresAtMs`), and `exec.approval.resolved` fires when *any* client
resolves it — so a spoken prompt must be cancellable from another surface
and must not outlive the expiry.

---

## Postmortem: how the third stream stayed invisible for three weeks

Worth reading before any future protocol investigation, because the
failure mode generalizes.

**What happened.** The 2026-05 investigation asked "what does the gateway
send during a run?" and answered it by observing a live dashboard
connection. It found `chat` and `session.message`, characterized both
accurately, and concluded tool data lives in `session.message`. A design
was built on that: scrape transcript blocks, dedupe by id, flush voice on
detection. It shipped and underperformed, and the follow-up branch
(`feat/tool-call-rendering`) built event-capture tooling typed
`(event: 'chat' | 'session.message', ...)` — encoding the two-stream frame
at the type level, so it could not have captured the third stream even by
accident.

**Why observation could not find it.** `stream: "tool"` is delivered only
to connections advertising `caps: ["tool-events"]`. The dashboard did not,
at the time. The handshake reports no error for an unadvertised
capability. There was nothing to see and no failure to notice. Meanwhile
`chat` arrives with no subscription at all, which quietly teaches that
streams show up on their own.

**It was not a version gap.** `session.tool` and `TOOL_EVENTS` both exist
in the earliest commit in our clone (2026-04-08, the clone's root — the
true introduction date is older and not visible). That predates the
investigation by three weeks. The streams were there the whole time.

**It was partly a propagation failure, not only a discovery failure.**
`openclaw-gateway-protocol.md` already listed `session.tool` under "other
event families", and already recorded "declare `caps` or lose tool events
silently". Both facts were written down. Neither reached *this* document,
which is where the design decision was made. Knowledge in the wrong file
is close to no knowledge.

**The transferable rule.** *Empirical black-box observation cannot
discover opt-in streams.* "What the docs don't say" is answerable by
watching your own traffic. "What the system offers that we never asked
for" is not — it requires enumerating the surface independently of usage.
These feel like the same investigation and are not.

So: **enumerate the surface from source first, then observe traffic, then
ask why the difference.** For this gateway that means reading
`client-info.d.ts` (capabilities), `server-broadcast.ts` (event families
and scopes), `server-methods-list.ts` (method and event names), and
`agent-events.ts` (payload types) *before* drawing conclusions from a
capture. Doing that would have made this a five-minute finding.

---

## See also

- `openclaw-gateway-protocol.md` — RPC catalog, `chat` event shape,
  framing, capability gating
- `gateway-session-lifecycle.md` — session lifecycle, `chat.send` semantics
- [`/gateway/clients`](https://docs.openclaw.ai/gateway/clients) — official
  client-building guide; documents caps and pairing
