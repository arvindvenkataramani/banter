// Usage: deploy-config.ts <plane|shard> <liveDir> <sourceDir> [--legacy-config PATH] [--legacy-registry PATH]
//
// sourceDir holds the repo's config.example.json and registry.example.json. The
// legacy paths name where an older layout kept the live files; they are read
// only when liveDir has no such file yet.

import { deployConfig, type LegacyPaths } from "../shared/src/live-config/deploy";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  return args.splice(i, 2)[1];
};
const legacy: LegacyPaths = {};
const legacyConfig = flag("--legacy-config");
const legacyRegistry = flag("--legacy-registry");
if (legacyConfig) legacy["config.json"] = legacyConfig;
if (legacyRegistry) legacy["registry.json"] = legacyRegistry;

const [node, liveDir, sourceDir] = args;
if ((node !== "plane" && node !== "shard") || !liveDir || !sourceDir) {
  console.error("usage: deploy-config.ts <plane|shard> <liveDir> <sourceDir> [--legacy-config PATH] [--legacy-registry PATH]");
  process.exit(2);
}

try {
  const result = await deployConfig({ node, liveDir, sourceDir, legacy });
  if (result.conflicts.length > 0) {
    console.error("deploy stopped; nothing was written. Conflicts:");
    for (const c of result.conflicts) console.error(`  ${c}`);
    process.exit(1);
  }
  console.log(`deployed: ${result.written.join(", ")}`);
} catch (err) {
  console.error(`deploy-config: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
