// Three-way merge of JSON, field by field, so neighbouring fields edited on
// opposite sides never conflict (a line-based merge reports them as one).

import { describe, it, expect } from "bun:test";
import { mergeJson } from "../src/live-config/merge";

const KEYED = { services: "id" };

describe("three-way JSON merge", () => {
  it.each([
    ["theirs", { a: 1, b: 2 }, { a: 1, b: 2 }, { a: 1, b: 9 }, { a: 1, b: 9 }],
    ["ours", { a: 1, b: 2 }, { a: 1, b: 9 }, { a: 1, b: 2 }, { a: 1, b: 9 }],
  ])("takes a field changed only in %s", (_, base, ours, theirs, expected) => {
    expect(mergeJson(base, ours, theirs)).toEqual({ merged: expected, conflicts: [] });
  });

  it("merges neighbouring fields changed on opposite sides without a conflict", () => {
    const base = { voice: { speed: 1, model: "m1" } };
    const r = mergeJson(base, { voice: { speed: 1.2, model: "m1" } }, { voice: { speed: 1, model: "m2" } });
    expect(r).toEqual({ merged: { voice: { speed: 1.2, model: "m2" } }, conflicts: [] });
  });

  it("accepts a field both sides changed to the same value", () => {
    const r = mergeJson({ a: 1 }, { a: 2 }, { a: 2 });
    expect(r).toEqual({ merged: { a: 2 }, conflicts: [] });
  });

  it("lists a field both sides changed differently as a conflict by dotted path, keeping ours", () => {
    const r = mergeJson({ voice: { speed: 1 } }, { voice: { speed: 2 } }, { voice: { speed: 3 } });
    expect(r.conflicts).toEqual(["voice.speed"]);
    expect(r.merged).toEqual({ voice: { speed: 2 } });
  });

  it("keeps keys added on one side and drops keys deleted on one side", () => {
    const base = { a: 1, b: 2 };
    const r = mergeJson(base, { a: 1, b: 2, added: true }, { a: 1 });
    expect(r).toEqual({ merged: { a: 1, added: true }, conflicts: [] });
  });

  it("merges a service added on one side with a field edited inside another service on the other", () => {
    const base = { services: [{ id: "x", port: 1, enabled: true }] };
    const ours = { services: [{ id: "x", port: 1, enabled: false }] };
    const theirs = { services: [{ id: "x", port: 1, enabled: true }, { id: "y", port: 2 }] };
    const r = mergeJson(base, ours, theirs, KEYED);
    expect(r.conflicts).toEqual([]);
    expect(r.merged).toEqual({ services: [{ id: "x", port: 1, enabled: false }, { id: "y", port: 2 }] });
  });

  it("removes a keyed element removed on one side and names a same-field edit conflict as services[<id>].field", () => {
    const base = { services: [{ id: "x", port: 1 }, { id: "y", port: 2 }] };
    const ours = { services: [{ id: "x", port: 5 }] };
    const theirs = { services: [{ id: "x", port: 6 }, { id: "y", port: 2 }] };
    const r = mergeJson(base, ours, theirs, KEYED);
    expect(r.conflicts).toEqual(["services[x].port"]);
    expect(r.merged).toEqual({ services: [{ id: "x", port: 5 }] });
  });

  it("treats an array not named as keyed as a single value: changed on both sides is a conflict", () => {
    const r = mergeJson({ tags: ["a"] }, { tags: ["a", "b"] }, { tags: ["a", "c"] });
    expect(r.conflicts).toEqual(["tags"]);
    expect(r.merged).toEqual({ tags: ["a", "b"] });
  });
});
