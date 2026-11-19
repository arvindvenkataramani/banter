// The settings page's controls that dsh's primitives do not cover: Radix
// Select, Slider and RadioGroup, carrying the classes settings.css styles.
// They are bundled into the plugin and use dsh's React through the module table.

import { useContext, type ReactNode } from 'react'
import * as RadioGroup from '@radix-ui/react-radio-group'
import * as Select from '@radix-ui/react-select'
import * as Slider from '@radix-ui/react-slider'
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

export function SelectField({ id, value, options, onChange }: {
  id: string
  value: string
  options: readonly SelectOption[]
  onChange: (value: string) => void
}) {
  const readOnly = useContext(ReadOnly)
  return (
    <Select.Root value={value} onValueChange={onChange} disabled={readOnly}>
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

export function SliderField({ label, min, max, step, value, disabled, onChange }: {
  label: string
  min: number
  max: number
  step: number
  value: number
  disabled?: boolean
  onChange: (value: number) => void
}) {
  const readOnly = useContext(ReadOnly)
  return (
    <Slider.Root
      className="dv-slider"
      min={min}
      max={max}
      step={step}
      value={[value]}
      disabled={disabled === true || readOnly}
      onValueChange={([next]) => { onChange(next) }}
    >
      <Slider.Track className="dv-slider-track"><Slider.Range className="dv-slider-range" /></Slider.Track>
      <Slider.Thumb className="dv-slider-thumb" aria-label={label} />
    </Slider.Root>
  )
}

export interface RadioChoice<Value extends string> {
  value: Value
  label: string
  description: ReactNode
  /** Rendered under the choice when it is the selected one. */
  extra?: ReactNode
}

/** A radio group of labelled choices, each with a one-line description under its label. */
export function RadioChoices<Value extends string>({ name, label, description, value, choices, onChange }: {
  /** Prefix of the choices' element ids. */
  name: string
  /** The group's name, shown above the choices as a field label. */
  label: string
  /** What the choice decides, shown under the label. */
  description?: ReactNode
  value: Value
  choices: readonly RadioChoice<Value>[]
  onChange: (value: Value) => void
}) {
  const readOnly = useContext(ReadOnly)
  return (
    <div className="dv-field">
      <span id={`${name}-label`} className="dv-label">{label}</span>
      {description !== undefined && <p className="dv-help">{description}</p>}
    <RadioGroup.Root className="dv-radios" value={value} onValueChange={next => { onChange(next as Value) }} disabled={readOnly} aria-labelledby={`${name}-label`}>
      {choices.map(choice => (
        <div key={choice.value} className="dv-field">
          <div className="dv-radio-row">
            <RadioGroup.Item id={`${name}-${choice.value}`} value={choice.value} className="dv-radio">
              <RadioGroup.Indicator className="dv-radio-dot" />
            </RadioGroup.Item>
            <div className="dv-radio-text">
              <label htmlFor={`${name}-${choice.value}`} className="dv-label">{choice.label}</label>
              <p className="dv-help">{choice.description}</p>
            </div>
          </div>
          {value === choice.value && choice.extra !== undefined && <div className="dv-indent">{choice.extra}</div>}
        </div>
      ))}
    </RadioGroup.Root>
    </div>
  )
}
