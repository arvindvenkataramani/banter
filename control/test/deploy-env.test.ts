import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// deploy-env.sh is sourced by every deploy, install, run and dev script, so what
// it resolves is what all of them act on. Each test sources a copy of it in a
// fresh bash with a temporary HOME and only the variables the test names. The
// copy sits in a temporary ops/ so a deploy.conf can sit beside it, where
// the real one does.

const DEPLOY_ENV = resolve(import.meta.dir, "../../ops/deploy-env.sh");

let home: string;
let scripts: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "deploy-env-"));
  scripts = join(home, "checkout/ops");
  await mkdir(scripts, { recursive: true });
  await copyFile(DEPLOY_ENV, join(scripts, "deploy-env.sh"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function source(script: string, env: Record<string, string> = {}) {
  const proc = Bun.spawnSync(["bash", "-c", `set -euo pipefail; source "${join(scripts, "deploy-env.sh")}"; ${script}`], {
    env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
  });
  return { code: proc.exitCode, out: proc.stdout.toString().trim(), err: proc.stderr.toString() };
}

const writeConf = (body: string) => writeFile(join(scripts, "deploy.conf"), body);

describe("deploy.conf", () => {
  it("an environment variable wins over deploy.conf, which wins over the default", async () => {
    await writeConf(`BANTER_EVENTS_PATH=/conf/events.jsonl\nBANTER_STAGE_DIR=/conf/stage\n`);
    const r = source(`echo "$BANTER_EVENTS_PATH|$BANTER_STAGE_DIR|$BANTER_LIVE_DIR"`, { BANTER_EVENTS_PATH: "/env/events.jsonl" });
    expect(r.code).toBe(0);
    expect(r.out).toBe(`/env/events.jsonl|/conf/stage|${home}/services/banter`);
  });

  it("is read from the ops/ folder beside deploy-env.sh", async () => {
    await writeConf(`BANTER_STAGE_DIR=/from-checkout\n`);
    expect(source(`echo "$BANTER_STAGE_DIR"`).out).toBe("/from-checkout");
  });

  it("setting only BANTER_LIVE_DIR moves the registry and config paths with it", async () => {
    await writeConf(`BANTER_LIVE_DIR=/srv/live\n`);
    const r = source(`echo "$BANTER_REGISTRY_PATH|$BANTER_CONFIG_PATH"`);
    expect(r.out).toBe("/srv/live/registry.json|/srv/live/config.json");
  });

  it("puts the control plane's and the shard's live files at the top of their deployment folders", () => {
    const r = source(`echo "$BANTER_REGISTRY_PATH|$BANTER_CONFIG_PATH|$BANTER_SHARD_REGISTRY_PATH"`);
    expect(r.out).toBe(`${home}/services/banter/registry.json|${home}/services/banter/config.json|${home}/services/banter/registry.json`);
  });

  it("refuses a non-default BANTER_PROD with the default BANTER_UNIT, naming both", async () => {
    await writeConf(`BANTER_PROD=/srv/other\n`);
    const r = source(`echo reached`);
    expect(r.code).not.toBe(0);
    expect(r.out).not.toContain("reached");
    expect(r.err).toContain("/srv/other");
    expect(r.err).toContain("BANTER_UNIT");

    expect(source(`echo reached`, { BANTER_UNIT: "banter-other" }).out).toBe("reached");
  });
});

describe("platform_detect_node", () => {
  async function registry(path: string, type: string) {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify({ version: 3, type, hosts: [], capabilities: [], services: [] }));
  }

  it("answers control for a control registry", async () => {
    const reg = join(home, "plane/registry.json");
    await registry(reg, "control");
    const r = source(`platform_detect_node; echo "$NODE|$REGISTRY"`, { BANTER_REGISTRY_PATH: reg, BANTER_SHARD_REGISTRY_PATH: join(home, "none.json") });
    expect(r.out).toBe(`control|${reg}`);
  });

  it("answers shard when the file at the control path is a shard registry", async () => {
    // Both nodes default to one folder, so the two default paths are one file.
    const reg = join(home, "same/registry.json");
    await registry(reg, "shard");
    const r = source(`platform_detect_node; echo "$NODE|$REGISTRY"`, { BANTER_REGISTRY_PATH: reg, BANTER_SHARD_REGISTRY_PATH: reg });
    expect(r.out).toBe(`shard|${reg}`);
  });

  it("fails naming both paths when neither registry exists", async () => {
    const a = join(home, "a/registry.json");
    const b = join(home, "b/registry.json");
    const r = source(`platform_detect_node; echo reached`, { BANTER_REGISTRY_PATH: a, BANTER_SHARD_REGISTRY_PATH: b });
    expect(r.code).not.toBe(0);
    expect(r.out).not.toContain("reached");
    expect(r.err).toContain(a);
    expect(r.err).toContain(b);
  });
});
