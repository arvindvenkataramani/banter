import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveShardPaths } from "../control-shard/src/paths"

// The shard's deployment location was declared four times across four files
// with three different answers. The shard's own code derives it correctly — a
// data root preferring the lowercase spelling shared with the plane, falling
// back to capital-S only where such a directory already exists — and that
// derivation is the single answer the others are corrected to match.
//
// The contract from the design doc:
//   - every declaration of the registry path resolves to the same location
//   - that location is outside the deployed tree, so a redeploy cannot destroy it
//   - the launchd agent is a template: a placeholder home directory substituted
//     at deploy time, with the rendered file untracked
//   - the rendered agent contains no leftover placeholder
//   - an unusable numeric override stops startup with a message naming it
//
// No Mac and no shard deployment exist here. These establish internal
// consistency and rendering, which is the limit of what can be claimed.

const ROOT = join(import.meta.dir, "../..")
const SCRIPTS = join(ROOT, "scripts")
const SHARD_OPS = join(ROOT, "control/control-shard/ops")

const SWIFT = join(SHARD_OPS, "shard-runner.swift")
const TEMPLATE = join(SHARD_OPS, "com.banter.control-shard.plist.template")
const SHARD_INDEX = join(ROOT, "control/control-shard/src/index.ts")
const RENDER = join(SCRIPTS, "render-plist.sh")

const PLACEHOLDER = "__HOME__"

async function read(path: string): Promise<string> {
  return Bun.file(path).text()
}

async function exists(path: string): Promise<boolean> {
  return Bun.file(path).exists()
}

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "shard-deploy-"))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe("the registry path has one answer", () => {
  // Path resolution is its own module, taking the environment and home
  // directory as arguments, so these ask it directly rather than starting a
  // server and observing what it read.
  it("resolves the registry beneath the shard's data root, not inside the deployed tree", async () => {
    const home = join(tmpDir, "home")
    await mkdir(join(home, "services"), { recursive: true })
    const { registryPath } = resolveShardPaths({}, home)

    expect(registryPath).toBe(join(home, "services/shard/registry.json"))
    // The deployed tree is removed and rebuilt on every deploy, and the live
    // registry is not tracked — only an example is — so nothing would restore it.
    expect(registryPath).not.toContain("control/control-shard/data")
  })

  it("prefers the lowercase data root when both spellings exist", async () => {
    const home = join(tmpDir, "home")
    await mkdir(join(home, "services"), { recursive: true })
    await mkdir(join(home, "Services"), { recursive: true })
    const { registryPath } = resolveShardPaths({}, home)

    expect(registryPath).toBe(join(home, "services/shard/registry.json"))
  })

  it("falls back to the legacy capital-S root when only that exists", async () => {
    const home = join(tmpDir, "home")
    await mkdir(join(home, "Services"), { recursive: true })
    const { registryPath } = resolveShardPaths({}, home)

    expect(registryPath).toBe(join(home, "Services/shard/registry.json"))
  })

  it("an explicit override wins over the derived location", async () => {
    const home = join(tmpDir, "home")
    await mkdir(join(home, "services"), { recursive: true })
    const { registryPath } = resolveShardPaths({ BANTER_SHARD_REGISTRY_PATH: "/tmp/explicit/registry.json" }, home)

    expect(registryPath).toBe("/tmp/explicit/registry.json")
  })

  it("the Swift supervisor's fallback resolves to the same location as the shard's", async () => {
    // The supervisor reads the registry to find the port before spawning the
    // shard. If the two disagree, it binds one port and the shard reads another.
    const src = await read(SWIFT)
    expect(src).toContain("/services/shard/registry.json")
    expect(src).not.toContain("/Services/shard/registry.json")
    expect(src).not.toContain("Services/platform")
  })

  it("the launchd agent names the same location the shard would derive", async () => {
    const src = await read(TEMPLATE)
    expect(src).toContain("BANTER_SHARD_REGISTRY_PATH")
    expect(src).toContain(`${PLACEHOLDER}/services/shard/registry.json`)
    expect(src).not.toContain("control/control-shard/data/registry.json")
  })
})

