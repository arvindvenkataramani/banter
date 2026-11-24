// Installs the plugin into dsh profiles, or removes it.
//
//   ops/dsh-plugin-install.sh <banter-url> [--profile <name>]... [--link]
//   ops/dsh-plugin-uninstall.sh [--profile <name>]...
//
// With no --profile it uses every profile under $DSH_HOME/profiles (~/.dsh by
// default): `desktop` is the desktop app's, `web` is `dsh web`'s. It installs a
// copy of the built plugin into each profile, or with --link a link to this
// checkout's build, so a rebuild shows up after a restart. It then sets the
// plugin's Banter server URL in each profile's cordis.patch.yml, keeping its
// keep-voice-on setting and leaving the rest of that file untouched.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = '@banter/dsh-voice'
/** The patch row id the plugin's host entry is inserted under (scripts/build.ts). */
const ROW_ID = 'dsh-voice'
/** The desktop app's own dsh command, matched to the app's version. */
const APP_CLI = '/Applications/Codeweaving/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
/** Where a copied install keeps its packed plugin, inside each profile. */
const VENDOR_FILE = join('vendor', 'banter-dsh-voice.tgz')
/** The desktop app's process, as pgrep -f matches it. */
const DESKTOP_APP_PROCESS = 'DeepSeek Harness.app/Contents/MacOS'

export interface Options {
  url: string | null
  profiles: string[]
  link: boolean
  uninstall: boolean
}

const USAGE = 'usage: ops/dsh-plugin-install.sh <banter-url> [--profile <name>]... [--link]\n       ops/dsh-plugin-uninstall.sh [--profile <name>]...'

export function parseArgs(argv: readonly string[]): { ok: true; options: Options } | { ok: false; problem: string } {
  const options: Options = { url: null, profiles: [], link: false, uninstall: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (arg === '--link') options.link = true
    else if (arg === '--uninstall') options.uninstall = true
    else if (arg === '--profile') {
      const name = argv[++i]
      if (name === undefined || !/^[\w.-]+$/.test(name)) return { ok: false, problem: `--profile needs a profile name\n${USAGE}` }
      options.profiles.push(name)
    } else if (arg.startsWith('-')) return { ok: false, problem: `unknown option ${arg}\n${USAGE}` }
    else if (options.url === null) options.url = arg.trim().replace(/\/+$/, '')
    else return { ok: false, problem: `unexpected argument ${arg}\n${USAGE}` }
  }
  if (options.uninstall) {
    if (options.url !== null || options.link) return { ok: false, problem: `--uninstall takes only --profile\n${USAGE}` }
    return { ok: true, options }
  }
  if (options.url === null) return { ok: false, problem: USAGE }
  if (!/^https?:\/\/[^/\s]+/.test(options.url)) return { ok: false, problem: `the Banter URL must start with http:// or https://\n${USAGE}` }
  return { ok: true, options }
}

/** The profiles to act on: the ones named, or else every profile found. dsh keeps a shared node_modules beside the profiles, and no profile can have that name. */
export function chooseProfiles(foundDirs: readonly string[], requested: readonly string[]): { ok: true; profiles: string[] } | { ok: false; problem: string } {
  if (requested.length > 0) return { ok: true, profiles: [...new Set(requested)] }
  const found = foundDirs.filter(name => name !== 'node_modules')
  if (found.length === 0) {
    return { ok: false, problem: 'no dsh profiles found; open the desktop app or run `dsh web` once, or name one with --profile desktop or --profile web' }
  }
  return { ok: true, profiles: [...found].sort() }
}

/** The line range of the plugin's top-level row in a cordis.patch.yml, or null when it has none. */
function rowRange(lines: readonly string[]): { start: number; end: number } | null {
  const start = lines.findIndex(line => new RegExp(`^- id: ['"]?${ROW_ID}['"]?\\s*$`).test(line))
  if (start < 0) return null
  let end = start + 1
  while (end < lines.length && (lines[end] === '' || /^\s/.test(lines[end] ?? ''))) end++
  // Blank lines after the row belong to the gap before the next entry.
  while (end > start + 1 && lines[end - 1] === '') end--
  return { start, end }
}

/** The plugin's settings for a profile: the new URL, and the keep-voice-on choice the row already holds. Fields from earlier versions are dropped. */
export function pluginRowConfig(patchText: string, url: string): { controlPlaneUrl: string; keepVoiceOutside?: boolean } {
  const lines = patchText.split('\n')
  const range = rowRange(lines)
  const keep = range === null ? undefined : lines.slice(range.start, range.end).map(line => /^\s+keepVoiceOutside:\s*(true|false)\s*$/.exec(line)?.[1]).find(v => v !== undefined)
  return { controlPlaneUrl: url, ...(keep !== undefined && { keepVoiceOutside: keep === 'true' }) }
}

