# Lifecycle executor — serializing service operations on a node

Every path that starts or stops a service reaches the same two shared resources: the node's Tailscale Serve configuration, and the service's own process. Neither tolerates concurrent writers.

A single executor carries all lifecycle work on both the control plane and the shard. This describes the invariants it enforces and the parameter resolution that feeds it. What it does is documented in [`docs/components/service-lifecycle.md`](../components/service-lifecycle.md).

---

## 1. What it guarantees

Two failures follow from letting lifecycle callers reach those resources unserialized, and the executor exists to rule both out. They arise on the shard when voice mode starts its TTS and STT services together.

**Serve registrations never overlap.** `tailscale serve` writes the node's whole serve configuration behind an etag. Two registrations in flight means one reads a configuration the other has already replaced, and the loser fails with `Preconditions failed: etag mismatch`. The configuration is per-node, so no per-service lock prevents it; the executor's one lane per node does.

**A start in progress reports pending for its whole duration.** The shard's demand-load route returns 202 and runs the start in the background. The route submits the start to the executor before it writes the 202, and the executor holds the service pending from submission until the task settles, so the dashboard never sees not-pending and unhealthy in the middle of a start. A client that read that combination as a definitive failure would take a stale `lastEvent` from the previous stop as the reason and report `failed to start`. Failure reporting and state mutation run once per submission, whatever the number of callers awaiting it.

The second guarantee involves no Tailscale call, so it cannot be had by serializing Serve writes alone.

## 2. How callers reach the executor

Every path that starts or stops a service calls `submit(serviceId, kind, task, { deadlineMs })` from [`executor.ts`](../../control/shared/src/executor.ts):

| Caller | Submits |
|---|---|
| Shared HTTP start/stop/restart routes ([api.ts](../../control/shared/src/api.ts)) | `start`, `stop`, `restart` |
| `shardStartup` ([control-shard/src/lifecycle.ts](../../control/control-shard/src/lifecycle.ts)) | `start` for each auto-start service |
| `loadService` ([control-shard/src/index.ts](../../control/control-shard/src/index.ts)) — the demand-load route | `start` |
| `unloadService` ([control-shard/src/index.ts](../../control/control-shard/src/index.ts)) — the unload route and idle eviction | `stop` |
| Crash recovery (`handleProcessExit`, [shared/src/lifecycle.ts](../../control/shared/src/lifecycle.ts)) | `start`, after the backoff wait |

Because the control plane has no lifecycle callers beyond the shared routes, those routes cover it entirely.

External writers do not arise from Banter's own code: `shard-runner` writes Serve only for the shard's own port, at boot and at shutdown ([shard-runner.swift](../../control/control-shard/ops/shard-runner.swift)), never a service port. Serializing within the process is therefore sufficient against Banter's own writers. Retry (§6) covers writers outside it.

One writer stays outside the lane: `handleProcessExit` removes a crashed service's Serve entry before deciding whether to restart it. Where a restart follows, the removal is redundant with the start sequence's own stale-entry teardown, which runs inside the lane. Where the restart budget is exhausted and none follows, it is an unserialized removal — narrow enough to leave, since pulling a crash-backoff wait inside a lane-holding task trades one contention for another.

## 3. The executor

**Role.** One component per node owns the execution of every lifecycle operation. Callers submit a task and await its outcome; the executor decides when it runs.

**Ownership.** It exclusively owns the ordering of lifecycle work and the state the API reports as `pending`. No production caller invokes `startService` or `stopService` directly.

**Granularity: one lane per node.** All lifecycle tasks run one at a time, node-wide, rather than one lane per service. The serve configuration is a single per-node resource, so nothing finer serializes it. Voice mode's two services consequently start in sequence; this is the reason not to reintroduce parallelism there.

**Task vocabulary.** Start, stop, restart. A restart is one task rather than a stop and a start enqueued separately, so nothing interleaves between its halves.

Enable and disable are not lifecycle tasks. They write `permissions.enabled` in the registry — configuration, not run state — and touch neither the process nor the Serve configuration. They keep their existing path through the registry's atomic write.

**Admission is synchronous.** A task is enqueued, and the service marked pending, before its caller's HTTP response is written. This is what makes the second failure impossible: the shard's fire-and-forget route returns 202 with the service already pending, so the dashboard's first poll cannot land in a gap between accepting a start and beginning it.