describe("the launchd agent is a template", () => {
  it("the template is tracked and the rendered file is not", async () => {
    expect(await exists(TEMPLATE)).toBe(true)
    const gitignore = await read(join(ROOT, ".gitignore"))
    expect(gitignore).toContain("com.banter.control-shard.plist")
  })

  it("the template carries no machine's home directory", async () => {
    const src = await read(TEMPLATE)
    expect(src).toContain(PLACEHOLDER)
    expect(src).not.toContain("/Users/you")
    expect(src).not.toMatch(/\/Users\/[a-z]+\//)
  })

  it("rendering substitutes every placeholder", async () => {
    const out = join(tmpDir, "rendered.plist")
    const proc = Bun.spawn({
      cmd: ["bash", RENDER, TEMPLATE, out],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: "/Users/testuser" },
    })
    const exitCode = await proc.exited
    expect(exitCode).toBe(0)

    const rendered = await readFile(out, "utf-8")
    expect(rendered).not.toContain(PLACEHOLDER)
    expect(rendered).toContain("/Users/testuser")
  })

  it("the rendered agent keeps the project's own label", async () => {
    const out = join(tmpDir, "rendered.plist")
    const proc = Bun.spawn({
      cmd: ["bash", RENDER, TEMPLATE, out],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: "/Users/testuser" },
    })
    await proc.exited

    const rendered = await readFile(out, "utf-8")
    expect(rendered).toContain("com.banter.control-shard")
  })

  it("the installer leaves the shard's own agent alone while installing the others", async () => {
    // The shard's agent is a render output, not a file to cp — the deploy
    // installs it directly once rendered. An installer that copied it would
    // install a file still carrying the placeholder.
    const src = join(tmpDir, "src")
    const agents = join(tmpDir, "Library/LaunchAgents")
    const shardPlist = "control/control-shard/ops/com.banter.control-shard.plist"
    const otherPlist = "services/other/other.plist"

    await mkdir(join(src, "control/control-shard/data"), { recursive: true })
    await mkdir(join(src, "control/control-shard/ops"), { recursive: true })
    await mkdir(join(src, "services/other"), { recursive: true })
    await mkdir(agents, { recursive: true })
    await writeFile(join(src, shardPlist), `<!-- ${PLACEHOLDER} -->\n`)
    await writeFile(join(src, otherPlist), "<!-- other -->\n")
    await writeFile(join(src, "control/control-shard/data/registry.json"), JSON.stringify({
      services: [
        { id: "control-shard", runner: { type: "launchd", plist: shardPlist } },
        { id: "other", runner: { type: "launchd", plist: otherPlist } },
      ],
    }))

    const proc = Bun.spawn({
      cmd: ["bash", join(SCRIPTS, "shard-install-services.sh"), src],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: tmpDir, BANTER_SHARD_SERVICES_DEST: join(tmpDir, "services-dest") },
    })
    await proc.exited

    expect(await exists(join(agents, "other.plist"))).toBe(true)
    expect(await exists(join(agents, "com.banter.control-shard.plist"))).toBe(false)
  })
})

describe("unusable numeric overrides", () => {
  // Number() yields NaN for anything unparseable, which would reach Bun.serve
  // as a port and bind something nobody asked for. Resolution should throw
  // instead, naming the setting that was wrong.
  const HOME = "/home/someone"

  it("a malformed port is rejected, naming the setting", () => {
    expect(() => resolveShardPaths({ BANTER_SHARD_PORT: "not-a-port" }, HOME)).toThrow(/BANTER_SHARD_PORT/)
  })

  it("a malformed health interval is rejected, naming the setting", () => {
    expect(() => resolveShardPaths({ BANTER_HEALTH_INTERVAL_MS: "soon" }, HOME)).toThrow(/BANTER_HEALTH_INTERVAL_MS/)
  })

  it("a malformed idle interval is rejected, naming the setting", () => {
    expect(() => resolveShardPaths({ BANTER_IDLE_INTERVAL_MS: "never" }, HOME)).toThrow(/BANTER_IDLE_INTERVAL_MS/)
  })

  it("a zero port is rejected, not treated as an unset value", () => {
    // Zero is the boundary: Bun.serve treats it as "pick any free port", which
    // is not what an operator who typed 0 meant.
    expect(() => resolveShardPaths({ BANTER_SHARD_PORT: "0" }, HOME)).toThrow(/BANTER_SHARD_PORT/)
  })

  it("a valid port is accepted", () => {
    // The other side of the boundary: the guard must not reject good values.
    expect(resolveShardPaths({ BANTER_SHARD_PORT: "4200" }, HOME).port).toBe(4200)
  })

  it("an unset port falls back to the default rather than throwing", () => {
    expect(resolveShardPaths({}, HOME).port).toBe(4200)
  })
})
