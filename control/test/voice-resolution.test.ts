import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as rosterModule from "../shared/src/roster";
import type { Service } from "../../shared/types";

// The voice resolution rule (docs/reference/design/model-roster.md, "Resolving a
// voice"). The cases are shared with the Swift suite in
// services/fluid/Tests/FluidServerTTSTests/VoiceResolutionTests.swift, which
// reads the same file: a rule changed here and not there fails one of them.
//
// Assumed signature, replacing the old function of this name:
//   resolveVoiceForModel(roster, runtime, model, voice) ->
//     { kind: "preset", modelKey, voice: <preset key> }
//   | { kind: "clone", modelKey, recording: <the chosen recording>, sendText: boolean }
//   | { kind: "refused", reason }

type Expect = { refused: true } | { modelKey: string; presetKey?: string; recordingAudio?: string; recordingText?: string };
interface Case { name: string; voice: string; model: string; serviceId: string; expect: Expect }

const ROOT = join(import.meta.dir, "..", "..");
const shared = JSON.parse(readFileSync(join(ROOT, "schemas", "voice-resolution-cases.json"), "utf-8")) as {
  services: Service[];
  roster: unknown;
  cases: Case[];
};

const ALLOWED = ["refused", "modelKey", "presetKey", "recordingAudio", "recordingText"];

describe("resolving a voice for a model on a runtime", () => {
  it.each(shared.cases.map(c => [c.name, c] as const))("%s", (_, c) => {
    const roster = (rosterModule as any).validateRoster(shared.roster, shared.services);
    // A shape neither suite recognises fails here, not silently.
    for (const key of Object.keys(c.expect)) expect(ALLOWED).toContain(key);

    const resolved = (rosterModule as any).resolveVoiceForModel(roster, c.serviceId, c.model, c.voice);
    if ("refused" in c.expect) {
      expect(resolved.kind).toBe("refused");
      // The refusal names the voice and the model, or the caller is left guessing at a 400.
      expect(resolved.reason).toContain(c.voice);
      expect(resolved.reason).toContain(c.model);
      return;
    }
    expect(resolved.modelKey).toBe(c.expect.modelKey);
    if (c.expect.presetKey !== undefined) {
      expect(resolved.kind).toBe("preset");
      expect(resolved.voice).toBe(c.expect.presetKey);
      return;
    }
    expect(resolved.kind).toBe("clone");
    expect(resolved.recording.audio).toBe(c.expect.recordingAudio);
    expect(resolved.sendText).toBe(c.expect.recordingText !== undefined);
    if (c.expect.recordingText !== undefined) expect(resolved.recording.text).toBe(c.expect.recordingText);
  });
});

describe("the example registries", () => {
  // Banter ships no recordings, so its examples declare preset renderings only.
  const EXAMPLES = [
    "control/control-plane/data/registry.example.json",
    "control/control-shard/data/registry.example.json",
    "services/fluid/registry.fluid.example.json",
  ];
  const load = (path: string) => {
    const registry = JSON.parse(readFileSync(join(ROOT, path), "utf-8")) as { services: Service[]; roster: unknown };
    return (rosterModule as any).validateRoster(registry.roster, registry.services);
  };

  for (const path of EXAMPLES) {
    it(`${path} loads, and every voice resolves on every runtime serving a model that renders her`, () => {
      const roster = load(path);
      let resolved = 0;
      for (const voice of roster.voices) {
        for (const rendering of voice.renderings) {
          for (const [serviceId, provider] of Object.entries(roster.providers) as [string, any][]) {
            if (!provider.serves.some((s: any) => s.model === rendering.model)) continue;
            const result = (rosterModule as any).resolveVoiceForModel(roster, serviceId, rendering.model, voice.id);
            expect(result).toMatchObject({ kind: "preset", voice: rendering.key });
            resolved++;
          }
        }
      }
      expect(resolved).toBeGreaterThan(0);
    });
  }

  it("the fluid example names Kokoro by the model id, served under fluid-tts's own key", () => {
    const roster = load("services/fluid/registry.fluid.example.json");
    expect((rosterModule as any).resolveVoiceForModel(roster, "fluid-tts", "kokoro-82m", "alloy"))
      .toEqual({ kind: "preset", modelKey: "kokoro-ane", voice: "af_alloy" });
  });
});
