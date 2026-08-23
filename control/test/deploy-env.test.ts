import { describe, it, expect } from "bun:test"
import { join } from "node:path"

// One shell file answers where each half deploys and what it calls itself,
// sourced by every script that installs, runs, stops, or removes either half.
//
// The contract from the design doc:
//   - four values: where the plane deploys, its unit name, where the shard
//     deploys, and where the shard installs sibling service files
//   - each is a named parameter with a default, so an ordinary deploy needs no
//     environment set and an unusual one overrides a value
//   - scripts read their locations from here rather than restating them
//   - the defaults follow this project's naming, not the fork's
//
// Shell rather than config, deliberately: the scripts that read these run
// before a deployment exists to configure.

const SCRIPTS = join(import.meta.dir, "../../scripts")
const DEPLOY_ENV = join(SCRIPTS, "deploy-env.sh")

const PLANE_SCRIPTS = [
  "control-deploy.sh",
  "control-runner.sh",
  "control-serve-off.sh",
  "control-uninstall.sh",
  "serve-watchdog.sh",
].map(n => join(SCRIPTS, n))

const SHARD_SCRIPTS = [
  "shard-deploy.sh",
  "shard-install-services.sh",
].map(n => join(SCRIPTS, n))

async function read(path: string): Promise<string> {
  return Bun.file(path).text()
}

/** Lines that are not comments — the executable content of a shell script. */
function codeLines(src: string): string[] {
  return src.split("\n").filter(l => !l.trim().startsWith("#"))
}

/** Resolve the four values by sourcing the file under a given environment. */
async function sourceEnv(env: Record<string, string> = {}) {
  const proc = Bun.spawn({
    cmd: ["bash", "-c", `source "${DEPLOY_ENV}" && echo "$BANTER_PROD" && echo "$BANTER_UNIT" && echo "$BANTER_SHARD_PROD" && echo "$BANTER_SHARD_SERVICES_DEST"`],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  })
  const [stdout, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ])
  const [banterProd, banterUnit, shardProd, shardServicesDest] = stdout.trim().split("\n")
  return { banterProd, banterUnit, shardProd, shardServicesDest, exitCode }
}

describe("the locations file defines every deployment value", () => {
  it("defines all four values with defaults, needing no environment", async () => {
    const { banterProd, banterUnit, shardProd, shardServicesDest, exitCode } = await sourceEnv()
    expect(exitCode).toBe(0)
    expect(banterProd).toBeTruthy()
    expect(banterUnit).toBeTruthy()
    expect(shardProd).toBeTruthy()
    expect(shardServicesDest).toBeTruthy()
  })

  it("defaults name this project, not the one it was forked from", async () => {
    const { banterProd, banterUnit, shardProd } = await sourceEnv()
    expect(banterProd).toContain("banter")
    expect(banterUnit).toContain("banter")
    expect(shardProd).toContain("banter")
    expect(banterProd).not.toContain("platform")
    expect(shardProd).not.toContain("platform")
  })

  it("the plane's default is unchanged from what the scripts used before", async () => {
    const { banterProd, banterUnit } = await sourceEnv()
    expect(banterProd).toBe(`${process.env.HOME}/services/banter`)
    expect(banterUnit).toBe("banter")
  })

  it("every value can be overridden from the environment", async () => {
    const { banterProd, banterUnit, shardProd, shardServicesDest } = await sourceEnv({
      BANTER_PROD: "/tmp/alt-prod",
      BANTER_UNIT: "banter-staging",
      BANTER_SHARD_PROD: "/tmp/alt-shard",
      BANTER_SHARD_SERVICES_DEST: "/tmp/alt-services",
    })
    expect(banterProd).toBe("/tmp/alt-prod")
    expect(banterUnit).toBe("banter-staging")
    expect(shardProd).toBe("/tmp/alt-shard")
    expect(shardServicesDest).toBe("/tmp/alt-services")
  })
})

describe("scripts read locations rather than restating them", () => {
  it("every plane script sources the locations file", async () => {
    for (const path of PLANE_SCRIPTS) {
      const src = await read(path)
      expect(src).toContain("deploy-env.sh")
    }
  })

  it("every shard script sources the locations file", async () => {
    for (const path of SHARD_SCRIPTS) {
      const src = await read(path)
      expect(src).toContain("deploy-env.sh")
    }
  })

  it("no script restates a default location as a literal", async () => {
    // The property under test is that the value appears once, in the locations
    // file, rather than once per script that happens to need it.
    for (const path of [...PLANE_SCRIPTS, ...SHARD_SCRIPTS]) {
      const code = codeLines(await read(path)).join("\n")
      expect(code).not.toContain("$HOME/services/banter")
      expect(code).not.toContain("$HOME/Services/platform")
      expect(code).not.toContain("$HOME/Services\"")
    }
  })

  it("the shard scripts no longer name the fork's deploy directory", async () => {
    for (const path of SHARD_SCRIPTS) {
      const code = codeLines(await read(path)).join("\n")
      expect(code).not.toContain("Services/platform")
    }
  })
})
