import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// The deploy preflight runs before a deploy modifies anything. The deploy
// removes directories and restarts a system service; neither is guarded today.
//
// The contract from the design doc:
//   - refuse when the destination exists and was not created by this project
//   - allow when the destination does not exist, or carries this project's marker
//   - refuse when the service name is in use by something that is not ours
//   - a refusal is a refusal, not a prompt: it exits non-zero and changes nothing
//   - an override exists but must be named explicitly, not answered reflexively
//
// Exit code contract: 0 = safe to proceed, non-zero = refused.

const SCRIPT = join(import.meta.dir, "../../scripts/deploy-preflight.sh")
const MARKER = ".banter-deploy.json"

let tmpDir: string

async function runPreflight(dest: string, env: Record<string, string> = {}) {
  const proc = Bun.spawn({
    cmd: ["bash", SCRIPT, dest],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, BANTER_SKIP_UNIT_CHECK: "1", ...env },
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode, output: stdout + stderr }
}

/** A destination that a previous banter deploy created. */
async function makeOwnedDest(name: string): Promise<string> {
  const dest = join(tmpDir, name)
  await mkdir(dest, { recursive: true })
  await writeFile(join(dest, MARKER), JSON.stringify({ project: "banter", deployedAt: "2026-01-01T00:00:00Z" }))
  return dest
}

/** A destination occupied by something that is not ours. */
async function makeForeignDest(name: string): Promise<string> {
  const dest = join(tmpDir, name)
  await mkdir(join(dest, "control", "control-plane", "src"), { recursive: true })
  await writeFile(join(dest, "control", "control-plane", "src", "index.ts"), "// someone else's deployment\n")
  return dest
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "deploy-preflight-"))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe("destination safety", () => {
  it("allows a deploy to a destination that does not exist yet", async () => {
    const { exitCode } = await runPreflight(join(tmpDir, "fresh-location"))
    expect(exitCode).toBe(0)
  })

  it("allows a deploy to an empty destination directory", async () => {
    const dest = join(tmpDir, "empty-location")
    await mkdir(dest, { recursive: true })
    const { exitCode } = await runPreflight(dest)
    expect(exitCode).toBe(0)
  })

  it("allows a redeploy to a destination this project previously created", async () => {
    const dest = await makeOwnedDest("ours")
    const { exitCode } = await runPreflight(dest)
    expect(exitCode).toBe(0)
  })

  it("refuses a deploy to a populated destination with no ownership marker", async () => {
    const dest = await makeForeignDest("someone-elses-platform")
    const { exitCode, output } = await runPreflight(dest)
    expect(exitCode).not.toBe(0)
    // A missing script also exits non-zero; require a deliberate refusal.
    expect(output.toLowerCase()).toMatch(/refus|not.*creat|does not belong|unrecognis|unrecogniz/)
  })

  it("names the destination it refused, so the operator knows what was protected", async () => {
    const dest = await makeForeignDest("someone-elses-platform-2")
    const { output } = await runPreflight(dest)
    expect(output).toContain(dest)
  })

  it("refuses when the marker exists but belongs to a different project", async () => {
    const dest = join(tmpDir, "other-project")
    await mkdir(dest, { recursive: true })
    await writeFile(join(dest, MARKER), JSON.stringify({ project: "something-else" }))
    const { exitCode, output } = await runPreflight(dest)
    expect(exitCode).not.toBe(0)
    expect(output.toLowerCase()).toMatch(/refus|not.*creat|does not belong|unrecognis|unrecogniz/)
  })

  it("leaves a refused destination completely unmodified", async () => {
    const dest = await makeForeignDest("untouched")
    const victim = join(dest, "control", "control-plane", "src", "index.ts")
    const before = await Bun.file(victim).text()
    const { exitCode } = await runPreflight(dest)
    expect(exitCode).not.toBe(0)
    expect(await Bun.file(victim).exists()).toBe(true)
    expect(await Bun.file(victim).text()).toBe(before)
  })
})

describe("refusal is not a prompt", () => {
  it("refuses without reading from standard input", async () => {
    const dest = await makeForeignDest("no-prompt")
    const proc = Bun.spawn({
      cmd: ["bash", SCRIPT, dest],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, BANTER_SKIP_UNIT_CHECK: "1" },
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ])
    expect(exitCode).not.toBe(0)
    // Not a hang waiting on input, and not a missing-script error.
    expect(stdout + stderr).not.toMatch(/No such file/i)
  })

  it("proceeds on a foreign destination only when the override is set explicitly", async () => {
    const dest = await makeForeignDest("override-me")
    const refused = await runPreflight(dest)
    expect(refused.exitCode).not.toBe(0)

    const overridden = await runPreflight(dest, { BANTER_DEPLOY_FORCE: "1" })
    expect(overridden.exitCode).toBe(0)
  })

  it("says the override was used, so a forced deploy is visible in the log", async () => {
    const dest = await makeForeignDest("override-visible")
    const { output } = await runPreflight(dest, { BANTER_DEPLOY_FORCE: "1" })
    expect(output.toLowerCase()).toMatch(/force|override/)
  })
})

describe("arguments", () => {
  it("refuses when given no destination rather than guessing one", async () => {
    const proc = Bun.spawn({
      cmd: ["bash", SCRIPT],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, BANTER_SKIP_UNIT_CHECK: "1" },
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ])
    expect(exitCode).not.toBe(0)
    expect((stdout + stderr).toLowerCase()).toMatch(/usage|destination|argument/)
  })
})
