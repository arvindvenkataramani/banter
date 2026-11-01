// The real schemas against the real files in the repo.

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { syncDocument } from "../src/live-config/sync";
import { moveRuntimeState } from "../src/live-config/rules";
import { configSpec, registrySpec, stateSpec } from "../src/live-config/schemas";

const control = join(import.meta.dir, "../..");
const readJson = (rel: string) => JSON.parse(readFileSync(join(control, rel), "utf8"));

describe("the schemas accept the files the repo ships", () => {
  it("syncs the repo's example config, once its runtime state has moved out, without throwing or unknown-field warnings", () => {
    const config = readJson("control-plane/data/config.example.json");
    moveRuntimeState(config, {});
    const r = syncDocument(config, configSpec);
    expect(r.warnings).toEqual([]);
    expect((r.doc as any).integrations?.openclaw?.defaultAgent).toBeUndefined();
  });

  it.each([["control-plane"], ["control-shard"]])("syncs the %s registry without throwing or unknown-field warnings", (node) => {
    const r = syncDocument(readJson(`${node}/data/registry.example.json`), registrySpec);
    expect(r.warnings).toEqual([]);
  });

  it("turns an empty object into a valid state document", () => {
    const r = syncDocument({}, stateSpec);
    expect(stateSpec.schema.safeParse(r.doc).success).toBe(true);
    expect((r.doc as any).version).toBe(stateSpec.version);
  });
});
