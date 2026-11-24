// Registry validation of provisions and model loading (dev/specs/service-apis.md,
// sections 5, 10 and 12). The meaning checks run from validateRoster on parsed
// objects; the shape rules and the round trip of the new fields go through
// loadRegistry, the path a node takes at startup.
//
// Each check has a loading case and a refused case. A refused case is the one edit
// that makes the check fail, so it fails for no other reason.
//
// INVENTED: the spec says each failure is a `registry.json roster:` or
// `registry.json services:` error but not what else the message holds. These tests
// expect it to name the service id and the offending name, key or value.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateRoster } from "../src/roster";
import { loadRegistry } from "../src/registry";
import { clearFileLocks } from "../src/atomic-write";

const ROOT = join(import.meta.dir, "..", "..", "..");
const readJson = (path: string) => JSON.parse(readFileSync(join(ROOT, path), "utf-8"));

type Doc = { services: any[]; roster: any };
const speech = { api: "openai.audio.speech" };
const transcriptions = { api: "openai.audio.transcriptions" };
const liveStream = { api: "fluid.stt.stream" };
const triton = { api: "triton.model-repository", extends: ["resident-slot"] };
const declaredLoad = { method: "POST", path: "/v1/models", query: { model_name: "{model}" } };

/** One synthesis service and one speech-to-text service, each with the smallest valid provision. */
const fresh = (): Doc => ({
  services: [
    { id: "tts-a", capabilityId: "tts", provides: [structuredClone(speech)], models: { loading: "none" } },
    { id: "stt-a", capabilityId: "stt", provides: [structuredClone(transcriptions)], models: { loading: "none" } },
  ],
  roster: {
    ttsModels: [{ id: "voice-model", name: "Voice model" }],
    sttModels: [{ id: "listen-model", name: "Listen model", kind: "both" }],
    providers: {
      "tts-a": { resolvesVoices: false, serves: [{ model: "voice-model", key: "voice-model" }] },
      "stt-a": { serves: [{ model: "listen-model", key: "listen-model" }] },
    },
    voices: [],
  },
});
const tts = (d: Doc) => d.services[0];
const stt = (d: Doc) => d.services[1];
const sttModel = (d: Doc) => d.roster.sttModels[0];
const withVariants = (d: Doc) => {
  sttModel(d).params = [{ name: "chunkMs", values: [560] }];
  sttModel(d).variants = [{ id: "560ms", params: [{ name: "chunkMs", value: 560 }] }];
};

