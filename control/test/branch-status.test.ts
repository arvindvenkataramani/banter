import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Branch state reporting answers one question for the deploy script: is this
// checkout the project's main line, or is it not?
//
// The contract from the design doc:
//   - on the main line, exit 0 and say nothing that requires a decision
//   - off the main line, exit non-zero and name the branch, so the deploy
//     script can ask the operator to confirm
//   - the main line is discovered, not assumed to be any particular name
//   - an unanswerable question (no repo, no remote, detached head) is not a
//     reason to block a deploy: report and let the caller proceed
//
// Exit code contract: 0 = on main line, 1 = not on main line, 2 = undetermined.

const SCRIPT = join(import.meta.dir, "../../scripts/branch-status.sh")

let tmpDir: string

async function git(cwd: string, ...args: string[]) {
  const proc = Bun.spawn({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  })
  await proc.exited
  return proc
}

async function runStatus(cwd: string) {
  const proc = Bun.spawn({ cmd: ["bash", SCRIPT], cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode, output: stdout + stderr }
}

/** A repo with one commit on `branchName`, no remote. */
async function makeRepo(branchName: string): Promise<string> {
  const dir = join(tmpDir, `repo-${branchName.replace(/\//g, "-")}-${Math.random().toString(36).slice(2)}`)
  await Bun.write(join(dir, "README.md"), "# test\n")
  await git(dir, "init", "-q", "-b", branchName)
  await git(dir, "add", "-A")
  await git(dir, "commit", "-q", "-m", "initial")
  return dir
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "branch-status-"))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe("on the main line", () => {
  it("reports success on a repository whose only branch is main", async () => {
    const repo = await makeRepo("main")
    const { exitCode } = await runStatus(repo)
    expect(exitCode).toBe(0)
  })

  it("reports success on a repository whose only branch is master", async () => {
    const repo = await makeRepo("master")
    const { exitCode } = await runStatus(repo)
    expect(exitCode).toBe(0)
  })

  it("names the branch it recognised as the main line", async () => {
    const repo = await makeRepo("master")
    const { output } = await runStatus(repo)
    expect(output).toContain("master")
  })
})

describe("off the main line", () => {
  it("reports a non-zero status on a feature branch", async () => {
    const repo = await makeRepo("main")
    await git(repo, "checkout", "-q", "-b", "feature/experiment")
    const { exitCode } = await runStatus(repo)
    expect(exitCode).toBe(1)
  })

  it("names the current branch so the operator knows what they would deploy", async () => {
    const repo = await makeRepo("main")
    await git(repo, "checkout", "-q", "-b", "feature/experiment")
    const { output } = await runStatus(repo)
    expect(output).toContain("feature/experiment")
  })

  it("treats a branch named neither main nor master as off the main line", async () => {
    const repo = await makeRepo("main")
    await git(repo, "checkout", "-q", "-b", "trunk")
    const { exitCode } = await runStatus(repo)
    expect(exitCode).toBe(1)
  })
})

describe("when the main line cannot be determined", () => {
  it("does not report failure outside a git repository", async () => {
    const notARepo = join(tmpDir, "plain-directory")
    await Bun.write(join(notARepo, "file.txt"), "x")
    const { exitCode } = await runStatus(notARepo)
    expect(exitCode).toBe(2)
  })

  it("explains why it could not answer, rather than failing silently", async () => {
    const notARepo = join(tmpDir, "plain-directory-2")
    await Bun.write(join(notARepo, "file.txt"), "x")
    const { output } = await runStatus(notARepo)
    expect(output.trim().length).toBeGreaterThan(0)
  })

  it("does not report failure on a detached HEAD checkout", async () => {
    const repo = await makeRepo("main")
    const rev = Bun.spawnSync({ cmd: ["git", "rev-parse", "HEAD"], cwd: repo })
    const sha = rev.stdout.toString().trim()
    await git(repo, "checkout", "-q", sha)
    const { exitCode } = await runStatus(repo)
    expect(exitCode).toBe(2)
  })
})

describe("independence from any particular development workflow", () => {
  it("succeeds on main without requiring a branch named dev to exist", async () => {
    const repo = await makeRepo("main")
    const { exitCode, output } = await runStatus(repo)
    expect(exitCode).toBe(0)
    expect(output).not.toContain("dev is")
  })

  it("does not require a remote to be configured", async () => {
    const repo = await makeRepo("main")
    const remotes = Bun.spawnSync({ cmd: ["git", "remote"], cwd: repo })
    expect(remotes.stdout.toString().trim()).toBe("")
    const { exitCode } = await runStatus(repo)
    expect(exitCode).toBe(0)
  })

  it("reports at most one line of status, not a multi-state taxonomy", async () => {
    const repo = await makeRepo("main")
    const { output } = await runStatus(repo)
    const meaningful = output.trim().split("\n").filter(l => l.trim().length > 0)
    expect(meaningful.length).toBeLessThanOrEqual(2)
  })
})
