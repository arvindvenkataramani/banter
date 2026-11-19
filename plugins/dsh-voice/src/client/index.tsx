// Client half: the plugin's browser entry, loaded by dsh's module system as
// the factory for this package's bare-name row.

import { createElement } from 'react'
import type { DshClientContext } from './dsh-types.ts'
import { SettingsCard, type CardFields } from './settings-card.tsx'
import { createShownSession } from './shown-session.ts'
import { VoiceButton } from './voice-button.tsx'

/** The package name keys the bundle config card; the patch row id names the host entry whose config the card edits. */
export const PACKAGE_NAME = '@banter/dsh-voice'
export const ENTRY_ID = 'dsh-voice'

/** The dsh services this entry needs before `apply` runs. */
export const inject = ['slots', 'sessions', 'layout', 'configForms']

export function apply(ctx: DshClientContext): void {
  const shown = createShownSession(ctx)
  ctx.effect(() => shown.dispose, 'dsh-voice: shown session')

  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'dsh-voice',
  }, VoiceButton))

  const form = ctx.configForms.get<CardFields>(ENTRY_ID)
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    key: PACKAGE_NAME,
  }, () => createElement(SettingsCard, { form })))

  if (__SPIKE__) void import('../../spike/probe.tsx').then(probe => { probe.install(ctx, shown) })
}
