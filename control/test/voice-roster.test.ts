import { describe, it, expect } from "bun:test";
import { voiceModeProviders } from "../control-plane/src/voice-roster";
import type { AssembledRoster } from "../control-plane/src/roster-assembly";

// voiceModeProviders builds voice mode's providers/models/voices from the
// assembled roster (docs/design/model-roster.md). GET /api/voice (app.ts) is
// what wires an actual assembly through to this function; these tests hand
// it a plain AssembledRoster instead of driving HTTP.

const ASSEMBLY: AssembledRoster = {
  providers: [
    {
      serviceId: "tts-mlx-audio",
      hostId: "gpu-machine",
      reachable: true,
      name: "MLX Audio",
      responseFormat: "mp3",
      ttsModels: [
        {
          id: "kokoro-82m",
          name: "Kokoro 82M",
          key: "prince-canuma/Kokoro-82M",
          realtime: true,
          presetVoices: [
            { id: "bf_priya", name: "Priya" },
            { id: "af_heart", name: "Heart" },
          ],
        },
      ],
    },
    {
      serviceId: "fluid-tts",
      hostId: "gpu-machine",
      reachable: true,
      name: "FluidServer TTS",
      responseFormat: "aac",
      ttsModels: [
        {
          id: "pocket-tts",
          name: "Pocket-TTS",
          key: "pocket-tts",
          realtime: true,
          streaming: true,
          chunking: { mode: "sentence" },
          concurrency: 1,
          requestParams: { streaming_interval: 0.5 },
          cloning: { available: true, requiresText: false },
        },
      ],
    },
  ],
  voices: [
    {
      id: "priya",
      name: "Priya",
      models: [
        { serviceId: "tts-mlx-audio", model: "kokoro-82m", key: "bf_priya", hostId: "gpu-machine", references: [] },
        {
          serviceId: "fluid-tts",
          model: "pocket-tts",
          key: "clone",
          hostId: "gpu-machine",
          references: [{ audio: "/refs/priya.wav", durationS: 9, sampleRate: 24000 }],
        },
      ],
    },
  ],
  collisions: [],
};

describe("voiceModeProviders: builds voice mode's choices from the assembled roster", () => {
  it("lists a provider per assembled provider, carrying its host id and reachability", () => {
    const providers = voiceModeProviders(ASSEMBLY);
    expect(providers.map(p => [p.serviceId, p.hostId, p.reachable])).toEqual([
      ["tts-mlx-audio", "gpu-machine", true],
      ["fluid-tts", "gpu-machine", true],
    ]);
  });

  it("gives each provider its runtime's audio format", () => {
    const providers = voiceModeProviders(ASSEMBLY);
    expect(providers.map(p => [p.serviceId, p.responseFormat])).toEqual([
      ["tts-mlx-audio", "mp3"],
      ["fluid-tts", "aac"],
    ]);
  });

  it("gives a model its roster id, its runtime key and its voice-loop declarations", () => {
    const providers = voiceModeProviders(ASSEMBLY);
    const pocket = providers.find(p => p.serviceId === "fluid-tts")!.models[0];
    const { voices, ...rest } = pocket;
    expect(rest).toEqual({
      id: "pocket-tts",
      name: "Pocket-TTS",
      key: "pocket-tts",
      realtime: true,
      streaming: true,
      chunking: { mode: "sentence" },
      concurrency: 1,
      requestParams: { streaming_interval: 0.5 },
    });
  });

  it("offers a roster voice under her model's key, and a model's presets she does not stand for", () => {
    const providers = voiceModeProviders(ASSEMBLY);
    const kokoro = providers.find(p => p.serviceId === "tts-mlx-audio")!.models[0];
    expect(kokoro.voices).toEqual([
      { id: "priya", name: "Priya", key: "bf_priya" },
      { id: "af_heart", name: "Heart", key: "af_heart" },
    ]);
  });

  it("sends a cloned voice by her roster id with the reference her node's link declares", () => {
    const providers = voiceModeProviders(ASSEMBLY);
    const pocket = providers.find(p => p.serviceId === "fluid-tts")!.models[0];
    expect(pocket.voices).toEqual([
      { id: "priya", name: "Priya", key: "priya", ref_audio: "/refs/priya.wav" },
    ]);
  });

  it("sends no reference for a clone whose recording does not satisfy the model's cloning terms", () => {
    const assembly: AssembledRoster = {
      ...ASSEMBLY,
      providers: ASSEMBLY.providers.map(p =>
        p.serviceId === "fluid-tts"
          ? { ...p, ttsModels: [{ ...p.ttsModels![0], cloning: { available: true, requiresText: true } }] }
          : p
      ),
    };
    const providers = voiceModeProviders(assembly);
    const pocket = providers.find(p => p.serviceId === "fluid-tts")!.models[0];
    expect(pocket.voices[0].ref_audio).toBeUndefined();
  });

  it("offers nothing when the assembly has no providers", () => {
    const providers = voiceModeProviders({ providers: [], voices: [], collisions: [] });
    expect(providers).toEqual([]);
  });
});
