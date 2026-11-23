// Pure-function tests for the roster assembler (docs/reference/design/model-roster.md,
// "The assembler"). Plain objects in, plain objects out — no HTTP, no poller.
//
// Assumed assembled shape: `ttsModels` (the union of the nodes' synthesis
// models), `providers` (each with serviceId, hostId, reachable, name,
// responseFormat and `serves`), `voices` (with `renderings`) and `collisions`
// as { kind: "model" | "voice", id, hostIds }.

import { describe, it, expect } from "bun:test";
import { assembleRoster } from "../control-plane/src/roster-assembly";

type Roster = any;

const model = (id: string) => ({ id, name: id });
const roster = (over: Partial<Roster> & { provider?: string; models?: string[] } = {}): Roster => {
  const { provider, models = [], ...rest } = over;
  return {
    ttsModels: models.map(model),
    sttModels: [],
    providers: provider ? { [provider]: { resolvesVoices: false, serves: models.map(m => ({ model: m, key: `${m}-key` })) } } : {},
    voices: [],
    ...rest,
  };
};

const nameFor = (id: string): string | undefined => ({ "cp-tts": "Control Plane TTS", "shard-tts": "Shard TTS" }[id]);
const assemble = (local: Roster, shards: { hostId: string; roster: Roster | null; reachable: boolean }[] = []) =>
  assembleRoster({ local: { hostId: "home-server", roster: local }, shards, nameFor } as any) as any;

describe("assembleRoster: providers", () => {
  it("lists a provider from the control plane and one from a shard, each with its host id, and the shard's model alongside the local one", () => {
    const result = assemble(roster({ provider: "cp-tts", models: ["model-cp"] }), [
      { hostId: "gpu-machine", roster: roster({ provider: "shard-tts", models: ["model-shard"] }), reachable: true },
    ]);
    expect(result.providers.map((p: any) => [p.serviceId, p.hostId, p.reachable])).toEqual([
      ["cp-tts", "home-server", true],
      ["shard-tts", "gpu-machine", true],
    ]);
    expect(result.providers[1].serves.map((s: any) => s.model)).toEqual(["model-shard"]);
    expect(result.ttsModels.map((m: any) => m.id).sort()).toEqual(["model-cp", "model-shard"]);
  });

  it("keeps a shard's providers, marked unreachable, when its last poll failed", () => {
    const result = assemble(roster(), [
      { hostId: "gpu-machine", roster: roster({ provider: "shard-tts", models: ["model-shard"] }), reachable: false },
    ]);
    expect(result.providers).toHaveLength(1);
    expect(result.providers[0].reachable).toBe(false);
  });

  it("contributes nothing for a shard that has never been successfully polled", () => {
    const result = assemble(roster(), [{ hostId: "gpu-machine", roster: null, reachable: false }]);
    expect(result.providers).toHaveLength(0);
  });

  it("names a provider from the merged service list, falling back to its id, and defaults its response format to mp3", () => {
    const result = assemble(roster({ provider: "unknown-svc", models: ["m"] }));
    expect(result.providers[0].name).toBe("unknown-svc");
    expect(result.providers[0].responseFormat).toBe("mp3");
  });
});

describe("assembleRoster: ids declared on two nodes", () => {
  it("excludes a model id declared on two nodes from both, keeps the rest, and reports the collision", () => {
    const result = assemble(roster({ provider: "cp-tts", models: ["shared-model", "unique-model"] }), [
      { hostId: "gpu-machine", roster: roster({ provider: "shard-tts", models: ["shared-model"] }), reachable: true },
    ]);
    expect(result.ttsModels.map((m: any) => m.id)).toEqual(["unique-model"]);
    expect(result.collisions).toContainEqual({ kind: "model", id: "shared-model", hostIds: ["home-server", "gpu-machine"] });
  });

  it("excludes a voice id declared on two nodes from both, and reports the collision", () => {
    const voice = (name: string, model: string) => ({ id: "alice", name, renderings: [{ model, method: "preset", key: "a" }] });
    const result = assemble(
      roster({ provider: "cp-tts", models: ["model-cp"], voices: [voice("Alice", "model-cp"), { id: "bob", name: "Bob", renderings: [{ model: "model-cp", method: "preset", key: "b" }] }] }),
      [{ hostId: "gpu-machine", roster: roster({ provider: "shard-tts", models: ["model-shard"], voices: [voice("Alice", "model-shard")] }), reachable: true }]
    );
    expect(result.voices.map((v: any) => v.id)).toEqual(["bob"]);
    expect(result.collisions).toContainEqual({ kind: "voice", id: "alice", hostIds: ["home-server", "gpu-machine"] });
  });
});
