import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// The plane's configuration and registry live inside the deployed tree, and the
// deploy removes that tree before copying a fresh one in. Neither file is
// tracked — only an example of each is — so a deploy from a clean extraction of
// the main line copies examples over both and the live files are gone.
//
// The contract from the design doc:
//   - live files in the destination survive a deploy exactly as they were
//   - an example is written only where no live file exists — a first deploy
//   - nothing else: no comparison against the example, no reporting of new
//     settings, no merge
//
// These drive the preserve/restore step directly against a temp destination.
// The step has to work across the removal, so the tests set a destination up,
// run the save, delete the tree the way the deploy does, run the restore, and
// assert on what is there afterwards.

const SCRIPT = join(import.meta.dir, "../../scripts/deploy-preserve-config.sh")

const LIVE_CONFIG = JSON.stringify({ version: 2, runtime: { host: "live-host" } }, null, 2)
const LIVE_REGISTRY = JSON.stringify({ version: 2, type: "control", services: [{ id: "live-svc" }] }, null, 2)
const EXAMPLE_CONFIG = JSON.stringify({ version: 2, runtime: { host: "localhost" } }, null, 2)
const EXAMPLE_REGISTRY = JSON.stringify({ version: 2, type: "control", services: [] }, null, 2)

const DATA_REL = "control/control-plane/data"

let tmpDir: string

async function run(subcommand: "save" | "restore", dest: string, stash: string) {
  const proc = Bun.spawn({
    cmd: ["bash", SCRIPT, subcommand, dest, stash],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode, output: stdout + stderr }
}

/** A destination holding live config and registry, as a running deployment would. */
async function makeLiveDest(): Promise<string> {
  const dest = join(tmpDir, "prod")
  await mkdir(join(dest, DATA_REL), { recursive: true })
  await writeFile(join(dest, DATA_REL, "config.json"), LIVE_CONFIG)
  await writeFile(join(dest, DATA_REL, "registry.json"), LIVE_REGISTRY)
  return dest
}

/** Replace the destination's tree the way the deploy does: remove, then copy examples in. */
async function simulateDeployCopy(dest: string) {
  await rm(join(dest, "control"), { recursive: true, force: true })
  await mkdir(join(dest, DATA_REL), { recursive: true })
  await writeFile(join(dest, DATA_REL, "config.example.json"), EXAMPLE_CONFIG)
  await writeFile(join(dest, DATA_REL, "registry.example.json"), EXAMPLE_REGISTRY)
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8")
  } catch {
    return null
  }
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "deploy-preserve-"))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe("live configuration survives a deploy", () => {
  it("config.json is byte-identical after the tree is removed and rebuilt", async () => {
    const dest = await makeLiveDest()
    const stash = join(tmpDir, "stash")

    await run("save", dest, stash)
    await simulateDeployCopy(dest)
    await run("restore", dest, stash)

    expect(await readFile(join(dest, DATA_REL, "config.json"), "utf-8")).toBe(LIVE_CONFIG)
  })

  it("registry.json is byte-identical after the tree is removed and rebuilt", async () => {
    const dest = await makeLiveDest()
    const stash = join(tmpDir, "stash")

    await run("save", dest, stash)
    await simulateDeployCopy(dest)
    await run("restore", dest, stash)

    expect(await readFile(join(dest, DATA_REL, "registry.json"), "utf-8")).toBe(LIVE_REGISTRY)
  })

  it("the example does not overwrite a live file", async () => {
    const dest = await makeLiveDest()
    const stash = join(tmpDir, "stash")

    await run("save", dest, stash)
    await simulateDeployCopy(dest)
    await run("restore", dest, stash)

    const config = await readFile(join(dest, DATA_REL, "config.json"), "utf-8")
    expect(config).not.toBe(EXAMPLE_CONFIG)
    expect(config).toContain("live-host")
  })

  it("a live file containing values absent from the example keeps them", async () => {
    // The whole point: the deployed system comes back up describing what it was
    // actually running, not what the example describes.
    const dest = await makeLiveDest()
    const stash = join(tmpDir, "stash")

    await run("save", dest, stash)
    await simulateDeployCopy(dest)
    await run("restore", dest, stash)

    const registry = await readFile(join(dest, DATA_REL, "registry.json"), "utf-8")
    expect(registry).toContain("live-svc")
  })
})

describe("a first deploy", () => {
  it("leaves the example in place when no live config exists", async () => {
    const dest = join(tmpDir, "fresh")
    await mkdir(dest, { recursive: true })
    const stash = join(tmpDir, "stash")

    await run("save", dest, stash)
    await simulateDeployCopy(dest)
    await run("restore", dest, stash)

    // Nothing to restore, so the example is what the destination has.
    expect(await readIfPresent(join(dest, DATA_REL, "config.json"))).toBeNull()
    expect(await readFile(join(dest, DATA_REL, "config.example.json"), "utf-8")).toBe(EXAMPLE_CONFIG)
  })

  it("saving from a destination that does not exist is not an error", async () => {
    const dest = join(tmpDir, "nonexistent")
    const stash = join(tmpDir, "stash")

    const result = await run("save", dest, stash)
    expect(result.exitCode).toBe(0)
  })

  it("restoring when nothing was saved is not an error", async () => {
    const dest = join(tmpDir, "fresh")
    await mkdir(join(dest, DATA_REL), { recursive: true })
    const stash = join(tmpDir, "stash")

    const result = await run("restore", dest, stash)
    expect(result.exitCode).toBe(0)
  })
})

