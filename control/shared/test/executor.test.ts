import { describe, it, expect, beforeEach } from "bun:test";
import {
  submit,
  isPending,
  clearExecutor,
  type LifecycleOp,
  type TaskResult,
} from "../src/executor";

// The executor serializes lifecycle work on one node-wide lane. These tests
// drive it with synthetic tasks rather than real starts: what is under test is
// ordering, admission, coalescing and deadlines, none of which depend on what a
// task actually does. Tests that assert on real start/stop behaviour live in
// lifecycle.test.ts.

// A controllable task: resolves only when its gate is opened, so a test can
// hold the lane and observe what happens to work submitted behind it.
function gate() {
  let open!: (value?: unknown) => void;
  let fail!: (err: unknown) => void;
  const promise = new Promise((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  return { promise, open, fail };
}

beforeEach(() => {
  clearExecutor();
});

// ═════════════════════════════════════════════════════════════════════════════
// Serialization — the lane
// ═════════════════════════════════════════════════════════════════════════════

describe("executor — one lane per node", () => {
  it("runs tasks for different services one at a time, never overlapping", async () => {
    let running = 0;
    let maxConcurrent = 0;
    const task = async () => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise(r => setTimeout(r, 5));
      running--;
      return { ok: true };
    };

    await Promise.all([
      submit("svc-a", "start", task),
      submit("svc-b", "start", task),
      submit("svc-c", "start", task),
    ]);

    expect(maxConcurrent).toBe(1);
  });

  it("two serve-enabled services started together never overlap their serve writes", async () => {
    // The observed bug: concurrent tailscale serve writes lose an etag race.
    // Model the serve config as a resource that records overlapping access.
    let inServeWrite = false;
    let overlapped = false;
    const serveWritingTask = async () => {
      if (inServeWrite) overlapped = true;
      inServeWrite = true;
      await new Promise(r => setTimeout(r, 5));
      inServeWrite = false;
      return { ok: true };
    };

    await Promise.all([
      submit("tts", "start", serveWritingTask),
      submit("stt", "start", serveWritingTask),
    ]);

    expect(overlapped).toBe(false);
  });

  it("runs queued tasks in submission order", async () => {
    const order: string[] = [];
    const make = (id: string) => async () => {
      order.push(id);
      return { ok: true };
    };

    await Promise.all([
      submit("a", "start", make("a")),
      submit("b", "start", make("b")),
      submit("c", "start", make("c")),
    ]);

    expect(order).toEqual(["a", "b", "c"]);
  });

  it("a task that throws does not prevent the next task from running", async () => {
    let secondRan = false;

    const first = submit("a", "start", async () => {
      throw new Error("boom");
    });
    const second = submit("b", "start", async () => {
      secondRan = true;
      return { ok: true };
    });

    await first.catch(() => {});
    await second;

    expect(secondRan).toBe(true);
  });

  it("reports the error from a task that throws, rather than swallowing it", async () => {
    const result = await submit("a", "start", async () => {
      throw new Error("spawn failed");
    }).catch((err: unknown) => err);

    expect(String(result)).toContain("spawn failed");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Admission — pending
// ═════════════════════════════════════════════════════════════════════════════

describe("executor — pending", () => {
  it("a service with a task queued reports pending before that task begins running", async () => {
    const held = gate();
    const blocking = submit("blocker", "start", async () => {
      await held.promise;
      return { ok: true };
    });

    // Submitted while the lane is occupied, so this one is queued, not running.
    const queued = submit("waiting", "start", async () => ({ ok: true }));

    expect(isPending("waiting")).toBe(true);

    held.open();
    await blocking;
    await queued;
  });

  it("marks a service pending synchronously, before submit's promise settles", () => {
    // The shard's start route returns 202 immediately and the dashboard polls
    // straight after. If pending were set asynchronously the first poll could
    // land in the gap and read the service as idle and unhealthy — the bare
    // "failed to start" bug.
    const held = gate();
    void submit("svc", "start", async () => {
      await held.promise;
      return { ok: true };
    });

    expect(isPending("svc")).toBe(true);
    held.open();
  });

  it("clears pending once the task resolves", async () => {
    await submit("svc", "start", async () => ({ ok: true }));
    expect(isPending("svc")).toBe(false);
  });

  it("clears pending when the task throws", async () => {
    await submit("svc", "start", async () => {
      throw new Error("boom");
    }).catch(() => {});

    expect(isPending("svc")).toBe(false);
  });

  it("a service with no submitted work is not pending", () => {
    expect(isPending("never-touched")).toBe(false);
  });

  it("pending is per service — one service's work does not mark another pending", () => {
    const held = gate();
    void submit("busy-one", "start", async () => {
      await held.promise;
      return { ok: true };
    });

    expect(isPending("busy-one")).toBe(true);
    expect(isPending("other")).toBe(false);

    held.open();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Coalescing
// ═════════════════════════════════════════════════════════════════════════════

describe("executor — coalescing", () => {
  it("a second start submitted against a queued start produces one execution", async () => {
    const held = gate();
    const blocking = submit("blocker", "start", async () => {
      await held.promise;
      return { ok: true };
    });

    let executions = 0;
    const task = async () => {
      executions++;
      return { ok: true };
    };

    const first = submit("svc", "start", task);
    const second = submit("svc", "start", task);

    held.open();
    await blocking;
    await Promise.all([first, second]);

    expect(executions).toBe(1);
  });

  it("both callers of a coalesced start receive the surviving task's outcome", async () => {
    const held = gate();
    const blocking = submit("blocker", "start", async () => {
      await held.promise;
      return { ok: true };
    });

    const first = submit("svc", "start", async () => ({ ok: true, endpoint: "from-survivor" }));
    const second = submit("svc", "start", async () => ({ ok: true, endpoint: "from-survivor" }));

    held.open();
    await blocking;

    expect(await first).toEqual(await second);
  });

  it("a stop replacing a queued start runs the stop, not the start", async () => {
    const held = gate();
    const blocking = submit("blocker", "start", async () => {
      await held.promise;
      return { ok: true };
    });

    const ran: LifecycleOp[] = [];
    const first = submit("svc", "start", async () => {
      ran.push("start");
      return { ok: true };
    });
    const second = submit("svc", "stop", async () => {
      ran.push("stop");
      return { ok: true };
    });

    held.open();
    await blocking;
    await Promise.all([first, second]);

    expect(ran).toEqual(["stop"]);
  });

  it("three rapid submissions while queued collapse to the last one", async () => {
    const held = gate();
    const blocking = submit("blocker", "start", async () => {
      await held.promise;
      return { ok: true };
    });

    const ran: LifecycleOp[] = [];
    const make = (op: LifecycleOp) => async () => {
      ran.push(op);
      return { ok: true };
    };

    const a = submit("svc", "start", make("start"));
    const b = submit("svc", "stop", make("stop"));
    const c = submit("svc", "start", make("start"));

    held.open();
    await blocking;
    await Promise.all([a, b, c]);

    expect(ran).toEqual(["start"]);
  });

  it("a task submitted against an executing task queues rather than replacing it", async () => {
    // Once work is in flight it cannot be retargeted: both must run.
    const held = gate();
    const ran: LifecycleOp[] = [];

    const executing = submit("svc", "start", async () => {
      ran.push("start");
      await held.promise;
      return { ok: true };
    });

    const behind = submit("svc", "stop", async () => {
      ran.push("stop");
      return { ok: true };
    });

    held.open();
    await executing;
    await behind;

    expect(ran).toEqual(["start", "stop"]);
  });

  it("a stop submitted behind a running start executes after that start completes", async () => {
    const order: string[] = [];
    const held = gate();

    const starting = submit("svc", "start", async () => {
      await held.promise;
      order.push("start-finished");
      return { ok: true };
    });
    const stopping = submit("svc", "stop", async () => {
      order.push("stop-began");
      return { ok: true };
    });

    held.open();
    await starting;
    await stopping;

    expect(order).toEqual(["start-finished", "stop-began"]);
  });

  it("keeps a service pending from first submission through the coalesced task", async () => {
    const held = gate();
    const blocking = submit("blocker", "start", async () => {
      await held.promise;
      return { ok: true };
    });

    const first = submit("svc", "start", async () => ({ ok: true }));
    expect(isPending("svc")).toBe(true);
    const second = submit("svc", "start", async () => ({ ok: true }));
    expect(isPending("svc")).toBe(true);

    held.open();
    await blocking;
    await Promise.all([first, second]);

    expect(isPending("svc")).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Meaningfulness — a request that would not change state does not act
// ═════════════════════════════════════════════════════════════════════════════

describe("executor — meaningfulness", () => {
  it("a task reporting no state change resolves successfully without acting", async () => {
    let acted = false;
    const result = await submit(
      "svc",
      "start",
      async () => {
        acted = true;
        return { ok: true };
      },
      { wouldChangeState: async () => false }
    );

    expect(acted).toBe(false);
    expect(result.ok).toBe(true);
  });

  it("a task reporting a state change runs normally", async () => {
    let acted = false;
    await submit(
      "svc",
      "start",
      async () => {
        acted = true;
        return { ok: true };
      },
      { wouldChangeState: async () => true }
    );

    expect(acted).toBe(true);
  });

  it("evaluates the state check at execution, not at submission", async () => {
    // A stop queued behind a start is a no-op against the state at submission
    // and meaningful by the time it runs. Evaluating early would discard it.
    let serviceRunning = false;
    const held = gate();

    const starting = submit(
      "svc",
      "start",
      async () => {
        await held.promise;
        serviceRunning = true;
        return { ok: true };
      },
      { wouldChangeState: async () => !serviceRunning }
    );

    let stopActed = false;
    const stopping = submit(
      "svc",
      "stop",
      async () => {
        stopActed = true;
        return { ok: true };
      },
      { wouldChangeState: async () => serviceRunning }
    );

    held.open();
    await starting;
    await stopping;

    expect(stopActed).toBe(true);
  });

  it("runs the task when no state check is supplied", async () => {
    let acted = false;
    await submit("svc", "start", async () => {
      acted = true;
      return { ok: true };
    });

    expect(acted).toBe(true);
  });

  it("releases the lane after skipping a no-op, so later work still runs", async () => {
    let laterRan = false;

    await submit("svc", "start", async () => ({ ok: true }), {
      wouldChangeState: async () => false,
    });
    await submit("other", "start", async () => {
      laterRan = true;
      return { ok: true };
    });

    expect(laterRan).toBe(true);
  });

  it("clears pending after skipping a no-op", async () => {
    await submit("svc", "start", async () => ({ ok: true }), {
      wouldChangeState: async () => false,
    });

    expect(isPending("svc")).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Task deadline
// ═════════════════════════════════════════════════════════════════════════════

// A deadline expiry resolves as a failed result rather than rejecting. A start
// that runs out of time is a failed start, not an exceptional condition, and
// every caller already branches on `ok` — a rejection would skip the branch
// that records the failure, leaving the service with no event and the dashboard
// reporting a bare "failed to start".
describe("executor — task deadline", () => {
  it("a task exceeding its deadline releases the lane", async () => {
    const never = gate();
    let laterRan = false;

    const stuck = submit(
      "stuck",
      "start",
      async () => {
        await never.promise;
        return { ok: true };
      },
      { deadlineMs: 20 }
    );

    const later = submit("later", "start", async () => {
      laterRan = true;
      return { ok: true };
    });

    await stuck;
    await later;

    expect(laterRan).toBe(true);

    never.open();
  });

  it("reports a deadline expiry as a failed result naming the timeout", async () => {
    const never = gate();

    // Annotated so the callback's lone `{ ok: true }` return does not narrow
    // the submission's type to that literal: the deadline path resolves with a
    // failure, which is a different shape than this task would have produced.
    const result = await submit(
      "stuck",
      "start",
      async (): Promise<TaskResult> => {
        await never.promise;
        return { ok: true };
      },
      { deadlineMs: 20 }
    );

    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("deadline");

    never.open();
  });

  it("does not reject when a deadline expires, so a caller's failure branch runs", async () => {
    const never = gate();
    let rejected = false;

    await submit(
      "stuck",
      "start",
      async () => {
        await never.promise;
        return { ok: true };
      },
      { deadlineMs: 20 }
    ).catch(() => { rejected = true; });

    expect(rejected).toBe(false);

    never.open();
  });

  it("clears pending when a task's deadline expires", async () => {
    const never = gate();

    await submit(
      "stuck",
      "start",
      async () => {
        await never.promise;
        return { ok: true };
      },
      { deadlineMs: 20 }
    );

    expect(isPending("stuck")).toBe(false);

    never.open();
  });

  it("a task settling after its deadline does not clear pending for later work", async () => {
    // The abandoned task is still running. If its completion releases state by
    // service id, it clears the pending flag belonging to whatever was
    // submitted after it — a naive .finally(release) does exactly this.
    const late = gate();

    await submit(
      "svc",
      "start",
      async () => {
        await late.promise;
        return { ok: true };
      },
      { deadlineMs: 20 }
    );

    const held = gate();
    void submit("svc", "start", async () => {
      await held.promise;
      return { ok: true };
    });

    expect(isPending("svc")).toBe(true);

    // The abandoned first task now finishes, late.
    late.open();
    await new Promise(r => setTimeout(r, 10));

    expect(isPending("svc")).toBe(true);

    held.open();
  });

  it("does not time out a task that finishes inside its deadline", async () => {
    const result = await submit(
      "svc",
      "start",
      async () => {
        await new Promise(r => setTimeout(r, 5));
        return { ok: true };
      },
      { deadlineMs: 500 }
    );

    expect(result.ok).toBe(true);
  });
});