**Failure isolation.** A task that throws completes its lane and lets the next run. A rejected task never wedges the node.

## 4. `pending`

The API field is `pending`, replacing `locked`. It describes the request, not the service: a submitted operation is outstanding, whether queued or executing. `busy` would describe the service as occupied, which is a different claim and not the one consumers need.

Locking remains the internal mechanism — `acquireLock`, `releaseLock`, `clearLocks` keep their names. The state is what a caller observes; the lock is how the executor produces it.

`pending` is false for `external` runners always. The platform cannot start or stop them, so no lifecycle work can be outstanding.

Queued and executing are deliberately not distinguished. A caller waiting on an operation needs to know whether it is still outstanding; which half of outstanding it occupies changes nothing it would do.

A client waits while `pending` is true, then reads health once it clears. These are two questions — is anything still running, and is the service usable — and asking them in sequence keeps each answer bounded to what it can actually establish. Health read mid-operation describes a service the platform is still working on.

The operation's bound is the executor's task deadline, derived per service from `startupTime`. A client holds no deadline of its own on how long an operation may take, since a browser-side constant cannot know which service it is starting and would abandon a slow model still legitimately coming up. Waiting is therefore unbounded in that dimension, which is what makes `pending` load-bearing: only an explicit `true` continues the wait, so a field the client never receives ends it.

That places a matching obligation on the API: `pending` is always present on a live response, and a route that cannot establish it answers 503 rather than guessing. `GET /api/services/:id` therefore reads live from the owning node and never falls back to the poller's cache, whose records predate the request and come from the list route. A caller wanting last-known state reads `GET /api/services`, which is honestly a cache.

The one bound a client does hold is on contact, not duration: a read that fails says nothing about the operation, so the wait rides out unanswered reads for a grace period and then fails naming the transport. The server cannot own this bound, because it applies exactly when the server cannot be reached.

## 5. Coalescing and meaningfulness

A request is worth running if it would change the service's run state. One criterion governs both coalescing and the operations that arrive alone.

**One pending slot per service.** A task arriving while another for the same service is still queued replaces it, so rapid start/stop/start settles to a single start rather than three sequential operations. Replacement applies only while the earlier task is queued; once executing, a new request queues behind it, because work in flight cannot be retargeted.

**Meaningfulness is checked at execution, not submission.** A stop queued behind a running start changes nothing against the state at submission and changes a great deal by the time it runs. The executor holds the lane while it checks, so nothing moves underneath the check.

A start that would leave the service where it already is resolves as a success without restarting it.

**The check belongs inside the lifecycle functions, not in front of them.** `startService`'s fast path already performs it: it probes localhost, and on finding the service healthy either adopts it or repairs a missing Serve entry first. Only that code sees live state. Derived health cannot substitute — a service whose last event is `service.up` but whose Serve entry has since vanished still reads as healthy, so an executor-level gate reading derived health would skip the repair entirely until the next health sweep, fifteen minutes later by default.

The executor therefore serializes, coalesces and reports pending; it does not itself decide whether an operation is meaningful. A caller may supply a state check where it has one the lifecycle function lacks, and the executor honours it, but no caller does.

An adopted or repaired service still emits `service.up`, carrying `alreadyRunning` and, where a Serve entry was rebuilt, `serveRepaired`. A no-op is silent only where nothing was inspected or changed.

Coalescing is by position, not by intent: whatever sits in the queued slot is replaced, whether or not the two requests agree. A stop queued behind a busy lane and then followed by a start settles as a start alone — the stop never runs. This keeps the rule dumb enough to reason about, at the cost of making a rapid stop-then-start indistinguishable from a start. `restart` exists as a single task for the case where both halves must happen.

Every caller whose task was replaced awaits the surviving task and receives its outcome. No caller is left holding a promise that never settles, which matters for any caller whose result gates further work, such as a demand-load.

## 6. Tailscale Serve retry

Serve registration and removal each retry up to three attempts, with a short fixed delay between them.

Retry covers writers the executor cannot serialize — an operator at a terminal, a Tailscale client update, anything outside the platform process. Serialization removes the collisions the platform causes; retry covers the rest. The etag error is the shape retry suits: the loser's read is stale, and a second attempt re-reads.

