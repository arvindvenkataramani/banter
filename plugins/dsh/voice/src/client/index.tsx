// Client half: the plugin's browser entry, loaded by dsh's module system as
// the factory for this package's bare-name row.

import { createElement } from 'react'
import { useVoiceSystemStore } from '@platform/voice-engine/system/voice-system'
import type { PluginSettings } from '../host/settings.ts'
import { ActivationPrompt } from './activation-prompt.tsx'
import type { DshClientContext, DshSessionSlotProps } from './dsh-types.ts'
import { createVoiceRuntime } from './runtime.ts'
import { SettingsCard } from './settings-card.tsx'
import { createShownSession } from './shown-session.ts'
import { VoiceControls } from './voice-button.tsx'

/** The package name keys the bundle config card; the patch row id names the host entry whose config the card edits. */
export const PACKAGE_NAME = '@banter/dsh-voice'
export const ENTRY_ID = 'dsh-voice'

/** The dsh services this entry needs before `apply` runs. */
export const inject = ['slots', 'sessions', 'layout', 'configForms', 'shortcuts']

/** Mic mute. Space types in dsh's editor, so the default is a modified key, rebindable in dsh's shortcut settings. */
const MIC_SHORTCUT_BINDING = { code: 'KeyM', modifiers: ['primary', 'alt'] } as const
/** dsh admits only three web combinations on Linux, and this is the one no dsh command uses. */
const MIC_SHORTCUT_WEB_LINUX = { code: 'Comma', modifiers: ['primary', 'shift'] } as const

export function apply(ctx: DshClientContext): void {
  const origin = window.location.origin
  const shown = createShownSession(ctx)
  const form = ctx.configForms.get<PluginSettings>(ENTRY_ID)
  const runtime = createVoiceRuntime({ ctx, shown, form, origin })
  ctx.effect(() => () => {
    runtime.dispose()
    shown.dispose()
  }, 'dsh-voice: runtime')

  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'dsh-voice',
  }, (props: DshSessionSlotProps) => createElement(VoiceControls, { ...props, runtime })))

  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    key: PACKAGE_NAME,
  }, () => createElement(SettingsCard, { form })))

  ctx.slots.inject('plugins.bundle.activation', () => ctx.slots.register({
    name: 'plugins.bundle.activation',
    key: PACKAGE_NAME,
  }, (props: { onDismiss(): void; onOpenDetails(): void }) => createElement(ActivationPrompt, { runtime, origin, ...props })))

  ctx.effect(() => ctx.shortcuts.register({
    id: 'voice.toggleMic',
    label: () => 'Mute or unmute the voice mic',
    aliases: ['voice mute', 'mute microphone'],
    defaults: {
      'desktop:macos': MIC_SHORTCUT_BINDING,
      'desktop:windows': MIC_SHORTCUT_BINDING,
      'desktop:linux': MIC_SHORTCUT_BINDING,
      'web:macos': MIC_SHORTCUT_BINDING,
      'web:windows': MIC_SHORTCUT_BINDING,
      'web:linux': MIC_SHORTCUT_WEB_LINUX,
    },
    regions: ['page', 'editable'],
    modals: [],
    resolve: () => (useVoiceSystemStore.getState().phase === 'live'
      ? { status: 'handled', run: () => { runtime.toggleMic() } }
      : { status: 'pass' }),
  }), 'dsh-voice: mic shortcut')
}
