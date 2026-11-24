// The API catalog and its part indexes (docs/reference/design/service-apis.md, "The API catalog").
// The catalog is data: these tests hold it to the spec's list, its pins and the rule
// that every API Banter can be pointed at has an index to check deviations against.

import { describe, it, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dir;
const readJson = (path: string) => JSON.parse(readFileSync(join(here, path), "utf-8"));

type Revision = string | { read: string; sha256: unknown };
type Reference = { document: string; revision: Revision; part: string };
type Catalog = {
  apis: { id: string; name: string; reference: Reference }[];
  extensions: { id: string; adds: string; reference: Reference }[];
};

const catalog = () => readJson("catalog.json") as Catalog;

const OPENAI_PIN = "373f26a9aec3608e3158f2a0d4b8ae49d13162a4";
const DEEPGRAM_PIN = "0ccc6f4680b3fe5b8f9002be6a78cd50e5b32116";
const TRITON_PIN = "81794dd20032fc2504a40e6a3942ad9330ff437b";

describe("the catalog's contents", () => {
  it("[T1] lists exactly the ten APIs Banter can be pointed at, and not the platform-only chat API", () => {
    expect(catalog().apis.map(a => a.id).sort()).toEqual([
      "deepgram.listen.live",
      "deepgram.listen.prerecorded",
      "deepgram.speak",
      "deepgram.speak.live",
      "fluid.stt.stream",
      "fluid.tts.stream",
      "openai.audio.speech",
      "openai.audio.transcriptions",
      "openai.realtime",
      "triton.model-repository",
    ]);
  });

  it("[T1] lists exactly the ten extensions of the design", () => {
    expect(catalog().extensions.map(e => e.id).sort()).toEqual([
      "cloning-reference",
      "endpointing-off",
      "finalize-answered",
      "opus-input",
      "opus-packets",
      "resident-slot",
      "session-claim",
      "stream-flag",
      "verbatim-speech",
      "voice-param",
    ]);
  });

  it("[T1] pins each published reference to the revision the spec names", () => {
    const byId = new Map(catalog().apis.map(a => [a.id, a.reference.revision]));
    for (const id of ["openai.audio.speech", "openai.audio.transcriptions"]) expect(byId.get(id)).toBe(OPENAI_PIN);
    for (const id of ["deepgram.listen.prerecorded", "deepgram.listen.live", "deepgram.speak", "deepgram.speak.live"]) {
      expect(byId.get(id)).toBe(DEEPGRAM_PIN);
    }
    expect(byId.get("triton.model-repository")).toBe(TRITON_PIN);
    // Realtime is pinned by the day its pages were read and their hashes.
    expect(byId.get("openai.realtime")).toEqual({
      read: "2026-11-24",
      sha256: {
        "client-events": "bd09448d5c7048148616c895e965c3e280ed8b0763cee583a6e7bf0e2d158532",
        "server-events": "e8a4ab74ee0776b94007a5d0a1db48586afb1e631f9370ac63b86433eba80ac4",
      },
    });
    for (const id of ["fluid.stt.stream", "fluid.tts.stream"]) expect(byId.get(id)).toBe("in-repo");
  });

  it("[T1] each part index carries the same revision as its catalog entry", () => {
    for (const api of catalog().apis) expect(readJson(`parts/${api.id}.json`).revision).toEqual(api.reference.revision);
  });
});

describe("references", () => {
  it("[T1] every API and every extension carries a reference naming a document, a revision and a part", () => {
    const { apis, extensions } = catalog();
    for (const entry of [...apis, ...extensions]) {
      const ref = entry.reference;
      expect(typeof ref?.document, entry.id).toBe("string");
      expect(ref.document.length, entry.id).toBeGreaterThan(0);
      expect(typeof ref.part, entry.id).toBe("string");
      expect(ref.part.length, entry.id).toBeGreaterThan(0);
      // A revision is a commit, or { read, sha256 } for a page.
      const revision = ref.revision;
      const wellFormed = typeof revision === "string" ? revision.length > 0 : typeof revision?.read === "string" && revision.sha256 !== undefined;
      expect(wellFormed, `${entry.id} revision`).toBe(true);
    }
    for (const api of apis) expect(api.name.length, api.id).toBeGreaterThan(0);
    for (const ext of extensions) expect(ext.adds.length, ext.id).toBeGreaterThan(0);
  });

  it("[T1] the extensions defined by the design's successor point at the reference design in docs/", () => {
    const byId = new Map(catalog().extensions.map(e => [e.id, e.reference]));
    for (const id of ["cloning-reference", "opus-input", "voice-param"]) {
      expect(byId.get(id)?.document, id).toContain("docs/reference/design/service-apis.md");
    }
  });
});

describe("part indexes", () => {
  it("[T1] every catalog API has an index of its own, naming it, with parts", () => {
    for (const api of catalog().apis) {
      const path = `parts/${api.id}.json`;
      expect(existsSync(join(here, path)), path).toBe(true);
      const index = readJson(path) as { api: string; parts: string[] };
      expect(index.api, path).toBe(api.id);
      expect(Array.isArray(index.parts) && index.parts.length > 0, path).toBe(true);
    }
  });

  it("[T1] no index exists for an API the catalog does not list", () => {
    const listed = new Set(catalog().apis.map(a => a.id));
    const files = new Bun.Glob("*.json").scanSync({ cwd: join(here, "parts") });
    for (const file of files) expect(listed.has(file.replace(/\.json$/, "")), file).toBe(true);
  });
});
