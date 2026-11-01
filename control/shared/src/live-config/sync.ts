// Brings a document into line with its schema: repair rules, then a schema parse
// that fills defaults, with unknown fields kept and reported.

import { isDeepStrictEqual } from "node:util";
import type { ZodType } from "zod";

export interface RepairRule { name: string; apply(doc: Record<string, unknown>): boolean }
export interface FileSpec<T> { name: string; schema: ZodType<T>; version: number; rules: RepairRule[] }
export interface SyncResult<T> { doc: T; changed: boolean; fired: string[]; warnings: string[]; writable: boolean }

export class SyncError extends Error {
  constructor(public file: string, public path: string, detail: string) {
    super(`${file}: ${path ? `${path}: ` : ""}${detail}`);
    this.name = "SyncError";
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// Dotted path into `doc`; an array element with a string `id` is named by it, as in the unknown-field warnings.
function formatPath(path: PropertyKey[], doc: unknown): string {
  let out = "";
  let node: any = doc;
  for (const seg of path) {
    node = node?.[seg as any];
    if (typeof seg === "number") {
      out += `[${isObject(node) && typeof node.id === "string" ? node.id : seg}]`;
    } else {
      out += out ? `.${String(seg)}` : String(seg);
    }
  }
  return out;
}

// Keys that would reach an object prototype when assigned; never copied from a file.
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// Walks the raw document against the parsed one; a raw key the parse dropped is unknown, so it is re-attached and reported.
function restoreUnknown(raw: unknown, parsed: unknown, path: string, warnings: string[]): void {
  if (Array.isArray(raw) && Array.isArray(parsed)) {
    raw.forEach((item, i) => {
      const id = isObject(item) && typeof item.id === "string" ? item.id : undefined;
      restoreUnknown(item, parsed[i], `${path}${id !== undefined ? `[${id}]` : `[${i}]`}`, warnings);
    });
    return;
  }
  if (!isObject(raw) || !isObject(parsed)) return;
  for (const key of Object.keys(raw)) {
    const child = path ? `${path}.${key}` : key;
    if (UNSAFE_KEYS.has(key)) {
      warnings.push(`ignored field ${child}`);
      continue;
    }
    if (!Object.hasOwn(parsed, key)) {
      parsed[key] = structuredClone(raw[key]);
      warnings.push(`unknown field ${child}`);
    } else {
      restoreUnknown(raw[key], parsed[key], child, warnings);
    }
  }
}

// Rebuilds the parsed value with the raw document's key order, new keys last, so a sync does not reshuffle a file.
function keepOrder(raw: unknown, parsed: unknown): unknown {
  if (Array.isArray(raw) && Array.isArray(parsed)) return parsed.map((item, i) => keepOrder(raw[i], item));
  if (!isObject(raw) || !isObject(parsed)) return parsed;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) if (!UNSAFE_KEYS.has(key) && Object.hasOwn(parsed, key)) out[key] = keepOrder(raw[key], parsed[key]);
  for (const key of Object.keys(parsed)) if (!UNSAFE_KEYS.has(key) && !Object.hasOwn(out, key)) out[key] = parsed[key];
  return out;
}

export function syncDocument<T>(raw: unknown, spec: FileSpec<T>): SyncResult<T> {
  const work = structuredClone(raw);

  if (isObject(work) && typeof work.version === "number" && work.version > spec.version) {
    return {
      doc: work as T,
      changed: false,
      fired: [],
      warnings: [`${spec.name}: version ${work.version} was written by newer code (this code reads ${spec.version}); using it as it stands and not writing it back`],
      writable: false,
    };
  }

  const fired: string[] = [];
  if (isObject(work)) {
    for (const rule of spec.rules) {
      if (rule.apply(work)) fired.push(rule.name);
    }
    work.version = spec.version;
  }

  const result = spec.schema.safeParse(work);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new SyncError(spec.name, formatPath(issue.path, work), issue.message);
  }

  const warnings: string[] = [];
  const parsed = result.data;
  restoreUnknown(work, parsed, "", warnings);
  const doc = keepOrder(work, parsed) as T;
  return {
    doc,
    changed: !isDeepStrictEqual(doc, raw),
    fired,
    warnings: warnings.map(w => `${spec.name}: ${w}`),
    writable: true,
  };
}
