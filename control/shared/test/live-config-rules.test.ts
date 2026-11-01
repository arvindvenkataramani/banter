// The first repair rules, each run on a fixture of the old shape and on a document already current.

import { describe, it, expect } from "bun:test";
import { literalPortRule, registryPathRule, moveRuntimeState } from "../src/live-config/rules";

const proc = (id: string, main: string) => ({ id, runner: { type: "process", main } });
const registry = (...services: unknown[]) => ({ version: 1, services });
const mainOf = (doc: any, i: number) => doc.services[i].runner.main;

describe("literal port rule", () => {
  it("replaces a literal --port N or --port=N in a process runner's command with {port}", () => {
    const doc = registry(proc("a", "uvicorn app:app --port 8080"), proc("b", "serve --port=9090 --quiet"));
    expect(literalPortRule.apply(doc)).toBe(true);
    expect(mainOf(doc, 0)).toBe("uvicorn app:app --port {port}");
    expect(mainOf(doc, 1)).toBe("serve --port={port} --quiet");
  });

  it("does nothing to a registry whose commands already use {port}", () => {
    const doc = registry(proc("a", "uvicorn app:app --port {port}"), { id: "s", runner: { type: "systemd", unit: "x" } });
    const before = structuredClone(doc);
    expect(literalPortRule.apply(doc)).toBe(false);
    expect(doc).toEqual(before);
  });
});

describe("registry path rule", () => {
  // An older Banter registry was written with a ~ path, which a command line never expands.
  it("leaves a URL after --registry alone", () => {
    const doc = registry(proc("a", "npm publish --registry https://registry.npmjs.org/ --port {port}"));
    expect(registryPathRule.apply(doc)).toBe(false);
    expect(mainOf(doc, 0)).toBe("npm publish --registry https://registry.npmjs.org/ --port {port}");
  });

  it("replaces a ~ path after --registry too", () => {
    const doc = registry(proc("a", "fluid-stt --port {port} --registry ~/services/shard/registry.json --provider fluid-stt"));
    expect(registryPathRule.apply(doc)).toBe(true);
    expect(mainOf(doc, 0)).toBe("fluid-stt --port {port} --registry {registry} --provider fluid-stt");
  });

  it("replaces an absolute path after --registry in a process runner's command with {registry}", () => {
    const doc = registry(proc("a", "fluid-server --registry /home/x/services/banter/registry.json --port {port}"));
    expect(registryPathRule.apply(doc)).toBe(true);
    expect(mainOf(doc, 0)).toBe("fluid-server --registry {registry} --port {port}");
  });

  it("does nothing to a command that already says {registry} or has no --registry", () => {
    const doc = registry(proc("a", "fluid-server --registry {registry}"), proc("b", "plain-server --port {port}"));
    const before = structuredClone(doc);
    expect(registryPathRule.apply(doc)).toBe(false);
    expect(doc).toEqual(before);
  });
});

describe("moving runtime state out of the configuration", () => {
  const oldConfig = () => ({
    integrations: { openclaw: { url: "wss://gw", defaultAgent: "alex", lastSessionByAgent: { alex: "s1" } } },
  });

  it("moves defaultAgent to state.lastAgent and lastSessionByAgent across, deleting both from the configuration", () => {
    const config: any = oldConfig();
    const state: any = {};
    expect(moveRuntimeState(config, state)).toBe(true);
    expect(state.lastAgent).toBe("alex");
    expect(state.lastSessionByAgent).toEqual({ alex: "s1" });
    expect(config.integrations.openclaw).toEqual({ url: "wss://gw" });
  });

  it("keeps a value already in state over the configuration's, and still clears the configuration", () => {
    const config: any = oldConfig();
    const state: any = { lastAgent: "other-agent" };
    moveRuntimeState(config, state);
    expect(state.lastAgent).toBe("other-agent");
    expect(config.integrations.openclaw.defaultAgent).toBeUndefined();
  });

  it("does nothing to a configuration that no longer holds them", () => {
    const config: any = { integrations: { openclaw: { url: "wss://gw" } } };
    const state: any = { lastAgent: "alex" };
    expect(moveRuntimeState(config, state)).toBe(false);
    expect(state).toEqual({ lastAgent: "alex" });
  });
});
