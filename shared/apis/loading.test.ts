// When Banter makes an explicit load or unload call (docs/reference/design/service-apis.md, "Model loading"),
// decided from the service's declarations, the roster's model and the selected adapter.

import { describe, it, expect } from "bun:test";
import { select } from "./select";
import { decideLoad, decideUnload } from "./loading";

const stream = { api: "fluid.stt.stream" };
const transcriptions = { api: "openai.audio.transcriptions" };
const triton = { api: "triton.model-repository", extends: ["resident-slot"] };
const declaredLoad = { method: "POST", path: "/v1/models", query: { model_name: "{model}" } };
const declaredUnload = { method: "DELETE", path: "/v1/models", query: { model_name: "{model}" } };

const plain = { id: "stt-a", name: "Model A", kind: "both" };
const withVariants = { ...plain, variants: [{ id: "560ms", params: [{ name: "chunkMs", value: 560 }] }] };

const service = (provides: unknown[], models?: unknown) => ({ id: "stt-a", provides, models }) as any;

// `selected` is what select returned for the call about to be made, as the voice
// engine holds it. INVENTED: decideLoad takes it unchanged, and takes `model` as the
// roster's model entry; the spec gives the parameters' names, not their types.
const selected = (op: string, svc: any) => (select as any)(op, svc, [], []);

// INVENTED: the spec names the "no call" result `none` without its representation.
const isNone = (result: unknown) => result === "none" || result == null || (result as any)?.call === "none";

const required = (autoLoad: "always" | "never", extra: object = {}) => ({ loading: "required", autoLoad, resident: "one", ...extra });

function load(svc: any, op: string, model: object, preload: boolean) {
  return (decideLoad as any)(svc, model, selected(op, svc), preload);
}

describe("decideLoad", () => {
  it("[T1] never loads for a service whose loading is none, or that declares no models, whatever else holds", () => {
    // Variants and an adapter that cannot carry one would otherwise force a load.
    expect(isNone(load(service([transcriptions], { loading: "none" }), "transcribe", withVariants, true))).toBe(true);
    expect(isNone(load(service([transcriptions]), "transcribe", withVariants, true))).toBe(true);
  });

  it("[T1] always loads explicitly, preload or not, when the service never loads on its own", () => {
    const svc = service([transcriptions, triton], required("never"));
    for (const preload of [true, false]) {
      const result = load(svc, "transcribe", plain, preload);
      expect(result.call).toBe("adapter");
      expect(result.provision).toEqual(triton);
    }
  });

  it("[T1] loads through the declared call when the service declares one and no provision performs a load", () => {
    const svc = service([transcriptions], required("never", { load: declaredLoad, unload: declaredUnload }));
    expect(load(svc, "transcribe", plain, false).call).toBe("declared");
  });

  it("[T1] loads explicitly for a model with variants when the selected adapter cannot carry one, even with preload off", () => {
    const svc = service([transcriptions, triton], required("always"));
    expect(load(svc, "transcribe", withVariants, false)).toMatchObject({ call: "adapter", provision: triton });
  });

  it("[T1] leaves a variant to the adapter that carries it, and loads again when the provision cannot", () => {
    const carries = service([stream, triton], required("always"));
    expect(isNone(load(carries, "transcribeStream", withVariants, false))).toBe(true);
    const cannot = service([{ ...stream, omits: ["parameter:chunkMs"] }, triton], required("always"));
    expect(load(cannot, "transcribeStream", withVariants, false)).toMatchObject({ call: "adapter", provision: triton });
  });

  it("[T1] a service that loads on first request is loaded ahead only when preload is on", () => {
    const svc = service([transcriptions, triton], required("always"));
    expect(load(svc, "transcribe", plain, true)).toMatchObject({ call: "adapter", provision: triton });
    expect(isNone(load(svc, "transcribe", plain, false))).toBe(true);
  });
});

describe("decideUnload", () => {
  // INVENTED: `leaving` is the roster's model entry for the model being left. An unload
  // is answered like a load, as a call of "adapter" with its provision or of "declared".
  const leaving = { id: "old-model", name: "Old model" };
  const many = (extra: object) => ({ loading: "required", autoLoad: "always", resident: "many", ...extra });

  it("[T1] unloads the model being left on a service that holds many, through the declared call", () => {
    const svc = service([transcriptions], many({ load: declaredLoad, unload: declaredUnload }));
    expect((decideUnload as any)(svc, leaving).call).toBe("declared");
  });

  it("[T1] unloads through the model repository provision when that is the service's unload call", () => {
    const svc = service([transcriptions, triton], many({}));
    expect((decideUnload as any)(svc, leaving)).toMatchObject({ call: "adapter", provision: triton });
  });

  it("[T1] leaves a service that holds one alone, since the next load replaces it", () => {
    const svc = service([transcriptions], required("always", { load: declaredLoad, unload: declaredUnload }));
    expect(isNone((decideUnload as any)(svc, leaving))).toBe(true);
  });

  it("[T1] does nothing for a service that holds many but has no unload call", () => {
    const svc = service([transcriptions], many({ load: declaredLoad }));
    expect(isNone((decideUnload as any)(svc, leaving))).toBe(true);
  });
});

describe("decideLoad when the call opens a session", () => {
  const live = { api: "deepgram.listen.live" };
  const realtime = { api: "openai.realtime" };

  it("[T3] loads explicitly before a session whose adapter does not load the model it names, even with preload off", () => {
    const svc = service([realtime, triton], required("always"));
    expect(load(svc, "transcribeStream", plain, false)).toMatchObject({ call: "adapter", provision: triton });
  });

  it("[T3] leaves the load to a session whose adapter does load the model", () => {
    const svc = service([stream, triton], required("always"));
    expect(isNone(load(svc, "transcribeStream", plain, false))).toBe(true);
  });

  it("[T3] a live listen session loads the model it names only while the provision keeps the model parameter", () => {
    const keeps = service([live, triton], required("always"));
    expect(isNone(load(keeps, "transcribeStream", plain, false))).toBe(true);
    const omits = service([{ ...live, omits: ["parameter:model"] }, triton], required("always"));
    expect(load(omits, "transcribeStream", plain, false)).toMatchObject({ call: "adapter", provision: triton });
  });
});
