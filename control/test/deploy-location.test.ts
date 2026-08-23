import { describe, it, expect } from "bun:test"
import { join } from "node:path"

// A deployment owns its location and its service name. Neither is a property
// of the source repository, and neither should be a literal in a script.
//
// The contract from the design doc:
//   - the install directory is one named value with a default, used by every
//     script that references it
//   - the service name is likewise a value, distinct from the one inherited
//     from the system this code was extracted from
//   - the defaults are specific to this project
//
// These tests read the scripts as text. That is deliberate: the property under
// test is that the value appears once as a parameter rather than repeatedly as
// a literal, which is a property of the source, not of a running process.

const SCRIPTS = join(import.meta.dir, "../../scripts")
const OPS = join(import.meta.dir, "../../ops")

const DEPLOY_ENV = join(SCRIPTS, "deploy-env.sh")
const DEPLOY = join(SCRIPTS, "control-deploy.sh")
const RUNNER = join(SCRIPTS, "control-runner.sh")
const SERVE_OFF = join(SCRIPTS, "control-serve-off.sh")
const UNINSTALL = join(SCRIPTS, "control-uninstall.sh")
const START = join(SCRIPTS, "control-start.sh")
const STOP = join(SCRIPTS, "control-stop.sh")

const LOCATION_SCRIPTS = [DEPLOY, RUNNER, SERVE_OFF, UNINSTALL]
const UNIT_SCRIPTS = [DEPLOY, START, STOP, UNINSTALL]

async function read(path: string): Promise<string> {
  return Bun.file(path).text()
}

/** Lines that are not comments — the executable content of a shell script. */
function codeLines(src: string): string[] {
  return src.split("\n").filter(l => !l.trim().startsWith("#"))
}

describe("install location is a parameter", () => {
  it("every script that installs or removes files honours the same override variable", async () => {
    for (const path of LOCATION_SCRIPTS) {
      const src = await read(path)
      expect(src).toContain("BANTER_PROD")
    }
  })

  it("no script hardcodes the production platform directory it was extracted from", async () => {
    for (const path of LOCATION_SCRIPTS) {
      const code = codeLines(await read(path)).join("\n")
      expect(code).not.toContain("services/platform")
    }
  })

  it("the default install location is specific to this project", async () => {
    const code = codeLines(await read(DEPLOY)).join("\n")
    expect(code).toMatch(/banter/i)
  })

  it("the runtime wrapper resolves the same location the deploy script installs to", async () => {
    // The default now lives in one sourced file rather than being restated in
    // each script, so agreement is structural: both read the same declaration.
    const deploy = codeLines(await read(DEPLOY)).join("\n")
    const runner = codeLines(await read(RUNNER)).join("\n")
    expect(deploy).toContain("deploy-env.sh")
    expect(runner).toContain("deploy-env.sh")

    const env = codeLines(await read(DEPLOY_ENV)).join("\n")
    const envDefault = env.match(/BANTER_PROD:-([^}"]+)/)?.[1]
    expect(envDefault).toBeDefined()
  })
})

describe("service name is a parameter", () => {
  it("every script that acts on the system service honours the same name variable", async () => {
    for (const path of UNIT_SCRIPTS) {
      const src = await read(path)
      expect(src).toContain("BANTER_UNIT")
    }
  })

  it("the default service name is not the one already in use by the extracted-from system", async () => {
    const code = codeLines(await read(DEPLOY_ENV)).join("\n")
    const unitDefault = code.match(/BANTER_UNIT:-([A-Za-z0-9._-]+)/)?.[1]
    expect(unitDefault).toBeDefined()
    expect(unitDefault).not.toBe("platform")
  })

  it("no script restarts a service by a bare hardcoded name", async () => {
    for (const path of UNIT_SCRIPTS) {
      const code = codeLines(await read(path)).join("\n")
      expect(code).not.toMatch(/systemctl\s+--user\s+(restart|start|stop|enable|disable)\s+platform\b/)
    }
  })

  it("the shipped unit file is named for this project", async () => {
    // The unit ships as a template — it carries the deploy path, which is only
    // known at install time — so match both it and a plain .service file.
    const glob = new Bun.Glob("*.service{,.template}")
    const units = [...glob.scanSync({ cwd: OPS + "/systemd" })]
    expect(units.some(u => /banter/i.test(u))).toBe(true)
    expect(units).not.toContain("platform.service")
    expect(units).not.toContain("platform.service.template")
  })

  it("the unit template hardcodes no deploy path", async () => {
    const tpl = await read(OPS + "/systemd/banter.service.template")
    // %h/services/banter was the bug: BANTER_PROD was honoured everywhere
    // except the unit that starts the thing.
    expect(tpl).not.toMatch(/%h\/services/)
    expect(tpl).toContain("__PROD__")
  })
})

describe("scripts remain valid shell", () => {
  it("parses every deploy-related script without syntax errors", async () => {
    for (const path of [...new Set([...LOCATION_SCRIPTS, ...UNIT_SCRIPTS])]) {
      const proc = Bun.spawn({ cmd: ["bash", "-n", path], stdout: "pipe", stderr: "pipe" })
      const stderr = await new Response(proc.stderr).text()
      const exitCode = await proc.exited
      expect({ path, exitCode, stderr }).toEqual({ path, exitCode: 0, stderr: "" })
    }
  })
})