Both directions retry. A failed removal writes the same configuration behind the same etag and can lose the same race; a stale entry that fails to clear causes trouble later.

A write that exits zero but fails its verification probe retries as well. That is the same lost race, not a different failure.

When attempts fail with differing errors, all distinct messages are reported. Two etag mismatches indicate contention; an etag mismatch followed by `tailscaled not running` means the first failure was incidental and the real problem lies elsewhere. Collapsing them loses the distinction that tells the operator which.

## 7. Outcome reporting

A start with `tailscaleServe` produces two outcomes a consumer must distinguish: the process came up, and the service is reachable over Tailscale. The start keeps the two apart; a start whose registration fails does not tear down the process it just started ([lifecycle.ts](../../control/shared/src/lifecycle.ts)).

A process that started successfully stays running when only its Serve registration failed. The service is reported as degraded — the state the platform already models for exactly this condition, emitted by the health checker when localhost answers and Tailscale does not — and the registration can be retried without restarting the process.

The recorded outcome names the stage that failed. A failed spawn and a failed registration call for different remedies, and `failed to start` describes neither.

**Voice mode does not start against a degraded service.** The dashboard reaches a service over its Tailscale endpoint, which is precisely what a failed registration leaves broken, so degraded is unusable for that caller whatever the process is doing. Once the operation settles, anything short of healthy fails the caller, carrying the serve error rather than a bare start failure. A caller reaching the same service over loopback — a request from the shard itself — is unaffected, which is why the process stays running.

**Both Serve-registration paths follow this rule.** `startService` writes Serve in two places: at the end of the full start sequence, and in the fast path, where a service found already running with a missing entry has its registration repaired and the existing process adopted. A failed repair is the same condition as a failed registration — more plainly so, since there the process was healthy before the platform touched it — and reporting it as a failed start would have the shard record `service.down` for a service answering on loopback.

The crash-restart budget resets on both. The budget counts consecutive failed recoveries; a start that leaves a healthy process running is not one, whatever happened to its Serve entry.

## 8. Execution parameters

`runFn` and `spawnFn` are invocation styles: one awaits completion and returns output, the other returns a handle to a process that keeps running. They carry no policy. Durations reach them as resolved parameters.

Resolution happens where it already does. `validateRegistry` merges `{...defaults.lifecycle, ...svc.lifecycle}` at load, so a service declaring nothing inherits the registry default and a service declaring a value overrides it. Consumers read the merged field without knowing which applied.

What a declared value adds is an override: a service, or a registry, can state a duration the platform then honours. The code-level constant behind it stays as the floor.

Keeping it is not untidiness. `startService` and `stopService` are called directly — by tests that deliberately bypass the registry, and by any future caller holding a `Service` it did not load through `validateRegistry`. A function that returns `NaN` for a service assembled by hand is worse than one carrying a sane default, and validation cannot reach a path that never passes through it.

So `svc.lifecycle?.startupTime ?? DEFAULT_STARTUP_TIME` keeps both halves: the declaration wins where present, the constant answers where nothing was declared.

**Which durations are worth declaring** is decided by whether anyone would plausibly set them per service. `startupTime` earns it — a model server taking two minutes is a fact about that service. The Serve retry count and delay earn it at registry level, since Serve contention is a property of a node. The already-running probe, the managed-stop confirmation, and the health fetch do not: they describe how one probe is issued, they are identical for every service, and declaring them adds a knob nobody turns.

**The command timeout is node-level, not per-service.** `createRunFn` fixes its timeout when the function is built, because killing the child requires the timer to live inside the closure that owns it. Threading a per-service duration would mean giving `RunFn` a per-call argument and rebuilding it per task, which changes a type every call site depends on to express something no service needs differently. One node-wide value, declared once.

`config.json` keeps voice and integrations. The sweep cadences stay there too: `resolveRuntimeSettings` reads config and environment and has no registry access, and giving it one is a refactor with its own test surface rather than part of this work.

## 9. Timeouts

Two independent durations, both declared.

**Command timeout.** `runFn` awaits `proc.exited` with nothing bounding it, so a `tailscale` invocation blocked on a wedged `tailscaled` waits indefinitely. Under one lane per node, that stalls every service on the machine. A command exceeding its timeout is killed and returns non-zero with a stderr saying so; every caller already handles non-zero exits. `spawnFn` is untouched — a process runner's service is long-lived by design, and `exited` on its handle is what crash detection watches.