/** Whether the lines hold no entry: only comments and blank lines. */
const hasNoEntries = (lines: readonly string[]): boolean => lines.every(line => /^\s*(#.*)?$/.test(line))

/**
 * The patch text with the plugin's row set to `config`, or removed for null. Every other line is left as it was, except
 * the empty list `[]` dsh writes into a new profile: a block-style entry can't sit beside it, so it goes while the file
 * has entries and comes back when it has none, or dsh would read the file as null rather than as no patches.
 */
export function setPluginRow(patchText: string, config: Record<string, string | boolean> | null): string {
  if (config === null && rowRange(patchText.split('\n')) === null) return patchText
  const lines = patchText.split('\n').filter(line => line.trim() !== '[]')
  const range = rowRange(lines)
  const row = config === null
    ? []
    : [`- id: ${ROW_ID}`, '  config:', ...Object.entries(config).map(([key, value]) => `    ${key}: ${JSON.stringify(value)}`)]
  let body: string
  if (range !== null) {
    lines.splice(range.start, range.end - range.start, ...row)
    body = lines.join('\n')
  } else {
    const kept = lines.join('\n').replace(/\n*$/, '')
    body = `${kept === '' ? '' : `${kept}\n`}${row.join('\n')}\n`
  }
  return hasNoEntries(body.split('\n')) ? `${body.replace(/\n*$/, '')}\n[]\n`.replace(/^\n/, '') : body
}

// ── Running it ───────────────────────────────────────────────────────────

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function run(command: string, args: string[], cwd?: string): string {
  const result = spawnSync(command, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' })
  if (result.status !== 0) fail(`${command} ${args.join(' ')} failed`)
  return result.stdout
}

async function profilesFound(profilesDir: string): Promise<string[]> {
  if (!existsSync(profilesDir)) return []
  const names = await readdir(profilesDir)
  const dirs = await Promise.all(names.map(async name => ((await stat(join(profilesDir, name))).isDirectory() ? name : null)))
  return dirs.filter((name): name is string => name !== null)
}

function running(pattern: string): boolean {
  return spawnSync('pgrep', ['-f', pattern], { stdio: 'ignore' }).status === 0
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2))
  if (!parsed.ok) fail(parsed.problem)
  const { options } = parsed

  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const profilesDir = join(home, 'profiles')
  const chosen = chooseProfiles(await profilesFound(profilesDir), options.profiles)
  if (!chosen.ok) fail(chosen.problem)

  // dsh refuses to change the desktop profile while the app runs; stopping here leaves no profile half-done.
  if (chosen.profiles.includes('desktop') && running(DESKTOP_APP_PROCESS)) {
    fail('Quit DeepSeek Harness fully (⌘Q) first: dsh changes the desktop profile only while the app is closed. Then run this again.')
  }

  const dsh: [string, ...string[]] = existsSync(APP_CLI) ? [APP_CLI] : ['npx', '-y', '@deepseek-ai/dsh']
  const dshRun = (args: string[]): void => { run(dsh[0], [...dsh.slice(1), ...args]) }

  if (options.uninstall) {
    for (const profile of chosen.profiles) {
      dshRun(['plugin', '--profile', profile, 'remove', PACKAGE_NAME])
      const patchFile = join(profilesDir, profile, 'cordis.patch.yml')
      if (existsSync(patchFile)) await writeFile(patchFile, setPluginRow(await readFile(patchFile, 'utf8'), null))
      await rm(join(profilesDir, profile, VENDOR_FILE), { force: true })
      console.log(`removed from profile "${profile}"`)
    }
    return
  }

  const url = options.url as string
  const answer = await fetch(`${url}/api/voice`).catch(() => null)
  if (answer === null) fail(`no answer from Banter at ${url}; check the URL and that Banter is running`)
  if (!answer.ok) fail(`Banter at ${url} answered ${answer.status} for its voice config`)

  run('bun', [join(root, 'scripts/build.ts')])
  const packageDir = join(root, 'dist/package')
  let packed: string | null = null
  if (!options.link) {
    const scratch = await mkdtemp(join(tmpdir(), 'banter-dsh-voice-'))
    const name = run('npm', ['pack', '--silent', '--pack-destination', scratch], packageDir).trim().split('\n').pop() ?? ''
    packed = join(scratch, name)
  }

  for (const profile of chosen.profiles) {
    const profileDir = join(profilesDir, profile)
    let spec = packageDir
    if (packed !== null) {
      spec = join(profileDir, VENDOR_FILE)
      await mkdir(dirname(spec), { recursive: true })
      await copyFile(packed, spec)
    }
    // pnpm keeps an installed package of the same version, link or copy, so an earlier install comes out first.
    const manifest = join(profileDir, 'package.json')
    const installed = existsSync(manifest) && PACKAGE_NAME in ((JSON.parse(await readFile(manifest, 'utf8')) as { dependencies?: object }).dependencies ?? {})
    if (installed) dshRun(['plugin', '--profile', profile, 'remove', PACKAGE_NAME])
    dshRun(['plugin', '--profile', profile, 'add', spec])
    const patchFile = join(profileDir, 'cordis.patch.yml')
    const text = existsSync(patchFile) ? await readFile(patchFile, 'utf8') : ''
    await writeFile(patchFile, setPluginRow(text, pluginRowConfig(text, url)))
    console.log(`installed into profile "${profile}" (${options.link ? 'linked to this checkout' : 'a copy'}), with Banter at ${url}`)
  }

  const restart: string[] = []
  if (chosen.profiles.includes('desktop')) restart.push('open the desktop app')
  if (chosen.profiles.some(p => p !== 'desktop') && running('dsh.* web')) restart.push('restart `dsh web`')
  console.log(restart.length > 0
    ? `Next: ${restart.join(', and ')}; dsh loads a newly added plugin only when its profile starts. Then open Plugins → Banter voice and press Test connection.`
    : 'Next: start dsh, open Plugins → Banter voice and press Test connection.')
}

if (import.meta.main) await main()
