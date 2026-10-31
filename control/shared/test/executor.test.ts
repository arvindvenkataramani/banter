// The node's single lifecycle lane: ordering, coalescing, pending, deadlines.

import { describe, it, expect, beforeEach } from "bun:test";
import { submit, isPending, clearExecutor, type LifecycleOp, type TaskResult } from "../src/executor";

/** A promise a test opens when it chooses. */
function gate() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}

/** Occupies the lane until the returned gate opens, so later submissions stay queued. */
function blockLane() {
  const held = gate();
  const done = submit("blocker", "start", async () => { await held.promise; return { ok: true }; });
  return { release: async () => { held.open(); await done; } };
}

beforeEach(() => {
  clearExecutor();
});

describe("one lane per node", () => {
  it("runs tasks one at a time in submission order, across services", async () => {
    let running = 0;
    let maxRunning = 0;
    const order: string[] = [];
    const task = (id: string) => async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise(r => setTimeout(r, 5));
      order.push(id);
      running--;
      return { ok: true };
    };

    await Promise.all(["a", "b", "c"].map(id => submit(id, "start", task(id))));
    expect(maxRunning).toBe(1);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("passes on the error from a task that throws, and keeps running later work", async () => {
    const failed = submit("a", "start", async () => { throw new Error("boom"); }).catch((err: unknown) => err);
    const later = submit("b", "start", async () => ({ ok: true }));
    expect(String(await failed)).toContain("boom");
    expect((await later).ok).toBe(true);
  });
});

describe("pending", () => {
  it("marks a service pending synchronously on submit, for that service only, until its task settles", async () => {
    const lane = blockLane();
    const queued = submit("svc", "start", async () => ({ ok: true }));
    expect(isPending("svc")).toBe(true);
    expect(isPending("other")).toBe(false);

    await lane.release();
    await queued;
    expect(isPending("svc")).toBe(false);
  });

  it("clears pending when the task throws", async () => {
    await submit("svc", "start", async () => { throw new Error("boom"); }).catch(() => {});
    expect(isPending("svc")).toBe(false);
  });
});

describe("coalescing", () => {
  it("collapses requests queued for one service to the last, which every caller then shares", async () => {
    const lane = blockLane();
    const ran: LifecycleOp[] = [];
    const op = (name: LifecycleOp) => async () => { ran.push(name); return { ok: true, ran: name }; };

    const calls = [submit("svc", "start", op("start")), submit("svc", "stop", op("stop")), submit("svc", "start", op("start"))];
    expect(isPending("svc")).toBe(true);
    await lane.release();

    expect(await Promise.all(calls)).toEqual(Array(3).fill({ ok: true, ran: "start" }));
    expect(ran).toEqual(["start"]);
  });

  it("queues a request behind the service's executing task rather than replacing it", async () => {
    const held = gate();
    const order: string[] = [];
    const starting = submit("svc", "start", async () => { await held.promise; order.push("start finished"); return { ok: true }; });
    const stopping = submit("svc", "stop", async () => { order.push("stop began"); return { ok: true }; });

    held.open();
    await Promise.all([starting, stopping]);
    expect(order).toEqual(["start finished", "stop began"]);
  });
});

describe("task deadline", () => {
  it("fails a task that overruns, naming the deadline, and frees the lane and pending for later work", async () => {
    const never = gate();
    const stuck = submit("svc", "start", async (): Promise<TaskResult> => { await never.promise; return { ok: true }; }, { deadlineMs: 20 });
    const later = submit("other", "start", async () => ({ ok: true }));

    const result = await stuck;
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("deadline");
    expect(isPending("svc")).toBe(false);
    expect((await later).ok).toBe(true);
    never.open();
  });

  it("does not let an abandoned task, finishing late, clear pending for work submitted after it", async () => {
    const late = gate();
    await submit("svc", "start", async () => { await late.promise; return { ok: true }; }, { deadlineMs: 20 });

    const held = gate();
    void submit("svc", "start", async () => { await held.promise; return { ok: true }; });
    late.open();
    await new Promise(r => setTimeout(r, 10));

    expect(isPending("svc")).toBe(true);
    held.open();
  });

  it("leaves a task that finishes inside its deadline alone", async () => {
    const result = await submit("svc", "start", async () => { await new Promise(r => setTimeout(r, 5)); return { ok: true }; }, { deadlineMs: 500 });
    expect(result.ok).toBe(true);
  });
});
