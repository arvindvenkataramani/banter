export type LifecycleOp = "start" | "stop" | "restart";

export type TaskResult = { ok: boolean; [key: string]: unknown };

export type SubmitOpts = {
  deadlineMs?: number;
  wouldChangeState?: () => Promise<boolean>;
};

type Resolver<T> = { resolve: (value: T) => void; reject: (err: unknown) => void };

// A queued task's work can be replaced by a later submission for the same
// service; every caller whose submission landed on this entry, past and
// present, is recorded here and settled together once the surviving task
// resolves.
type Entry = {
  id: number;
  serviceId: string;
  op: LifecycleOp;
  task: () => Promise<TaskResult>;
  opts?: SubmitOpts;
  resolvers: Resolver<TaskResult>[];
};

let nextId = 1;

// Bumped by clearExecutor. A task claimed under an earlier generation that
// settles after a reset must not touch the lane or maps a later generation
// owns — captured at claim time and checked before every mutation.
let generation = 0;

// The lane itself: entries waiting their turn, in submission order. The
// front of the queue is the entry currently executing (or about to start) —
// it is removed from here the instant it is claimed, synchronously, so no
// later submission in the same tick can mistake it for still queued.
const laneQueue: Entry[] = [];
let laneRunning = false;

// The entry currently queued (not yet claimed) for a service, if any — the
// target coalescing replaces. A service's claimed/executing entry is never
// in this map.
const queuedByService = new Map<string, Entry>();

// The entry a service's pending state currently belongs to. An abandoned
// task settling late must only clear this if it still owns the entry —
// otherwise it would clear pending for whatever was submitted after it.
const pendingByService = new Map<string, number>();

export function submit<T extends TaskResult>(
  serviceId: string,
  op: LifecycleOp,
  task: () => Promise<T>,
  opts?: SubmitOpts
): Promise<T> {
  const existing = queuedByService.get(serviceId);
  if (existing) {
    existing.op = op;
    existing.task = task as () => Promise<TaskResult>;
    existing.opts = opts;
    return new Promise<T>((resolve, reject) => {
      existing.resolvers.push({ resolve: resolve as (value: TaskResult) => void, reject });
    });
  }

  const entry: Entry = {
    id: nextId++,
    serviceId,
    op,
    task: task as () => Promise<TaskResult>,
    opts,
    resolvers: [],
  };
  const result = new Promise<T>((resolve, reject) => {
    entry.resolvers.push({ resolve: resolve as (value: TaskResult) => void, reject });
  });

  queuedByService.set(serviceId, entry);
  pendingByService.set(serviceId, entry.id);
  laneQueue.push(entry);

  pump();

  return result;
}

// Advances the lane synchronously when it is idle: claiming the next entry
// (removing it from queuedByService so it is no longer a coalescing target)
// happens in the same tick as the submission that made it the front of the
// queue, before control returns to the caller. Running the task itself is
// asynchronous, as it must be.
function pump(): void {
  if (laneRunning) return;
  const entry = laneQueue.shift();
  if (!entry) return;

  laneRunning = true;
  if (queuedByService.get(entry.serviceId) === entry) {
    queuedByService.delete(entry.serviceId);
  }

  const claimedGeneration = generation;
  runEntry(entry, claimedGeneration).finally(() => {
    if (generation !== claimedGeneration) return;
    laneRunning = false;
    pump();
  });
}

async function runEntry(entry: Entry, claimedGeneration: number): Promise<void> {
  const settle = (fn: (r: Resolver<TaskResult>) => void) => {
    for (const resolver of entry.resolvers) fn(resolver);
    if (generation !== claimedGeneration) return;
    if (pendingByService.get(entry.serviceId) === entry.id) {
      pendingByService.delete(entry.serviceId);
    }
  };

  if (entry.opts?.wouldChangeState) {
    let wouldChange: boolean;
    try {
      wouldChange = await entry.opts.wouldChangeState();
    } catch (err) {
      settle(r => r.reject(err));
      return;
    }
    if (!wouldChange) {
      settle(r => r.resolve({ ok: true }));
      return;
    }
  }

  const deadlineMs = entry.opts?.deadlineMs;
  if (deadlineMs === undefined) {
    try {
      const result = await entry.task();
      settle(r => r.resolve(result));
    } catch (err) {
      settle(r => r.reject(err));
    }
    return;
  }

  let settled = false;
  let timer: ReturnType<typeof setTimeout>;
  // A deadline expiry resolves as a failed TaskResult rather than rejecting.
  // A start that runs out of time is a failed start, not an exceptional
  // condition, and every caller already branches on `ok` — a rejection would
  // skip that branch, leaving the service with no recorded failure.
  const deadline = new Promise<TaskResult>((resolve) => {
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, error: `task exceeded its deadline of ${deadlineMs}ms` });
    }, deadlineMs);
  });

  const running = Promise.resolve()
    .then(() => entry.task())
    .then(
      result => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        settle(r => r.resolve(result));
      },
      err => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        settle(r => r.reject(err));
      }
    );

  const outcome = await Promise.race([running.then(() => undefined), deadline]);
  if (outcome !== undefined) {
    settle(r => r.resolve(outcome));
  }
}

export function isPending(serviceId: string): boolean {
  return pendingByService.has(serviceId);
}

export function clearExecutor(): void {
  generation++;
  laneQueue.length = 0;
  laneRunning = false;
  queuedByService.clear();
  pendingByService.clear();
}
