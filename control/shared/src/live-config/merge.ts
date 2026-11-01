// Three-way merge of JSON values, field by field; keyed arrays merge by element id.

import { isDeepStrictEqual } from "node:util";

export interface MergeResult { merged: unknown; conflicts: string[] }

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const ABSENT = Symbol("absent");
const same = (a: unknown, b: unknown) => isDeepStrictEqual(a, b);

export function mergeJson(base: unknown, ours: unknown, theirs: unknown, keyedArrays: Record<string, string> = {}): MergeResult {
  const conflicts: string[] = [];
  const merged = mergeValue(base, ours, theirs, "", keyedArrays, conflicts);
  return { merged: merged === ABSENT ? undefined : merged, conflicts };
}

function mergeValue(base: unknown, ours: unknown, theirs: unknown, path: string, keyed: Record<string, string>, conflicts: string[]): unknown {
  if (same(ours, theirs)) return ours;
  if (same(base, ours)) return theirs;
  if (same(base, theirs)) return ours;

  if (isObject(ours) && isObject(theirs)) {
    return mergeObjects(isObject(base) ? base : {}, ours, theirs, path, keyed, conflicts);
  }
  const idField = keyed[path];
  if (idField && Array.isArray(ours) && Array.isArray(theirs)) {
    return mergeKeyed(Array.isArray(base) ? base : [], ours, theirs, idField, path, keyed, conflicts);
  }
  conflicts.push(path);
  return ours;
}

function mergeObjects(base: Obj, ours: Obj, theirs: Obj, path: string, keyed: Record<string, string>, conflicts: string[]): Obj {
  const out: Obj = {};
  const keys = new Set([...Object.keys(ours), ...Object.keys(theirs), ...Object.keys(base)]);
  for (const key of keys) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    const get = (o: Obj) => (Object.hasOwn(o, key) ? o[key] : ABSENT);
    const value = mergeValue(get(base), get(ours), get(theirs), path ? `${path}.${key}` : key, keyed, conflicts);
    if (value !== ABSENT) out[key] = value;
  }
  return out;
}

function mergeKeyed(base: unknown[], ours: unknown[], theirs: unknown[], idField: string, path: string, keyed: Record<string, string>, conflicts: string[]): unknown[] {
  const idOf = (el: unknown) => (isObject(el) ? String(el[idField]) : undefined);
  const index = (arr: unknown[]) => new Map(arr.map(el => [idOf(el), el] as const));
  const b = index(base), o = index(ours), t = index(theirs);
  const out: unknown[] = [];
  const emit = (id: string | undefined) => {
    const get = (m: Map<string | undefined, unknown>) => (m.has(id) ? m.get(id) : ABSENT);
    const value = mergeValue(get(b), get(o), get(t), `${path}[${id}]`, keyed, conflicts);
    if (value !== ABSENT) out.push(value);
  };
  for (const id of o.keys()) emit(id);
  for (const id of t.keys()) if (!o.has(id)) emit(id);
  return out;
}
