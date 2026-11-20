// The settings page's control that dsh's primitives do not cover: a Radix
// Select carrying the classes settings.css styles. It is bundled into the
// plugin and uses dsh's React through the module table.

import { useContext, type ReactNode } from 'react'
import * as Select from '@radix-ui/react-select'
import { ReadOnly, SCOPE } from './settings-style.ts'

const Chevron = () => (
  <svg className="dv-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 6l4 4 4-4" />
  </svg>
)

const Check = () => (
  <svg className="dv-item-mark" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3.5 8.5l3 3 6-7" />
  </svg>
)

export interface SelectOption {
  value: string
  label: ReactNode
  disabled?: boolean
}

export function SelectField({ id, value, options, onChange, alwaysEnabled }: {
  id: string
  value: string
  options: readonly SelectOption[]
  onChange: (value: string) => void
  /** A browser-only choice, which stays editable when dsh's stored settings are read-only. */
  alwaysEnabled?: boolean
}) {
  const readOnly = useContext(ReadOnly)
  return (
    <Select.Root value={value} onValueChange={onChange} disabled={readOnly && alwaysEnabled !== true}>
      <Select.Trigger id={id} className="dv-trigger">
        <Select.Value />
        <Select.Icon asChild><Chevron /></Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className={`${SCOPE} dv-menu`} position="popper" sideOffset={4}>
          <Select.Viewport className="dv-viewport">
            {options.map(option => (
              <Select.Item key={option.value} value={option.value} disabled={option.disabled} className="dv-item">
                <Select.ItemText>{option.label}</Select.ItemText>
                <Select.ItemIndicator><Check /></Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  )
}
