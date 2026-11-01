// Deploys the repo's shipped configuration into a node's live directory by a
// three-way merge of the previous ship, the live file and the new ship. The repo
// ships `config.example.json` and `registry.example.json`; the live directory
// holds `config.json` and `registry.json`.

import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic-write";
import { validateRegistry } from "../registry";
import { mergeJson } from "./merge";
import { moveRuntimeState } from "./rules";
import { configSpec, registrySpec, stateSpec } from "./schemas";
import { syncDocument, type FileSpec } from "./sync";

/** The old places a first deploy reads a live file from, by live file name. Used only when the live directory has no such file yet. */
export type LegacyPaths = Partial<Record<"config.json" | "registry.json", string>>;

export interface DeployResult { written: string[]; conflicts: string[] }

type Doc = Record<string, unknown>;
const isObject = (v: unknown): v is Doc => typeof v === "object" && v !== null && !Array.isArray(v);
const serialize = (doc: unknown) => JSON.stringify(doc, null, 2) + "\n";

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

// The source restricted to what the live file holds, so a deploy with no previous ship keeps every live value and adds only what the source adds.
// Arrays are matched by id only where `keyed` names them, as in the merge.
function prune(source: unknown, live: unknown, keyed: Record<string, string>, path = ""): unknown {
  if (isObject(source) && isObject(live)) {
    const out: Doc = {};
    for (const key of Object.keys(source)) if (key in live) out[key] = prune(source[key], live[key], keyed, path ? `${path}.${key}` : key);
    return out;
  }
  const idField = keyed[path];
  if (idField && Array.isArray(source) && Array.isArray(live)) {
    const liveById = new Map(live.filter(isObject).map(e => [e[idField], e] as const));
    return source
      .filter(e => isObject(e) && liveById.has(e[idField]))
      .map(e => prune(e, liveById.get((e as Doc)[idField]), keyed, `${path}[${(e as Doc)[idField]}]`));
  }
  return source;
}

// Steps of a dotted path such as `services[svc1].ops.env`: object keys, and array selectors from brackets.
function pathSteps(path: string): { key?: string; select?: string }[] {
  return [...path.matchAll(/([^.[\]]+)|\[([^\]]*)\]/g)].map(m => (m[1] !== undefined ? { key: m[1] } : { select: m[2] }));
}

function step(node: unknown, s: { key?: string; select?: string }): unknown {
  if (s.key !== undefined) return isObject(node) ? node[s.key] : undefined;
  if (!Array.isArray(node)) return undefined;
  return node.find(e => isObject(e) && e.id === s.select) ?? node[Number(s.select)];
}

// Puts back fields the live file holds that the schema does not know, when the merge dropped them.
// An element removed from the merged document stays removed.
function restoreUnknown(merged: unknown, live: unknown, warnings: string[]): void {
  for (const w of warnings) {
    const path = /unknown field (.+)$/.exec(w)?.[1];
    if (!path) continue;
    const steps = pathSteps(path);
    const last = steps[steps.length - 1];
    let from: unknown = live;
    let into: unknown = merged;
    for (const s of steps.slice(0, -1)) {
      from = step(from, s);
      into = step(into, s);
    }
    if (last.key !== undefined && isObject(from) && isObject(into) && last.key in from && !(last.key in into)) {
      into[last.key] = structuredClone(from[last.key]);
    }
  }
}

export async function deployConfig(opts: { node: "plane" | "shard"; liveDir: string; sourceDir: string; legacy?: LegacyPaths }): Promise<DeployResult> {
  const { node, liveDir, sourceDir, legacy = {} } = opts;
  const names = node === "plane" ? ["config.json", "registry.json"] : ["registry.json"];
  const specs: Record<string, FileSpec<any>> = { "config.json": configSpec, "registry.json": registrySpec };
  const statePath = join(liveDir, "state", "state.json");

  const conflicts: string[] = [];
  const plan: { name: string; merged: unknown; shipped: unknown }[] = [];
  let state: Doc | undefined;

  for (const name of names) {
    const spec = specs[name];
    const keyed: Record<string, string> = name === "registry.json" ? { services: "id", hosts: "id", capabilities: "id" } : {};
    const exampleName = name.replace(/\.json$/, ".example.json");
    const source = await readJson(join(sourceDir, exampleName));
    if (source === undefined) throw new Error(`${join(sourceDir, exampleName)} not found`);
    const shipped = syncDocument(source, spec).doc;
    // A first deploy has no live file; the file an older layout kept elsewhere stands in for it.
    let liveRaw = await readJson(join(liveDir, name));
    if (liveRaw === undefined && legacy[name as keyof LegacyPaths]) liveRaw = await readJson(legacy[name as keyof LegacyPaths]!);

    let merged: unknown = shipped;
    if (liveRaw !== undefined) {
      const newer = isObject(liveRaw) && typeof liveRaw.version === "number" && liveRaw.version > spec.version;
      if (name === "config.json" && isObject(liveRaw) && !newer) {
        state ??= syncDocument((await readJson(statePath)) ?? {}, stateSpec).doc as Doc;
        moveRuntimeState(liveRaw, state);
      }
      const liveSync = syncDocument(liveRaw, spec);
      const live = liveSync.doc;
      const previous = await readJson(join(liveDir, "shipped", name));
      const base = previous !== undefined ? syncDocument(previous, spec).doc : prune(shipped, live, keyed);
      const result = mergeJson(base, live, shipped, keyed);
      // The live value of a field the schema does not know wins, so a clash there is not a conflict.
      const unknown = liveSync.warnings.map(w => /unknown field (.+)$/.exec(w)?.[1]).filter((p): p is string => !!p);
      const inUnknown = (c: string) => unknown.some(p => c === p || c.startsWith(`${p}.`) || c.startsWith(`${p}[`));
      conflicts.push(...result.conflicts.filter(c => !inUnknown(c)).map(c => `${name}: ${c}`));
      merged = result.merged;
      restoreUnknown(merged, live, liveSync.warnings);
    }

    if (name === "registry.json") {
      try {
        validateRegistry(structuredClone(merged));
      } catch (err) {
        conflicts.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    plan.push({ name, merged, shipped });
  }

  if (conflicts.length > 0) return { written: [], conflicts };

  await mkdir(join(liveDir, "shipped"), { recursive: true });
  const written: string[] = [];
  if (state) {
    await mkdir(join(liveDir, "state"), { recursive: true });
    await writeFileAtomic(statePath, serialize(state));
  }
  for (const { name, merged, shipped } of plan) {
    await writeFileAtomic(join(liveDir, name), serialize(merged));
    await writeFileAtomic(join(liveDir, "shipped", name), serialize(shipped));
    written.push(name, join("shipped", name));
  }
  return { written, conflicts: [] };
}