For `systemd` and `launchd` runners the timeout bounds the *command*, not the service it launches: `systemctl start` returns once the unit is started, and a hang there indicates a problem with systemd rather than a slow service.

**Task deadline.** Derived per task from the service's `startupTime` plus headroom for the command steps around the health poll — the stop command, serve teardown, and registration with its retries. Services declare 30s to 120s today, so a single fixed node-wide deadline would either strangle the slow models or let a stuck fast service hold the lane for minutes.

On expiry the executor abandons the task and releases the lane, resolving the submission as a failed result rather than raising. A start that runs out of time is a failed start, and every caller already distinguishes success from failure by inspecting the result. Raising instead would skip the branch that records what happened, leaving the service with no event and the dashboard reporting a bare start failure — the condition §1 describes.

Abandoning is not cancelling. The underlying work may still be running, and a process mid-spawn may come up after the failure is recorded. This is self-correcting: the next start's fast path probes localhost, finds it healthy, and adopts the running process. Genuine cancellation would require the work to be interruptible at every await, which is disproportionate for a case that resolves itself.

A task holds the lane until it resolves or its deadline passes. There is no heartbeat or incremental-progress signal — the operations are short, their internal polls bound themselves, and the command timeout addresses the hang directly.

## 10. Direct use of `startService` and `stopService`

`startService` and `stopService` are exported. Tests drive them directly, and production callers reach them only through the executor (§2), which schedules them.

## 11. Shared helpers

[`control/shared/src/exec.ts`](../../control/shared/src/exec.ts) defines the three process-and-network helpers that the control plane and the shard both build, one definition each:

- `createRunFn({ timeoutMs })` returns a `RunFn` that runs a command to completion and returns its stdout, stderr and exit code. With `timeoutMs` set, a command still running at the deadline is killed and reported as a failed command (exit code non-zero, a "command timed out" line in stderr) so it cannot block the lane indefinitely. This is the command timeout's single home.
- `createSpawnFn()` returns a `SpawnFn` that starts a long-running process and returns a handle with `kill` and `exited`. When `logDir` is given, stdout and stderr append to `stdout.log` and `stderr.log` there, so a restart continues the same files; the install scripts pre-create the directory. It has no timeout: a process runner's service is long-lived, and crash detection watches `exited`.
- `createPollHealthFn()` returns a `PollHealthFn` that polls a URL once a second, each request bounded at five seconds, until it answers OK (or answers at all, with `acceptsAnyResponse`) or the timeout elapses.

`RunFn` and `SpawnFn` stay separate: the await-versus-handle distinction is what callers need, and merging them would move that fork into every call site. Because the module has no side effects on import, the helpers are testable, unlike module-scope constants in files that bind ports.

## 12. Behavioural contracts

- Two Serve-enabled services started together never overlap their Serve writes.
- A service with a task queued reports pending before that task begins running.
- A service with an `external` runner never reports pending.
- A second start submitted against a queued start produces one execution, and both callers receive its outcome.
- A task submitted against an *executing* task queues rather than replacing it.
- A stop submitted behind a running start executes after that start completes.
- A start against an already-running service adopts it rather than restarting it, emitting `service.up` with `alreadyRunning`.
- A start against a running service whose Serve entry is missing repairs the entry and adopts the process, emitting `service.up` with `serveRepaired`.
- A stop queued behind a busy lane and then followed by a start settles as a start alone: the queued slot holds one task, and the later submission replaces it.
- A crash during a pending or executing operation on the same service is recorded, and recovery is skipped.
- A task that throws does not prevent the next task from running.
- Idle eviction cannot begin while a start for the same service is in flight.
- A Serve write failing with an etag mismatch is retried, and succeeds without operator action when the competing write has landed.
- Three failed Serve attempts with differing errors report all distinct messages.
- A start whose process is healthy but whose Serve registration fails leaves the process running and reports degraded.
- A command exceeding its timeout is killed and reported as a failed command, and the lane continues.
- A task exceeding its deadline releases the lane.
- A service declaring `startupTime` is polled for that duration, not the registry default.
