// Pure-function tests for the roster assembler (docs/design/model-roster.md,
// "The assembler"). Plain objects in, plain objects out — no HTTP, no
// poller.

import { describe, it, expect } from "bun:test";
import { assembleRoster } from "../control-plane/src/roster-assembly";
import type { NodeRoster } from "../../shared/types";

function emptyRoster(): NodeRoster {
  return { providers: {}, voices: [] };
}

const nameFor = (id: string): string | undefined => ({
  "cp-tts": "Control Plane TTS",
  "shard-tts": "Shard TTS",
  "shard-tts-2": "Shard TTS 2",
}[id]);

describe("assembleRoster: providers", () => {
  it("lists a provider from the control plane and one from a shard, each with its host id", () => {
    const local: NodeRoster = {
      providers: { "cp-tts": { ttsModels: [{ id: "model-cp", name: "Model CP", key: "model-cp" }] } },
      voices: [],
    };
    const shardRoster: NodeRoster = {
      providers: { "shard-tts": { ttsModels: [{ id: "model-shard", name: "Model Shard", key: "model-shard" }] } },
      voices: [],
    };
    const result = assembleRoster({
      local: { hostId: "home-server", roster: local },
      shards: [{ hostId: "gpu-machine", roster: shardRoster, reachable: true }],
      nameFor,
    });
    expect(result.providers.map(p => [p.serviceId, p.hostId])).toEqual([
      ["cp-tts", "home-server"],
      ["shard-tts", "gpu-machine"],
    ]);
  });

  it("marks the control plane's own providers reachable", () => {
    const local: NodeRoster = {
      providers: { "cp-tts": { ttsModels: [{ id: "model-cp", name: "Model CP", key: "model-cp" }] } },
      voices: [],
    };
    const result = assembleRoster({ local: { hostId: "home-server", roster: local }, shards: [], nameFor });
    expect(result.providers[0].reachable).toBe(true);
  });

  it("keeps a shard's providers, marked unreachable, when its last poll failed", () => {
    const shardRoster: NodeRoster = {
      providers: { "shard-tts": { ttsModels: [{ id: "model-shard", name: "Model Shard", key: "model-shard" }] } },
      voices: [],
    };
    const result = assembleRoster({
      local: { hostId: "home-server", roster: emptyRoster() },
      shards: [{ hostId: "gpu-machine", roster: shardRoster, reachable: false }],
      nameFor,
    });
    expect(result.providers).toHaveLength(1);
    expect(result.providers[0].reachable).toBe(false);
  });

  it("contributes nothing for a shard that has never been successfully polled", () => {
    const result = assembleRoster({
      local: { hostId: "home-server", roster: emptyRoster() },
      shards: [{ hostId: "gpu-machine", roster: null, reachable: false }],
      nameFor,
    });
    expect(result.providers).toHaveLength(0);
  });

  it("names a provider from the merged service list, falling back to its id", () => {
    const local: NodeRoster = {
      providers: { "unknown-svc": { ttsModels: [{ id: "m", name: "M", key: "m" }] } },
      voices: [],
    };
    const result = assembleRoster({ local: { hostId: "home-server", roster: local }, shards: [], nameFor });
    expect(result.providers[0].name).toBe("unknown-svc");
  });

  it("defaults a provider's responseFormat to mp3 when the roster declares none", () => {
    const local: NodeRoster = {
      providers: { "cp-tts": { ttsModels: [{ id: "m", name: "M", key: "m" }] } },
      voices: [],
    };
    const result = assembleRoster({ local: { hostId: "home-server", roster: local }, shards: [], nameFor });
    expect(result.providers[0].responseFormat).toBe("mp3");
  });
});

