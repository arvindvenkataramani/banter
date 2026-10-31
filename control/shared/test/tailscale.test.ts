// Registering and removing a port with Tailscale Serve, including the retries
// that absorb another writer changing the serve config at the same moment.

import { describe, it, expect } from "bun:test";
import { addTailscaleServe, removeTailscaleServe, type RunFn } from "../src/tailscale";

const ETAG_ERROR = "Another client is changing the serve config; please try again.\netag mismatch\n";

/** A Serve config for port 8080. `writes` scripts the outcome of each write in turn; past its end, writes succeed. */
function fakeServe(opts: { served?: boolean; writes?: (string | "ok" | "unverified")[] } = {}) {
  let served = opts.served ?? false;
  const script = [...(opts.writes ?? [])];
  const writes: string[][] = [];
  const runFn: RunFn = async (cmd) => {
    if (cmd.includes("status")) {
      return { stdout: JSON.stringify({ Web: served ? { "host:8080": {} } : {} }), exitCode: 0, stderr: "" };
    }
    writes.push(cmd);
    const outcome = script.shift() ?? "ok";
    if (outcome === "unverified") return { stdout: "", exitCode: 0, stderr: "" };
    if (outcome !== "ok") return { stdout: "", exitCode: 1, stderr: outcome };
    served = !cmd.includes("off");
    return { stdout: "", exitCode: 0, stderr: "" };
  };
  return { runFn, writes, served: () => served };
}

const RETRY = { attempts: 3, delayMs: 1 };

describe("addTailscaleServe", () => {
  it("serves the port over https from localhost and confirms it registered", async () => {
    const serve = fakeServe();
    expect(await addTailscaleServe(serve.runFn, 8080, RETRY)).toEqual({ ok: true });
    expect(serve.writes).toEqual([["tailscale", "serve", "--bg", "--https=8080", "localhost:8080"]]);
    expect(serve.served()).toBe(true);
  });

  const RETRIES: [string, (string | "unverified")[], number, boolean][] = [
    ["one lost race", [ETAG_ERROR], 2, true],
    ["two lost races", [ETAG_ERROR, ETAG_ERROR], 3, true],
    ["a write that exits zero but does not register", ["unverified"], 2, true],
    ["three lost races", [ETAG_ERROR, ETAG_ERROR, ETAG_ERROR], 3, false],
  ];
  it.each(RETRIES)("after %s, makes %i attempts and succeeds: %s", async (_, writes, attempts, ok) => {
    const serve = fakeServe({ writes });
    expect((await addTailscaleServe(serve.runFn, 8080, RETRY)).ok).toBe(ok);
    expect(serve.writes).toHaveLength(attempts);
  });

  it("makes as many attempts as it is given", async () => {
    for (const attempts of [1, 5]) {
      const serve = fakeServe({ writes: Array(10).fill(ETAG_ERROR) });
      await addTailscaleServe(serve.runFn, 8080, { attempts, delayMs: 1 });
      expect(serve.writes).toHaveLength(attempts);
    }
  });

  it("reports each distinct error once", async () => {
    const differing = fakeServe({ writes: [ETAG_ERROR, "permission denied", ETAG_ERROR] });
    const result = await addTailscaleServe(differing.runFn, 8080, RETRY);
    expect(result.error).toBe(`${ETAG_ERROR}; permission denied`);

    const same = fakeServe({ writes: [ETAG_ERROR, ETAG_ERROR, ETAG_ERROR] });
    expect((await addTailscaleServe(same.runFn, 8080, RETRY)).error).toBe(ETAG_ERROR);
  });
});

describe("removeTailscaleServe", () => {
  it("turns the port off, retrying a lost race up to the attempt count", async () => {
    const recovers = fakeServe({ served: true, writes: [ETAG_ERROR] });
    expect(await removeTailscaleServe(recovers.runFn, 8080, RETRY)).toEqual({ ok: true });
    expect(recovers.writes).toEqual([
      ["tailscale", "serve", "--bg", "--https=8080", "off"],
      ["tailscale", "serve", "--bg", "--https=8080", "off"],
    ]);

    const givesUp = fakeServe({ served: true, writes: [ETAG_ERROR, ETAG_ERROR, ETAG_ERROR] });
    expect((await removeTailscaleServe(givesUp.runFn, 8080, RETRY)).ok).toBe(false);
    expect(givesUp.writes).toHaveLength(3);
  });

  it("does nothing for a port that is not served", async () => {
    const serve = fakeServe();
    expect(await removeTailscaleServe(serve.runFn, 8080, RETRY)).toEqual({ ok: true });
    expect(serve.writes).toEqual([]);
  });
});
