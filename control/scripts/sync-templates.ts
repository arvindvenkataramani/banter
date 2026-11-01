// Brings the repo's three example files into line with their schemas.
// Run by a developer and by the pre-commit hook, never by a running process.

import { readFileSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { syncDocument, type FileSpec } from "../shared/src/live-config/sync";
import { moveRuntimeState } from "../shared/src/live-config/rules";
import { configSpec, registrySpec } from "../shared/src/live-config/schemas";

const root = join(import.meta.dir, "..");
const templates: [string, FileSpec<any>][] = [
  ["control-plane/data/config.example.json", configSpec],
  ["control-plane/data/registry.example.json", registrySpec],
  ["control-shard/data/registry.example.json", registrySpec],
];

for (const [rel, spec] of templates) {
  const path = join(root, rel);
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (spec === configSpec) moveRuntimeState(raw, {});
  const result = syncDocument(raw, spec);
  for (const w of result.warnings) console.warn(`${rel}: ${w}`);
  if (result.writable && !isDeepStrictEqual(result.doc, JSON.parse(readFileSync(path, "utf8")))) {
    writeFileSync(path, JSON.stringify(result.doc, null, 2) + "\n");
    console.log(`synced ${rel}`);
  }
}
