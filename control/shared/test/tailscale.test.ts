import { describe, it, expect } from "bun:test";

type RunFn = (cmd: string[]) => Promise<{ stdout: string; exitCode: number; stderr: string }>;

// ─────────────────────────────────────────────────────────────────────────────

describe("removeTailscaleServe(port)", () => {
  it("checks isPortServed then calls tailscale serve off for the port", async () => {
    const cmds: string[][] = [];
    const runFn: RunFn = async (cmd) => {
      cmds.push(cmd);
      if (cmd.includes("status")) {
        return { stdout: JSON.stringify({ Web: { "myhostname:8080": {} } }), exitCode: 0, stderr: "" };
      }
      return { stdout: "", exitCode: 0, stderr: "" };
    };

    const { removeTailscaleServe } = await import("../src/tailscale");
    await removeTailscaleServe(runFn, 8080);

    expect(cmds[0]).toEqual(["tailscale", "serve", "status", "--json"]);
    expect(cmds[1]).toEqual(["tailscale", "serve", "--bg", "--https=8080", "off"]);
  });

  it("skips remove and returns ok when port is not served", async () => {
    const cmds: string[][] = [];
    const runFn: RunFn = async (cmd) => {
      cmds.push(cmd);
      // isPortServed returns false (port not in status)
      return { stdout: JSON.stringify({ Web: {} }), exitCode: 0, stderr: "" };
    };

    const { removeTailscaleServe } = await import("../src/tailscale");
    const result = await removeTailscaleServe(runFn, 8080);
    expect(result.ok).toBe(true);
    expect(cmds.length).toBe(1); // only the status check, no remove
  });

  it("returns error when remove command exits non-zero", async () => {
    const runFn: RunFn = async (cmd) => {
      if (cmd.includes("status")) {
        return { stdout: JSON.stringify({ Web: { "myhostname:8080": {} } }), exitCode: 0, stderr: "" };
      }
      return { stdout: "", exitCode: 1, stderr: "error" };
    };

    const { removeTailscaleServe } = await import("../src/tailscale");
    const result = await removeTailscaleServe(runFn, 8080);
    expect(result.ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("addTailscaleServe(port)", () => {
  it("calls tailscale serve :<port> http+insecure://localhost:<port>", async () => {
    const cmds: string[][] = [];
    const runFn: RunFn = async (cmd) => {
      cmds.push(cmd);
      if (cmd.includes("status")) {
        // verification probe: report the port as registered so addTailscaleServe returns ok
        return { stdout: JSON.stringify({ Web: { "myhostname:8080": {} } }), exitCode: 0, stderr: "" };
      }
      return { stdout: "", exitCode: 0, stderr: "" };
    };

    const { addTailscaleServe } = await import("../src/tailscale");
    const result = await addTailscaleServe(runFn, 8080);

    expect(result.ok).toBe(true);
    expect(cmds[0]).toEqual([
      "tailscale",
      "serve",
      "--bg",
      "--https=8080",
      "localhost:8080",
    ]);
  });

  it("returns error when tailscale command exits non-zero", async () => {
    const runFn: RunFn = async () => {
      return { stdout: "", exitCode: 1, stderr: "already in use" };
    };

    const { addTailscaleServe } = await import("../src/tailscale");
    const result = await addTailscaleServe(runFn, 8080);
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });
});
