// Candidate selection (dev/specs/service-apis.md, section 6): which provision of a
// service performs an operation, from what the provisions declare and nothing else.
//
// The cases use the adapters of openai.audio.transcriptions, fluid.stt.stream and
// triton.model-repository, whose declarations the spec states (section 8). Each
// capability is toggled by omitting the part it rests on, so a case holds whatever
// else an adapter requires.

import { describe, it, expect } from "bun:test";
import { select } from "./select";

// INVENTED: the spec says select's result is "the winning provision and its adapter"
// and that nothing left is "a refusal whose message ..." without saying whether the
// refusal is thrown or returned. This helper accepts a throw, or a returned value
// that has no `provision` and carries the text as `refusal`, `message` or `error`.
type Outcome = { provision?: any; adapter?: unknown; refusal?: string };
function attempt(...args: any[]): Outcome {
  let result: any;
  try {
    result = (select as any)(...args);
  } catch (err) {
    return { refusal: err instanceof Error ? err.message : String(err) };
  }
  if (result?.provision) return result;
  return { refusal: result?.refusal ?? result?.message ?? result?.error };
}

const stream = { api: "fluid.stt.stream" };
const transcriptions = { api: "openai.audio.transcriptions" };
const triton = { api: "triton.model-repository", extends: ["resident-slot"] };

const service = (provides: unknown[], id = "fluid-stt") => ({ id, provides, models: undefined }) as any;

describe("which provisions are candidates", () => {
  it("[T1] an operation goes to the provision whose API's adapter performs it, wherever it sits in provides", () => {
    const both = service([stream, transcriptions]);
    expect(attempt("transcribe", both, [], []).provision.api).toBe("openai.audio.transcriptions");
    const live = attempt("transcribeStream", both, ["client-endpointing"], []);
    expect(live.provision.api).toBe("fluid.stt.stream");
    expect(live.adapter).toBeTruthy();
  });

  it("[T1] loading and unloading go to the model repository provision", () => {
    const svc = service([stream, triton]);
    expect(attempt("loadModel", svc, [], []).provision.api).toBe("triton.model-repository");
    expect(attempt("unloadModel", svc, [], []).provision.api).toBe("triton.model-repository");
    expect(attempt("loadModel", service([stream]), [], []).refusal).toBeDefined();
  });

  it("[T1] a provision that omits a part the adapter requires is no candidate, and one that omits nothing it requires is", () => {
    expect(attempt("transcribe", service([{ ...transcriptions, omits: ["parameter:file"] }]), [], []).refusal).toBeDefined();
    expect(attempt("transcribe", service([{ ...transcriptions, omits: ["parameter:prompt"] }]), [], []).provision.api)
      .toBe("openai.audio.transcriptions");
  });

  it("[T1] a provision whose `only` leaves out a part the adapter requires is no candidate", () => {
    expect(attempt("transcribe", service([{ ...transcriptions, only: ["parameter:model"] }]), [], []).refusal).toBeDefined();
    expect(attempt("transcribe", service([{ ...transcriptions, only: ["parameter:file", "parameter:model"] }]), [], []).provision.api)
      .toBe("openai.audio.transcriptions");
  });
});

describe("needs", () => {
  it("[T1] a provision holding no basis for a needed capability is dropped, and one that holds a basis is kept", () => {
    const noTakeover = service([{ ...stream, omits: ["parameter:session"] }]);
    expect(attempt("transcribeStream", noTakeover, ["takeover"], []).refusal).toBeDefined();
    expect(attempt("transcribeStream", service([stream]), ["takeover"], []).provision.api).toBe("fluid.stt.stream");
    // The same service without the need is still a candidate.
    expect(attempt("transcribeStream", noTakeover, [], []).provision.api).toBe("fluid.stt.stream");
  });

  it("[T1] an extension basis holds only when the provision declares the extension", () => {
    const listen = { api: "deepgram.listen.live" };
    expect(attempt("transcribeStream", service([listen]), ["client-endpointing"], []).refusal).toBeDefined();
    expect(attempt("transcribeStream", service([{ ...listen, extends: ["endpointing-off"] }]), ["client-endpointing"], []).provision.api).toBe("deepgram.listen.live");
  });

  it("[T1] a restriction that removes the value a capability rests on drops that capability", () => {
    const listen = { api: "deepgram.listen.live", extends: ["endpointing-off", "opus-packets"] };
    expect(attempt("transcribeStream", service([listen]), ["opus"], []).provision.api).toBe("deepgram.listen.live");
    expect(attempt("transcribeStream", service([{ ...listen, restricts: { encoding: ["linear16"] } }]), ["opus"], []).refusal).toBeDefined();
  });

  it("[T1] every needed capability must hold, not any one of them", () => {
    const noVariant = service([{ ...stream, omits: ["parameter:chunkMs"] }]);
    expect(attempt("transcribeStream", noVariant, ["takeover", "carries-variant"], []).refusal).toBeDefined();
    expect(attempt("transcribeStream", noVariant, ["takeover", "opus"], []).provision.api).toBe("fluid.stt.stream");
  });
});

describe("ranking", () => {
  // INVENTED: select does not check that a service lists an API once, so two provisions
  // of one API stand in for two candidates whose capabilities differ. The first lacks
  // take-over, the second lacks variants.
  const noTakeover = { ...stream, omits: ["parameter:session"], basePath: "/no-takeover" };
  const noVariant = { ...stream, omits: ["parameter:chunkMs"], basePath: "/no-variant" };

  it("[T1] holding a preferred capability ranks before not holding it, compared in preference order", () => {
    for (const provides of [[noTakeover, noVariant], [noVariant, noTakeover]]) {
      expect(attempt("transcribeStream", service(provides), [], ["takeover", "carries-variant"]).provision.basePath).toBe("/no-variant");
      expect(attempt("transcribeStream", service(provides), [], ["carries-variant", "takeover"]).provision.basePath).toBe("/no-takeover");
    }
  });

  it("[T1] ties keep provides order, whether or not there are preferences", () => {
    const first = { ...stream, basePath: "/first" };
    const second = { ...stream, basePath: "/second" };
    for (const preferences of [[], ["takeover", "opus"]]) {
      expect(attempt("transcribeStream", service([first, second]), [], preferences).provision.basePath).toBe("/first");
      expect(attempt("transcribeStream", service([second, first]), [], preferences).provision.basePath).toBe("/second");
    }
  });
});

describe("refusal", () => {
  it("[T1] names the service, the operation and every API the service declares", () => {
    const svc = service([transcriptions, triton]);
    expect(attempt("transcribeStream", svc, ["client-endpointing"], []).refusal)
      .toBe("fluid-stt cannot transcribeStream: it provides openai.audio.transcriptions, triton.model-repository");
  });

  it("[T1] is the same refusal when the candidates were all dropped for a part or a need", () => {
    const refusal = attempt("transcribe", service([{ ...transcriptions, omits: ["parameter:file"] }], "stt-edge"), [], []).refusal;
    expect(refusal).toBe("stt-edge cannot transcribe: it provides openai.audio.transcriptions");
  });
});