/** The message validateRoster fails with for the edited fresh pair, or "" when it loads. */
function outcome(edit: (d: Doc) => void): string {
  const d = fresh();
  edit(d);
  try {
    validateRoster(d.roster, d.services as any);
    return "";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
function rejects(edit: (d: Doc) => void, ...names: string[]): void {
  const message = outcome(edit);
  expect(message).toMatch(/^registry\.json (roster|services):/);
  for (const name of names) expect(message).toContain(name);
}
const accepts = (edit: (d: Doc) => void = () => {}) => expect(outcome(edit)).toBe("");

describe("a roster with a provision per service", () => {
  it("[T1] a roster whose services each state the smallest valid provision loads", () => accepts());
});

describe("check 1: a service lists an API once", () => {
  it("[T1] refuses two provisions of one API and accepts two of different APIs", () => {
    rejects(d => { tts(d).provides.push({ ...speech, basePath: "/other" }); }, "tts-a", "openai.audio.speech");
    accepts(d => { tts(d).provides.push({ api: "openai.realtime" }); });
  });
});

describe("check 2: a base path begins with a slash and does not end with one", () => {
  it("[T1] accepts /relay/speech and refuses relay/speech and /relay/", () => {
    accepts(d => { tts(d).provides[0].basePath = "/relay/speech"; });
    rejects(d => { tts(d).provides[0].basePath = "relay/speech"; }, "tts-a", "relay/speech");
    rejects(d => { tts(d).provides[0].basePath = "/relay/"; }, "tts-a", "/relay/");
  });
});

describe("check 3: omits and only do not both name parts of one kind", () => {
  const realtime = (extra: object) => (d: Doc) => { tts(d).provides.push({ api: "openai.realtime", ...extra }); };

  it("[T1] accepts omits and only of different kinds, and refuses both naming client messages", () => {
    accepts(realtime({ omits: ["parameter:audio.output.voice"], only: ["client-message:session.update"] }));
    rejects(realtime({ omits: ["client-message:response.create"], only: ["client-message:session.update"] }), "tts-a", "openai.realtime");
  });
});

describe("check 4: every API and every extension is in the catalog", () => {
  it("[T1] accepts catalog ids and refuses an unknown API, the platform-only chat API and an unknown extension", () => {
    accepts(d => { tts(d).provides[0].extends = ["stream-flag", "cloning-reference"]; });
    rejects(d => { tts(d).provides.push({ api: "acme.speech" }); }, "tts-a", "acme.speech");
    rejects(d => { tts(d).provides.push({ api: "openai.chat.completions" }); }, "tts-a", "openai.chat.completions");
    rejects(d => { tts(d).provides[0].extends = ["warp-drive"]; }, "tts-a", "warp-drive");
  });
});

describe("check 5: a deviation names a part of its API's index", () => {
  it("[T1] refuses a misspelt name in omits or only", () => {
    accepts(d => { tts(d).provides[0].omits = ["parameter:instructions"]; });
    rejects(d => { tts(d).provides[0].omits = ["parameter:instruction"]; }, "tts-a", "parameter:instruction");
    rejects(d => { tts(d).provides.push({ api: "openai.realtime", only: ["client-message:session.updat"] }); }, "tts-a", "client-message:session.updat");
  });

  it("[T1] refuses a restricts or defaults key that is not a parameter of the index", () => {
    accepts(d => { tts(d).provides[0].restricts = { response_format: ["wav"] }; tts(d).provides[0].defaults = { speed: 1.5 }; });
    rejects(d => { tts(d).provides[0].restricts = { response_formats: ["wav"] }; }, "tts-a", "response_formats");
    rejects(d => { tts(d).provides[0].defaults = { speeds: 1.5 }; }, "tts-a", "speeds");
  });

  it("[T1] refuses a restricted value the index lacks where it lists values, and takes any where it lists none", () => {
    // Both indexes list the values of response_format; neither lists values of `voice`.
    accepts(d => { stt(d).provides[0].restricts = { response_format: ["json", "text"] }; });
    rejects(d => { stt(d).provides[0].restricts = { response_format: ["json", "flac"] }; }, "stt-a", "flac");
    rejects(d => { tts(d).provides[0].restricts = { response_format: ["wav", "ogg"] }; }, "tts-a", "ogg");
    // On a service no provider names, so what is restricted cannot cost a candidate.
    accepts(d => { d.services.push({ id: "idle-a", capabilityId: "tts", provides: [{ ...speech, restricts: { voice: ["alloy", "nova"] } }], models: { loading: "none" } }); });
  });
});

describe("check 6: a model that can never become resident has a load call", () => {
  const needsLoad = (d: Doc) => { tts(d).models = { loading: "required", autoLoad: "never", resident: "one" }; };

  it("[T1] refuses autoLoad never with no load call, and accepts a declared load or a repository provision", () => {
    rejects(needsLoad, "tts-a");
    accepts(d => { needsLoad(d); tts(d).models.load = declaredLoad; });
    accepts(d => { needsLoad(d); tts(d).provides.push(triton); });
  });

  it("[T1] refuses a model with variants no provision's adapter can carry, unless the service has a load call", () => {
    const resident = (d: Doc) => { withVariants(d); stt(d).models = { loading: "required", autoLoad: "always", resident: "one" }; };
    rejects(resident, "stt-a");
    accepts(d => { resident(d); stt(d).models.load = declaredLoad; });
    accepts(d => { resident(d); stt(d).provides.unshift(liveStream); });
    // The stream adapter carries a variant through the chunk parameter; a provision without it does not.
    rejects(d => { resident(d); stt(d).provides.unshift({ ...liveStream, omits: ["parameter:chunkMs"] }); }, "stt-a");
  });
});

describe("check 7: a service has one load call, never two", () => {
  it("[T1] refuses a repository provision beside a declared load, and accepts either alone", () => {
    const loads = (d: Doc) => { tts(d).models = { loading: "required", autoLoad: "never", resident: "one" }; };
    rejects(d => { loads(d); tts(d).provides.push(triton); tts(d).models.load = declaredLoad; }, "tts-a");
    accepts(d => { loads(d); tts(d).provides.push(triton); });
    accepts(d => { loads(d); tts(d).models.load = declaredLoad; });
  });
});

describe("check 8: a declared call is well formed", () => {
  const withCall = (call: object) => (d: Doc) => {
    tts(d).models = { loading: "required", autoLoad: "never", resident: "many", load: call, unload: call };
  };

  it("[T1] accepts {model} in the path, the query and the body", () => {
    accepts(withCall({ method: "POST", path: "/v1/models/{model}/load", query: { name: "{model}" }, body: { name: "{model}" } }));
  });

  it.each([
    ["has no method", { path: "/v1/models" }, "method"],
    ["names a method outside GET, POST, PUT and DELETE", { method: "PATCH", path: "/v1/models" }, "PATCH"],
    ["has a path that does not begin with a slash", { method: "POST", path: "v1/models" }, "v1/models"],
    ["uses a placeholder other than {model} in the path", { method: "POST", path: "/v1/models/{name}/load" }, "{name}"],
    ["uses a placeholder other than {model} in the query", { method: "POST", path: "/v1/models", query: { name: "{key}" } }, "{key}"],
    ["uses a placeholder other than {model} in the body", { method: "POST", path: "/v1/models", body: { name: "{id}" } }, "{id}"],
  ])("[T1] refuses a call that %s", (_, call, mention) => {
    rejects(withCall(call), "tts-a", mention);
  });
});

describe("check 9: a service Banter calls has a candidate for what it is called for", () => {
  it("[T1] a synthesis provider needs a provision of an API that synthesizes", () => {
    rejects(d => { tts(d).provides = [transcriptions]; }, "tts-a");
    rejects(d => { delete tts(d).provides; }, "tts-a");
    accepts();
  });

  it("[T1] a streaming speech-to-text model needs a streaming candidate", () => {
    const streaming = (d: Doc) => { sttModel(d).kind = "streaming"; };
    rejects(d => { streaming(d); }, "stt-a");
    accepts(d => { streaming(d); stt(d).provides = [liveStream]; });
  });

  it("[T1] a batch model needs a batch candidate, and a provision that omits the file is none", () => {
    const batch = (d: Doc) => { sttModel(d).kind = "batch"; };
    rejects(d => { batch(d); stt(d).provides = [liveStream]; }, "stt-a");
    rejects(d => { batch(d); stt(d).provides = [{ ...transcriptions, omits: ["parameter:file"] }]; }, "stt-a");
    accepts(d => { batch(d); });
  });

  it("[T1] a model of both kinds is served by either a batch or a streaming candidate", () => {
    accepts(d => { stt(d).provides = [liveStream]; });
    accepts(d => { stt(d).provides = [transcriptions]; });
  });

  it("[T1] a service no roster provider names needs no candidate", () => {
    accepts(d => { d.services.push({ id: "idle-a", capabilityId: "stt", provides: [triton], models: { loading: "none" } }); });
  });
});

describe("unknown keys are fatal", () => {
  it("[T1] in a provision, in models and in a declared call", () => {
    rejects(d => { tts(d).provides[0].omit = ["parameter:instructions"]; }, "tts-a", "omit");
    rejects(d => { tts(d).models = { loading: "none", autoload: "never" }; }, "tts-a", "autoload");
    rejects(d => {
      tts(d).models = { loading: "required", autoLoad: "never", resident: "one", load: { ...declaredLoad, headers: {} } };
    }, "tts-a", "headers");
  });
});

describe("loading a registry file", () => {
  let dir: string;
  beforeEach(async () => { clearFileLocks(); dir = await mkdtemp(join(tmpdir(), "provisions-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const registryDoc = (edit: (d: any) => void = () => {}) => {
    const d = fresh();
    const doc: any = {
      version: 4,
      type: "control",
      hosts: [{ id: "host1", name: "Host One", hostname: "host1.ts.net", role: "control" }],
      capabilities: [{ id: "tts", name: "TTS" }, { id: "stt", name: "STT" }],
      services: d.services.map((s, i) => ({
        ...s,
        hostId: "host1",
        permissions: { enabled: true },
        runner: { type: "external" },
        network: { port: 9100 + i, healthPath: "/health" },
      })),
      roster: d.roster,
    };
    edit(doc);
    return doc;
  };
  const write = async (doc: unknown) => {
    const path = join(dir, "registry.json");
    await writeFile(path, JSON.stringify(doc));
    return path;
  };
  const rejection = async (doc: unknown) => {
    try { await loadRegistry(await write(doc)); } catch (err) { return err instanceof Error ? err.message : String(err); }
    return "";
  };

  it("[T1] keeps every provision and models field, in memory and on disk, without an unknown-field warning", async () => {
    const provides = [
      { api: "openai.audio.speech", basePath: "/relay", omits: ["parameter:instructions"], restricts: { response_format: ["wav"] }, defaults: { speed: 1.5 }, extends: ["stream-flag"] },
    ];
    const models = {
      loading: "required",
      autoLoad: "never",
      resident: "many",
      load: { method: "POST", path: "/v1/models/{model}/load", query: { name: "{model}" } },
      unload: { method: "DELETE", path: "/v1/models/{model}" },
    };
    const doc = registryDoc(d => { d.services[0].provides = provides; d.services[0].models = models; });
    const path = await write(doc);

    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
    let registry;
    try { registry = await loadRegistry(path); } finally { console.warn = warn; }

    expect(registry.services[0].provides).toEqual(provides as any);
    expect(registry.services[0].models).toEqual(models as any);
    const onDisk = JSON.parse(await readFile(path, "utf-8"));
    expect(onDisk.services[0].provides).toEqual(provides);
    expect(onDisk.services[0].models).toEqual(models);
    expect(warnings.filter(w => /provides|models/.test(w))).toEqual([]);
  });

  it("[T1] a service Banter does not call is left with no provides and no models, in memory and on disk", async () => {
    const doc = registryDoc(d => {
      d.capabilities.push({ id: "search", name: "Search" });
      d.services.push({ id: "uncalled", capabilityId: "search", hostId: "host1", permissions: { enabled: true }, runner: { type: "external" }, network: { port: 9199, healthPath: "/health" } });
    });
    const path = await write(doc);
    const registry = await loadRegistry(path);
    const inMemory = registry.services.find((s: any) => s.id === "uncalled") as any;
    expect(inMemory.provides).toBeUndefined();
    expect(inMemory.models).toBeUndefined();
    const onDisk = JSON.parse(await readFile(path, "utf-8")).services.find((s: any) => s.id === "uncalled");
    expect("provides" in onDisk).toBe(false);
    expect("models" in onDisk).toBe(false);
  });

  it("[T1] a misspelt omits is fatal at load, so it cannot claim full conformance", async () => {
    const message = await rejection(registryDoc(d => { d.services[0].provides[0].omit = ["parameter:instructions"]; }));
    expect(message).toContain("omit");
  });

  it.each([
    ["models that require loading but state no autoLoad", { loading: "required", resident: "one" }, "autoLoad"],
    ["models that require loading but state no resident", { loading: "required", autoLoad: "always" }, "resident"],
    ["models that need no loading but state an autoLoad", { loading: "none", autoLoad: "always" }, "autoLoad"],
    ["models that need no loading but state a resident", { loading: "none", resident: "one" }, "resident"],
    ["a loading value outside required and none", { loading: "sometimes" }, "loading"],
  ])("[T1] refuses %s", async (_, models, mention) => {
    // The baseline registry loads (below), so the models edit is the whole difference.
    expect(await rejection(registryDoc(d => { d.services[0].models = models; }))).toContain(mention);
  });

  it("[T1] accepts both shapes of models when each is complete", async () => {
    expect(await rejection(registryDoc(d => { d.services[0].models = { loading: "required", autoLoad: "always", resident: "one" }; }))).toBe("");
    expect(await rejection(registryDoc())).toBe("");
  });
});

describe("the registries the repo ships", () => {
  const NODE_EXAMPLES = ["control/control-plane/data/registry.example.json", "control/control-shard/data/registry.example.json"];
  const ALL_EXAMPLES = [...NODE_EXAMPLES, "services/fluid/registry.fluid.example.json"];

  // Part lists compare as sets.
  const sorted = (provision: any) => ({ ...provision, ...(provision.omits && { omits: [...provision.omits].sort() }) });

  it.each(NODE_EXAMPLES)("[T1] %s states the speech-to-text and synthesis provisions of the spec", path => {
    const services = readJson(path).services as any[];
    const whisper = services.find(s => s.id === "stt-faster-whisper");
    expect(whisper.provides.map(sorted)).toEqual([{
      api: "openai.audio.transcriptions",
      omits: [
        "parameter:chunking_strategy", "parameter:include", "parameter:keywords", "parameter:known_speaker_names",
        "parameter:known_speaker_references", "parameter:languages", "parameter:prompt", "parameter:stream",
        "parameter:temperature", "parameter:timestamp_granularities",
      ],
      restricts: { response_format: ["json", "text"] },
    }]);
    expect(whisper.models).toEqual({ loading: "none" });

    const kokoro = services.find(s => s.id === "tts-kokoro");
    expect(kokoro.provides.map(sorted)).toEqual([{
      api: "openai.audio.speech",
      omits: ["parameter:instructions", "parameter:stream_format"],
      restricts: { response_format: ["wav"] },
    }]);
    expect(kokoro.models).toEqual({
      loading: "required",
      autoLoad: "always",
      resident: "one",
      load: { method: "POST", path: "/v1/models", query: { model_name: "{model}" } },
      unload: { method: "DELETE", path: "/v1/models", query: { model_name: "{model}" } },
    });
  });

  it.each(ALL_EXAMPLES)("[T1] %s validates through validateRoster", path => {
    const registry = readJson(path);
    expect(() => validateRoster(registry.roster, registry.services)).not.toThrow();
  });

  // Spec section 12, step T1. Staged copies under rails/S1 and rails/S2 replace this test as the example changes.
  it("[T1] the fluid servers state exactly the T1 provisions of the spec", () => {
    const services = readJson("services/fluid/registry.fluid.example.json").services as any[];
    const of = (id: string) => services.find(s => s.id === id);
    const sorted = (provides: any[]) => provides.map(p => ({
      ...p,
      ...(p.omits && { omits: [...p.omits].sort() }),
      ...(p.extends && { extends: [...p.extends].sort() }),
    })).sort((a, b) => a.api.localeCompare(b.api));
    expect(sorted(of("fluid-stt").provides)).toEqual(sorted([
      { api: "fluid.stt.stream" },
      {
        api: "openai.audio.transcriptions",
        omits: ["parameter:language", "parameter:languages", "parameter:keywords", "parameter:prompt", "parameter:temperature", "parameter:include", "parameter:stream", "parameter:chunking_strategy", "parameter:known_speaker_names", "parameter:known_speaker_references"],
        restricts: { response_format: ["json", "text", "verbose_json"] },
      },
    ]));
    expect(sorted(of("fluid-tts").provides)).toEqual(sorted([
      {
        api: "openai.audio.speech",
        omits: ["parameter:instructions", "parameter:stream_format"],
        restricts: { response_format: ["aac", "wav", "pcm"] },
        extends: ["stream-flag", "cloning-reference"],
      },
    ]));
    for (const id of ["fluid-stt", "fluid-tts"]) {
      expect(of(id).models).toEqual({ loading: "required", autoLoad: "always", resident: "one" });
    }
  });

  it.each(ALL_EXAMPLES)("[T1] %s's provisions and model loading validate against the registry JSON schema", async path => {
    const { default: Ajv2020 } = await import("ajv/dist/2020");
    const schema = readJson("schemas/platform.schema.json");
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    ajv.addSchema(schema);
    const provision = ajv.getSchema(`${schema.$id}#/$defs/provision`)!;
    const modelLoading = ajv.getSchema(`${schema.$id}#/$defs/modelLoading`)!;

    const problems: string[] = [];
    for (const service of readJson(path).services as any[]) {
      for (const p of service.provides ?? []) {
        if (!provision(p)) problems.push(`${service.id} ${provision.errors!.map(e => `${e.instancePath} ${e.message}`).join("; ")}`);
      }
      if (service.models !== undefined && !modelLoading(service.models)) {
        problems.push(`${service.id} ${modelLoading.errors!.map(e => `${e.instancePath} ${e.message}`).join("; ")}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("[T1] the JSON schema refuses an unknown provision key, required loading facts left out, and a declared call with no method", async () => {
    const { default: Ajv2020 } = await import("ajv/dist/2020");
    const schema = readJson("schemas/platform.schema.json");
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    ajv.addSchema(schema);
    const provision = ajv.getSchema(`${schema.$id}#/$defs/provision`)!;
    const modelLoading = ajv.getSchema(`${schema.$id}#/$defs/modelLoading`)!;

    expect(provision({ api: "openai.audio.speech", omit: ["parameter:instructions"] })).toBe(false);
    expect(modelLoading({ loading: "required" })).toBe(false);
    expect(modelLoading({ loading: "required", autoLoad: "never", resident: "one", load: { path: "/load" } })).toBe(false);
    expect(modelLoading({ loading: "required", autoLoad: "never", resident: "one", load: { method: "POST", path: "/load" } })).toBe(true);
  });
});
