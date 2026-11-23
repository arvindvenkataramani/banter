// Load-time checks on a node's roster (docs/reference/design/model-roster.md, "Validation").
// The valid roster is the one the shared resolution cases use; each test breaks
// one fact in a copy of it and asserts the failure names what the design says.

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateRoster } from "../src/roster";
import type { Service } from "../../../shared/types";

const shared = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "..", "..", "schemas", "voice-resolution-cases.json"), "utf-8")
) as { services: Service[]; roster: any };

type Roster = any;
const fresh = (): Roster => structuredClone(shared.roster);
const voice = (r: Roster, id: string) => r.voices.find((v: any) => v.id === id);

/** Loading the edited roster fails, and the message names every one of `names`. */
function rejects(edit: (r: Roster) => void, ...names: string[]): void {
  const roster = fresh();
  edit(roster);
  let message = "";
  try {
    validateRoster(roster, shared.services);
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  expect(message).not.toBe("");
  for (const name of names) expect(message).toContain(name);
}

describe("a roster in the new shape", () => {
  it("loads, keeping its models, providers and voices as declared", () => {
    const loaded = validateRoster(fresh(), shared.services) as Roster;
    expect(loaded.ttsModels.map((m: any) => m.id)).toEqual(["pocket-tts", "luxtts", "kokoro-82m", "chatterbox"]);
    expect(Object.keys(loaded.providers).sort()).toEqual(["fluid-stt", "fluid-tts", "tts-mlx-audio"]);
    expect(loaded.voices.map((v: any) => v.id)).toContain("sam");
  });
});

describe("roster validation", () => {
  it("a provider must name a registered service", () => {
    rejects(r => { r.providers.ghost = structuredClone(r.providers["fluid-tts"]); }, "ghost");
  });

  it("voice ids are unique", () => {
    rejects(r => { r.voices.push(structuredClone(voice(r, "nicole"))); }, "nicole");
  });

  it("model ids are unique across synthesis and speech-to-text models", () => {
    rejects(r => { r.sttModels.push({ id: "luxtts", name: "Clash", kind: "batch" }); }, "luxtts");
  });

  it("a serving must name a declared model", () => {
    rejects(r => { r.providers["fluid-tts"].serves.push({ model: "no-such-model", key: "x" }); }, "fluid-tts", "no-such-model");
  });

  it("a synthesis provider cannot serve a speech-to-text model", () => {
    rejects(r => { r.providers["fluid-tts"].serves.push({ model: "parakeet-tdt-v3", key: "parakeet-tdt-v3" }); }, "fluid-tts", "parakeet-tdt-v3");
  });

  it("a rendering must name a declared synthesis model", () => {
    rejects(r => { voice(r, "eponine").renderings.push({ model: "no-such-model", method: "preset", key: "e" }); }, "eponine", "no-such-model");
  });

  it("a preset rendering must have a key", () => {
    rejects(r => { delete voice(r, "eponine").renderings[0].key; }, "eponine", "pocket-tts");
  });

  it("a clone rendering must have no key", () => {
    rejects(r => { voice(r, "nicole").renderings.find((x: any) => x.method === "clone").key = "af_nicole"; }, "nicole");
  });

  it("a clone rendering's model must be able to clone", () => {
    rejects(r => { voice(r, "nicole").renderings.push({ model: "kokoro-82m", method: "clone" }); }, "nicole", "kokoro-82m");
  });

  it("a clone rendering needs a recording its model accepts", () => {
    // LuxTTS accepts at most 5 s; both of Alex's recordings are made too long.
    rejects(r => { for (const rec of voice(r, "alex").recordings) rec.durationS = 5.01; }, "alex", "luxtts");
  });

  // Carried over from the old shape: facts that are wrong silently when mistyped.
  it("a provider's response format must be one the platform can decode", () => {
    rejects(r => { r.providers["fluid-tts"].responseFormat = "ogg"; }, "fluid-tts", "responseFormat");
  });

  it("a serving's concurrency must be a positive integer", () => {
    rejects(r => { r.providers["tts-mlx-audio"].serves[0].concurrency = 0; }, "tts-mlx-audio", "concurrency");
  });

  it("a synthesis provider must state whether it resolves voices itself", () => {
    rejects(r => { delete r.providers["tts-mlx-audio"].resolvesVoices; }, "tts-mlx-audio");
  });
});

describe("the example registries' rosters", () => {
  const EXAMPLES = [
    "control/control-plane/data/registry.example.json",
    "control/control-shard/data/registry.example.json",
    "services/fluid/registry.fluid.example.json",
  ];
  for (const path of EXAMPLES) {
    it(`${path} validates against the nodeRoster definition in schemas/platform.schema.json`, async () => {
      const { default: Ajv2020 } = await import("ajv/dist/2020");
      const root = join(import.meta.dir, "..", "..", "..");
      const schema = JSON.parse(readFileSync(join(root, "schemas", "platform.schema.json"), "utf-8"));
      const registry = JSON.parse(readFileSync(join(root, path), "utf-8"));

      const ajv = new Ajv2020({ strict: false, allErrors: true });
      ajv.addSchema(schema);
      const validate = ajv.getSchema(`${schema.$id}#/$defs/nodeRoster`)!;
      const ok = validate(registry.roster);
      expect(ok ? [] : validate.errors!.map(e => `${e.instancePath} ${e.message}`).slice(0, 5)).toEqual([]);
    });
  }
});
