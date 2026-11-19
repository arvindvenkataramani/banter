// The slice of dsh's shared module table the client half imports. The build
// leaves these as `require` calls answered by the page's module loader.
// Signatures follow the primitives' declarations (dsh-client-ui-primitives
// lib/types); rc.5's client bundles use each export named here.

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ButtonHTMLAttributes, ComponentType, ForwardRefExoticComponent, InputHTMLAttributes, ReactElement, ReactNode, RefAttributes } from 'react'
  export const Button: ForwardRefExoticComponent<
    { variant?: 'primary' | 'ghost' | 'outline' | 'toolbar'; size?: 'md' | 'sm'; icon?: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement> & RefAttributes<HTMLButtonElement>
  >
  export const Input: ForwardRefExoticComponent<
    { icon?: ReactNode; className?: string } & InputHTMLAttributes<HTMLInputElement> & RefAttributes<HTMLInputElement>
  >
  export const Modal: ComponentType<{
    open: boolean
    onClose: () => void
    title: string
    closeLabel: string
    description?: string
    children?: ReactNode
    footer?: ReactNode
  }>
  export function SegmentedTabs<Value extends string>(props: {
    items: readonly [{ value: Value; label: ReactNode; id: string; panelId: string }, ...Array<{ value: Value; label: ReactNode; id: string; panelId: string }>]
    value: Value
    onChange: (value: Value) => void
    label: string
    className?: string
  }): ReactNode
  export function Switch(props: {
    checked: boolean
    onChange: (next: boolean) => void
    label: string
    disabled?: boolean
    title?: string
    className?: string
  }): ReactElement
  export function Tag(props: {
    tone?: 'outline' | 'solid' | 'neutral' | 'quiet' | 'success' | 'info' | 'warning' | 'danger'
    className?: string
    children?: ReactNode
  }): ReactElement
  export function Tooltip(props: {
    label: string | (() => string)
    side?: 'right' | 'bottom' | 'top'
    portal?: boolean
    delayMs?: number
    maxWidth?: number
    children: ReactElement
  }): ReactElement
}
