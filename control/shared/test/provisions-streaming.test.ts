// Check 9 asks for the candidate the engine would select: a streaming speech-to-text model needs a
// provision whose client decides where an utterance ends (docs/reference/design/service-apis.md, "Validation at registry load").

import { describe, it, expect } from "bun:test";
import { validateRoster } from "../src/roster";

const doc = (provides: unknown[]) => ({
  services: [{ id: "stt-a", capabilityId: "stt", provides, models: { loading: "none" } }],
  roster: {
    ttsModels: [],
    sttModels: [{ id: "m", name: "M", kind: "streaming" }],
    providers: { "stt-a": { serves: [{ model: "m", key: "m" }] } },
    voices: [],
  },
});

const outcome = (provides: unknown[]) => {
  const d = doc(provides);
  try { validateRoster(d.roster, d.services as never); return ""; } catch (err) { return (err as Error).message; }
};

describe("check 9 for a streaming model", () => {
  it("[P1] refuses a Deepgram live provision that does not declare endpointing-off", () => {
    expect(outcome([{ api: "deepgram.listen.live" }])).toContain("stt-a");
    expect(outcome([{ api: "deepgram.listen.live", extends: ["endpointing-off"] }])).toBe("");
  });
});
