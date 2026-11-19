// The slice of dsh's shared module table the client half imports. The build
// leaves these as `require` calls answered by the page's module loader.

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ButtonHTMLAttributes, ComponentType, ForwardRefExoticComponent, ReactNode, RefAttributes } from 'react'
  export const Button: ForwardRefExoticComponent<
    { variant?: 'primary' | 'ghost' | 'outline' | 'toolbar'; size?: 'md' | 'sm'; icon?: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement> & RefAttributes<HTMLButtonElement>
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
}
