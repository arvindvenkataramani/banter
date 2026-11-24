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

describe("the turn-taking curve", () => {
  it.each([
    ["power", { type: "power", exponent: 2 }],
    ["sigmoid", { type: "sigmoid", center: 0.5, steepness: 8 }],
  ])("loads a %s curve with no unknown-field warning", (_name, curve) => {
    const r = syncDocument({ version: 3, voice: { stt: { turnTaking: { curve } } } }, configSpec);
    expect(r.warnings).toEqual([]);
    expect((r.doc as any).voice.stt.turnTaking.curve).toEqual(curve);
  });
});

describe("voice preload and the encodings the browser may send", () => {
  const example = () => {
    const config = readJson("control-plane/data/config.example.json");
    moveRuntimeState(config, {});
    return config;
  };

  // Like the other optional voice settings, the defaults (preload on; opus before
  // pcm16) belong to the readers, so a sync writes neither into a file that omits them.
  it("[T1] a config that states neither is left without them", () => {
    const r = syncDocument(example(), configSpec) as { doc: any };
    expect("preload" in r.doc.voice).toBe(false);
    expect("encodings" in r.doc.voice.stt).toBe(false);
  });

  it("[T1] keeps what a config states, in its order", () => {
    const config = example();
    config.voice.preload = false;
    config.voice.stt.encodings = ["pcm16", "opus"];
    const r = syncDocument(config, configSpec) as { doc: any };
    expect(r.doc.voice.preload).toBe(false);
    expect(r.doc.voice.stt.encodings).toEqual(["pcm16", "opus"]);
  });

  it("[T1] refuses an encoding other than opus and pcm16", () => {
    const config = example();
    config.voice.stt.encodings = ["opus", "flac"];
    expect(() => syncDocument(config, configSpec)).toThrow(/encodings/);
  });
});