describe("assembleRoster: voices", () => {
  it("merges a voice declared on both nodes into one, with model links from both, each keeping its own node's references", () => {
    const local: NodeRoster = {
      providers: { "cp-tts": { ttsModels: [{ id: "model-cp", name: "Model CP", key: "model-cp", cloning: { available: true } }] } },
      voices: [{
        id: "alice",
        name: "Alice",
        references: [{ audio: "/cp/alice.wav", durationS: 10, sampleRate: 24000 }],
        models: [{ serviceId: "cp-tts", model: "model-cp", key: "clone" }],
      }],
    };
    const shardRoster: NodeRoster = {
      providers: { "shard-tts": { ttsModels: [{ id: "model-shard", name: "Model Shard", key: "model-shard", cloning: { available: true } }] } },
      voices: [{
        id: "alice",
        name: "Alice",
        references: [{ audio: "/shard/alice.wav", durationS: 8, sampleRate: 22050 }],
        models: [{ serviceId: "shard-tts", model: "model-shard", key: "clone" }],
      }],
    };
    const result = assembleRoster({
      local: { hostId: "home-server", roster: local },
      shards: [{ hostId: "gpu-machine", roster: shardRoster, reachable: true }],
      nameFor,
    });
    expect(result.voices).toHaveLength(1);
    const alice = result.voices[0];
    expect(alice.models).toHaveLength(2);
    const cpLink = alice.models.find(m => m.hostId === "home-server")!;
    const shardLink = alice.models.find(m => m.hostId === "gpu-machine")!;
    expect(cpLink.references).toEqual([{ audio: "/cp/alice.wav", durationS: 10, sampleRate: 24000 }]);
    expect(shardLink.references).toEqual([{ audio: "/shard/alice.wav", durationS: 8, sampleRate: 22050 }]);
  });

  it("keeps the control plane's name for a voice named differently on a shard, and reports the collision", () => {
    const local: NodeRoster = {
      providers: {},
      voices: [{
        id: "alice",
        name: "Alice",
        references: [],
        models: [{ serviceId: "cp-tts", model: "model-cp", key: "clone" }],
      }],
    };
    const shardRoster: NodeRoster = {
      providers: {},
      voices: [{
        id: "alice",
        name: "Alicia",
        references: [],
        models: [{ serviceId: "shard-tts", model: "model-shard", key: "clone" }],
      }],
    };
    const result = assembleRoster({
      local: { hostId: "home-server", roster: local },
      shards: [{ hostId: "gpu-machine", roster: shardRoster, reachable: true }],
      nameFor,
    });
    expect(result.voices[0].name).toBe("Alice");
    expect(result.collisions).toContainEqual({ kind: "voice-name", id: "alice", hostIds: ["home-server", "gpu-machine"] });
  });
});

describe("assembleRoster: model id collisions", () => {
  it("excludes a model id declared on two nodes from both, and lists the collision", () => {
    const local: NodeRoster = {
      providers: { "cp-tts": { ttsModels: [{ id: "shared-model", name: "CP's", key: "cp-key" }] } },
      voices: [],
    };
    const shardRoster: NodeRoster = {
      providers: { "shard-tts": { ttsModels: [{ id: "shared-model", name: "Shard's", key: "shard-key" }] } },
      voices: [],
    };
    const result = assembleRoster({
      local: { hostId: "home-server", roster: local },
      shards: [{ hostId: "gpu-machine", roster: shardRoster, reachable: true }],
      nameFor,
    });
    const allModelIds = result.providers.flatMap(p => (p.ttsModels ?? []).map(m => m.id));
    expect(allModelIds).not.toContain("shared-model");
    expect(result.collisions).toContainEqual({ kind: "model", id: "shared-model", hostIds: ["home-server", "gpu-machine"] });
  });

  it("leaves a provider's other models intact when only one of its models collides", () => {
    const local: NodeRoster = {
      providers: {
        "cp-tts": {
          ttsModels: [
            { id: "shared-model", name: "CP's", key: "cp-key" },
            { id: "unique-model", name: "Unique", key: "unique-key" },
          ],
        },
      },
      voices: [],
    };
    const shardRoster: NodeRoster = {
      providers: { "shard-tts": { ttsModels: [{ id: "shared-model", name: "Shard's", key: "shard-key" }] } },
      voices: [],
    };
    const result = assembleRoster({
      local: { hostId: "home-server", roster: local },
      shards: [{ hostId: "gpu-machine", roster: shardRoster, reachable: true }],
      nameFor,
    });
    const cpProvider = result.providers.find(p => p.serviceId === "cp-tts")!;
    expect(cpProvider.ttsModels?.map(m => m.id)).toEqual(["unique-model"]);
  });
});
