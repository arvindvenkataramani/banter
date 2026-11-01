// Bringing a file into line with its schema: defaults, kept values, unknown
// fields, repair rules, versions. The schema here is a tiny stand-in, not a real one.

import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { syncDocument, SyncError, type FileSpec, type RepairRule } from "../src/live-config/sync";

const schema = z.object({
  version: z.number().optional(),
  name: z.string().default("unnamed"),
  limit: z.number().default(10),
  nested: z.object({ depth: z.number().default(1) }).default({ depth: 1 }),
});

// Old shape: `title` was later renamed `name`.
const renameTitle: RepairRule = {
  name: "rename-title",
  apply(doc) {
    if (!("title" in doc) || "name" in doc) return false;
    doc.name = doc.title;
    delete doc.title;
    return true;
  },
};

const spec: FileSpec<z.infer<typeof schema>> = { name: "thing.json", schema, version: 2, rules: [renameTitle] };
const current = { version: 2, name: "a", limit: 5, nested: { depth: 3 } };

describe("syncing a document with its schema", () => {
  it("adds a field the file lacks with the schema's default", () => {
    const r = syncDocument({ version: 2, name: "a" }, spec);
    expect(r.doc.limit).toBe(10);
    expect(r.doc.nested).toEqual({ depth: 1 });
    expect(r.changed).toBe(true);
  });

  it("keeps every value the file already has", () => {
    const r = syncDocument(current, spec);
    expect(r.doc).toEqual(current);
    expect(r.changed).toBe(false);
  });

  it("keeps unknown fields at any depth and warns with each one's dotted path", () => {
    const r = syncDocument({ ...current, extra: 1, nested: { depth: 3, deeper: { x: 1 } } }, spec);
    expect((r.doc as any).extra).toBe(1);
    expect((r.doc as any).nested.deeper).toEqual({ x: 1 });
    expect(r.warnings.some(w => w.includes("extra"))).toBe(true);
    expect(r.warnings.some(w => w.includes("nested.deeper"))).toBe(true);
  });

  it.each([
    ["lower", { ...current, version: 1 }],
    ["absent", { name: "a", limit: 5, nested: { depth: 3 } }],
  ])("stamps the schema's version when the file's is %s, and reports the file changed", (_, raw) => {
    const r = syncDocument(raw, spec);
    expect(r.doc.version).toBe(2);
    expect(r.changed).toBe(true);
    expect(r.writable).toBe(true);
  });

  it("uses a file from newer code as it stands: not writable, warned about, no rules applied", () => {
    const raw = { version: 5, title: "old-shaped", limit: 5, nested: { depth: 3 } };
    const r = syncDocument(raw, spec);
    expect(r.writable).toBe(false);
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.fired).toEqual([]);
    expect(r.doc.version).toBe(5);
    expect((r.doc as any).title).toBe("old-shaped");
  });

  it("throws a SyncError naming the file and the dotted path for a wrong-typed value no rule fixes", () => {
    let caught: unknown;
    try {
      syncDocument({ ...current, nested: { depth: "deep" } }, spec);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SyncError);
    expect((caught as SyncError).file).toBe("thing.json");
    expect((caught as SyncError).path).toBe("nested.depth");
  });

  it("runs repair rules before the schema, so a renamed field keeps its value and the rule is reported fired", () => {
    const r = syncDocument({ version: 1, title: "kept", limit: 5, nested: { depth: 3 } }, spec);
    expect(r.doc.name).toBe("kept");
    expect((r.doc as any).title).toBeUndefined();
    expect(r.fired).toEqual(["rename-title"]);
  });

  it("changes nothing the second time: its own output syncs with changed false and no rules fired", () => {
    const first = syncDocument({ title: "kept", extra: 1 }, spec);
    const second = syncDocument(first.doc, spec);
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.fired).toEqual([]);
    expect(second.doc).toEqual(first.doc);
  });
});
