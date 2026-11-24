import { describe, expect, it } from 'vitest'
import { chooseProfiles, parseArgs, pluginRowConfig, setPluginRow } from './install-dsh'

// A profile's patch file with a comment header, a `!!js` expression and an insert list that must survive untouched,
// and a plugin row holding fields from an earlier version.
const PATCH = [
  '# Your patch layer for this dsh profile',
  '- insert:',
  '    - id: mcp-searxng',
  '      config:',
  '        serverName: searxng',
  '- id: ui-settings-general',
  '  config:',
  '    welcome: !!js "Date.now()"',
  '',
  '- id: dsh-voice',
  '  config:',
  '    controlPlaneUrl: https://old.invalid:5007',
  '    sttServiceId: fluid-stt',
  '    keepVoiceOutside: true',
  '    rest: "{\\"tts\\":{}}"',
  '',
  '- id: ui-chat',
  '  config:',
  '    compact: true',
  '',
].join('\n')

describe('install-dsh arguments', () => {
  it('takes a Banter URL, repeated --profile and --link, and trims a trailing slash', () => {
    expect(parseArgs(['http://localhost:4201/', '--profile', 'web', '--profile', 'desktop', '--link'])).toEqual({
      ok: true,
      options: { url: 'http://localhost:4201', profiles: ['web', 'desktop'], link: true, uninstall: false },
    })
  })

  it('refuses a missing or non-http URL, an unknown option and a URL given with --uninstall', () => {
    for (const argv of [[], ['localhost:4201'], ['http://localhost:4201', '--force'], ['--uninstall', 'http://localhost:4201']]) {
      expect(parseArgs(argv).ok, argv.join(' ')).toBe(false)
    }
    expect(parseArgs(['--uninstall', '--profile', 'web'])).toEqual({ ok: true, options: { url: null, profiles: ['web'], link: false, uninstall: true } })
  })
})

describe('choosing profiles', () => {
  it('uses every profile found when none is named, and only the named ones otherwise', () => {
    expect(chooseProfiles(['web', 'desktop'], [])).toEqual({ ok: true, profiles: ['desktop', 'web'] })
    expect(chooseProfiles(['web', 'desktop'], ['desktop'])).toEqual({ ok: true, profiles: ['desktop'] })
  })

  it('refuses to guess when no profile exists and none is named', () => {
    expect(chooseProfiles([], []).ok).toBe(false)
    expect(chooseProfiles(['node_modules'], []).ok).toBe(false)
  })

  it('skips the shared node_modules folder dsh keeps beside the profiles', () => {
    expect(chooseProfiles(['web', 'node_modules', 'desktop'], [])).toEqual({ ok: true, profiles: ['desktop', 'web'] })
  })
})

describe('the plugin row in cordis.patch.yml', () => {
  it('replaces the row with the new URL, keeps keep-voice-on, drops fields from earlier versions, and leaves every other line as it was', () => {
    const next = setPluginRow(PATCH, pluginRowConfig(PATCH, 'http://localhost:4201'))
    expect(next).toBe(PATCH.replace(
      [
        '- id: dsh-voice',
        '  config:',
        '    controlPlaneUrl: https://old.invalid:5007',
        '    sttServiceId: fluid-stt',
        '    keepVoiceOutside: true',
        '    rest: "{\\"tts\\":{}}"',
      ].join('\n'),
      ['- id: dsh-voice', '  config:', '    controlPlaneUrl: "http://localhost:4201"', '    keepVoiceOutside: true'].join('\n'),
    ))
  })

  it('appends a row to a file without one, and writes one into an empty file', () => {
    const without = '- id: ui-chat\n  config:\n    compact: true\n'
    expect(setPluginRow(without, pluginRowConfig(without, 'http://b.invalid'))).toBe(`${without}- id: dsh-voice\n  config:\n    controlPlaneUrl: "http://b.invalid"\n`)
    expect(setPluginRow('', pluginRowConfig('', 'http://b.invalid'))).toBe('- id: dsh-voice\n  config:\n    controlPlaneUrl: "http://b.invalid"\n')
  })

  it('in a new profile\'s file, the row replaces the empty list, and removing it puts the empty list back', () => {
    const fresh = '# Your patch layer for this dsh profile\n[]\n'
    const added = setPluginRow(fresh, pluginRowConfig(fresh, 'http://b.invalid'))
    expect(added).toBe('# Your patch layer for this dsh profile\n- id: dsh-voice\n  config:\n    controlPlaneUrl: "http://b.invalid"\n')
    expect(setPluginRow(added, null)).toBe('# Your patch layer for this dsh profile\n[]\n')
    // A file holding both the empty list and the row, as an earlier install could leave it, ends with one empty list.
    const both = `# header\n[]\n- id: dsh-voice\n  config:\n    controlPlaneUrl: "http://b.invalid"\n`
    expect(setPluginRow(both, null)).toBe('# header\n[]\n')
    expect(setPluginRow(both, pluginRowConfig(both, 'http://c.invalid'))).toBe('# header\n- id: dsh-voice\n  config:\n    controlPlaneUrl: "http://c.invalid"\n')
  })

  it('removing the row leaves every other line as it was, and a file without one unchanged', () => {
    const removed = setPluginRow(PATCH, null)
    expect(removed).not.toContain('dsh-voice')
    expect(removed).toContain('    welcome: !!js "Date.now()"')
    expect(removed.split('\n').filter(line => line.startsWith('- id:'))).toEqual(['- id: ui-settings-general', '- id: ui-chat'])
    expect(setPluginRow('- id: ui-chat\n', null)).toBe('- id: ui-chat\n')
  })
})
