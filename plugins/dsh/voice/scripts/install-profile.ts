// Builds the package, installs it into a dsh profile, and seeds the plugin's
// settings from the control plane's voice config.
//
//   bun scripts/install-profile.ts <profile> <control-plane-url>
//
// It reads GET <control-plane-url>/api/voice once and writes the profile's
// plugin row config; it touches nothing else. Live values go into the
// profile only, never into this repository.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { VoiceConfig } from '@platform/voice-engine/voice-config'
import { settingsFromVoiceConfig } from '../src/host/settings.ts'

declare const Bun: { YAML: { parse(text: string): unknown; stringify(value: unknown, replacer?: null, space?: number): string } }

/** The dsh package the plugin is added with. */
const DSH_PACKAGE = '@deepseek-ai/dsh'

/** The patch row id the plugin's host entry is inserted under (scripts/build.ts). */
const ROW_ID = 'dsh-voice'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.status !== 0) fail(`${command} ${args[0] ?? ''} failed`)
}

/** The profile's patch rows with the plugin's row set to `config`, every other row left as it was. */
export function withPluginRow(existing: unknown, config: Record<string, unknown>): unknown[] {
  const rows = Array.isArray(existing) ? [...existing] : []
  const index = rows.findIndex(row => typeof row === 'object' && row !== null && (row as { id?: unknown }).id === ROW_ID)
  const next = { id: ROW_ID, config }
  if (index < 0) rows.push(next)
  else rows[index] = { ...(rows[index] as object), config }
  return rows
}

async function main(): Promise<void> {
  const [profile, controlPlaneUrl] = process.argv.slice(2)
  if (!profile || !controlPlaneUrl || !/^[\w.-]+$/.test(profile) || !/^https?:\/\//.test(controlPlaneUrl)) {
    fail('usage: bun scripts/install-profile.ts <profile> <control-plane-url>')
  }

  run('bun', [join(root, 'scripts/build.ts')])
  run('npx', [DSH_PACKAGE, 'plugin', '--profile', profile, 'add', join(root, 'dist/package')])

  const response = await fetch(`${controlPlaneUrl.replace(/\/+$/, '')}/api/voice`)
  if (!response.ok) fail(`the control plane answered ${response.status} for its voice config`)
  const settings = settingsFromVoiceConfig(await response.json() as VoiceConfig, controlPlaneUrl.replace(/\/+$/, ''))

  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const patchFile = join(home, 'profiles', profile, 'cordis.patch.yml')
  const existing = existsSync(patchFile) ? Bun.YAML.parse(await readFile(patchFile, 'utf8')) : []
  await mkdir(dirname(patchFile), { recursive: true })
  await writeFile(patchFile, Bun.YAML.stringify(withPluginRow(existing, { ...settings }), null, 2))
  console.log(`installed into profile "${profile}" and wrote its voice settings`)
}

if (import.meta.main) await main()
