import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { loadConfig, registerGatewayConfig } from "../control-plane/src/gateway-config";

// Runtime state (last agent, last session per agent) lives in state/state.json
// beside the config, never in config.json.

let dir: string;
let configPath: string;
let statePath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gateway-state-"));
  configPath = join(dir, "config.json");
  statePath = join(dir, "state", "state.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const read = async (path: string) => JSON.parse(await readFile(path, "utf-8"));

async function appFor() {
  const config = await loadConfig(configPath);
  const app = new Hono();
  registerGatewayConfig(app, config, configPath);
  return app;
}

const patch = (app: Hono, path: string, body: unknown) =>
  app.fetch(new Request(`http://localhost${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));

describe("runtime state", () => {
  it("loading moves defaultAgent and lastSessionByAgent out of config.json into state.json", async () => {
    await writeFile(configPath, JSON.stringify({
      version: 2,
      integrations: { openclaw: { gateway: { url: "wss://gw", token: "t" }, defaultAgent: "alex", lastSessionByAgent: { alex: "s1" } } },
    }));

    await loadConfig(configPath);

    const config = await read(configPath);
    expect(config.integrations.openclaw.defaultAgent).toBeUndefined();
    expect(config.integrations.openclaw.lastSessionByAgent).toBeUndefined();
    expect(config.integrations.openclaw.gateway.url).toBe("wss://gw");
    expect(await read(statePath)).toMatchObject({ lastAgent: "alex", lastSessionByAgent: { alex: "s1" } });
  });

  it("PATCH /api/gateway/lastAgent and /lastSession write state.json and leave config.json as it was", async () => {
    await writeFile(configPath, JSON.stringify({ version: 4, integrations: { openclaw: { gateway: { url: "wss://gw", token: "t" } } } }));
    const before = await readFile(configPath, "utf-8");
    const app = await appFor();

    const a = await patch(app, "/api/gateway/lastAgent", { agentId: "alex" });
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual({ lastAgent: "alex" });
    const s = await patch(app, "/api/gateway/lastSession", { agentId: "alex", sessionName: "s2" });
    expect(s.status).toBe(200);

    expect(await read(statePath)).toMatchObject({ lastAgent: "alex", lastSessionByAgent: { alex: "s2" } });
    expect(await readFile(configPath, "utf-8")).toBe(before);

    const got = await (await app.fetch(new Request("http://localhost/api/gateway"))).json();
    expect(got.lastAgent).toBe("alex");
    expect(got.lastSessionByAgent).toEqual({ alex: "s2" });
  });

  it("the old defaultAgent route is gone", async () => {
    await writeFile(configPath, JSON.stringify({ version: 4, integrations: { openclaw: { gateway: { url: "wss://gw", token: "t" } } } }));
    const res = await patch(await appFor(), "/api/gateway/defaultAgent", { agentId: "alex" });
    expect(res.status).toBe(404);
  });

  it("a config that fails its schema is refused with the field named", async () => {
    await writeFile(configPath, JSON.stringify({ version: 4, voice: { enabled: "yes" } }));
    await expect(loadConfig(configPath)).rejects.toThrow(/voice\.enabled/);
  });
});

describe("expandTilde", () => {
  it("expands a leading ~ to the home directory and leaves other paths alone", async () => {
    const { expandTilde } = await import("../control-plane/src/gateway-config");
    const home = (await import("node:os")).homedir();
    expect(expandTilde("~")).toBe(home);
    expect(expandTilde("~/mic")).toBe(join(home, "mic"));
    expect(expandTilde("/abs/mic")).toBe("/abs/mic");
    expect(expandTilde("rel/~x")).toBe("rel/~x");
  });
});