describe("partial state", () => {
  it("a destination with only a registry keeps it and does not invent a config", async () => {
    const dest = join(tmpDir, "prod")
    await mkdir(join(dest, DATA_REL), { recursive: true })
    await writeFile(join(dest, DATA_REL, "registry.json"), LIVE_REGISTRY)
    const stash = join(tmpDir, "stash")

    await run("save", dest, stash)
    await simulateDeployCopy(dest)
    await run("restore", dest, stash)

    expect(await readFile(join(dest, DATA_REL, "registry.json"), "utf-8")).toBe(LIVE_REGISTRY)
    expect(await readIfPresent(join(dest, DATA_REL, "config.json"))).toBeNull()
  })
})

describe("choosing to replace the live configuration", () => {
  // Preserving is the default and the safe answer. Replacing is available, but
  // it has to be chosen — and a session with nobody to ask must never take
  // silence for consent.
  async function runSave(dest: string, stash: string, opts: { input?: string; tty?: boolean; env?: Record<string, string> } = {}) {
    const proc = Bun.spawn({
      cmd: ["bash", SCRIPT, "save", dest, stash],
      stdin: opts.input !== undefined ? new TextEncoder().encode(opts.input) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...opts.env },
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { stdout, stderr, exitCode, output: stdout + stderr }
  }

  it("a non-interactive deploy preserves the live configuration without asking", async () => {
    // The default path, and the only path cron can take. Silence is not consent.
    const dest = await makeLiveDest()
    const stash = join(tmpDir, "stash")

    const result = await runSave(dest, stash)
    await simulateDeployCopy(dest)
    await run("restore", dest, stash)

    expect(result.exitCode).toBe(0)
    expect(await readFile(join(dest, DATA_REL, "config.json"), "utf-8")).toBe(LIVE_CONFIG)
  })

  it("an explicit request to replace the configuration skips the save", async () => {
    const dest = await makeLiveDest()
    const stash = join(tmpDir, "stash")

    await runSave(dest, stash, { env: { BANTER_RESET_CONFIG: "1" } })
    await simulateDeployCopy(dest)
    await run("restore", dest, stash)

    // Nothing was stashed, so the examples the copy laid down stand.
    expect(await readIfPresent(join(dest, DATA_REL, "config.json"))).toBeNull()
    expect(await readFile(join(dest, DATA_REL, "config.example.json"), "utf-8")).toBe(EXAMPLE_CONFIG)
  })

  it("says which choice it made, so a deploy log records it", async () => {
    const dest = await makeLiveDest()
    const stash = join(tmpDir, "stash")

    const preserved = await runSave(dest, stash)
    expect(preserved.output).toMatch(/saved|preserv/i)

    const reset = await runSave(dest, join(tmpDir, "stash2"), { env: { BANTER_RESET_CONFIG: "1" } })
    expect(reset.output).toMatch(/replac|reset|example/i)
  })

  it("a destination with no live configuration does not ask at all", async () => {
    // There is nothing to lose, so there is nothing to confirm.
    const dest = join(tmpDir, "fresh")
    await mkdir(join(dest, DATA_REL), { recursive: true })
    const stash = join(tmpDir, "stash")

    const result = await runSave(dest, stash)
    expect(result.exitCode).toBe(0)
    expect(result.output).not.toMatch(/\[1\/2\]|Choice/i)
  })
})

describe("the deploy wires the preservation in", () => {
  it("control-deploy.sh saves before it removes the tree and restores after copying", async () => {
    const src = await Bun.file(join(import.meta.dir, "../../scripts/control-deploy.sh")).text()
    const code = src.split("\n").filter(l => !l.trim().startsWith("#"))

    const saveAt = code.findIndex(l => l.includes("deploy-preserve-config.sh") && l.includes("save"))
    const removeAt = code.findIndex(l => l.includes("rm -rf") && l.includes("$PROD/control"))
    const restoreAt = code.findIndex(l => l.includes("deploy-preserve-config.sh") && l.includes("restore"))

    expect(saveAt).toBeGreaterThanOrEqual(0)
    expect(removeAt).toBeGreaterThanOrEqual(0)
    expect(restoreAt).toBeGreaterThanOrEqual(0)
    expect(saveAt).toBeLessThan(removeAt)
    expect(restoreAt).toBeGreaterThan(removeAt)
  })
})
