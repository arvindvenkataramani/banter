import type { SVGProps } from 'react'

// Accepts Phosphor's `weight` so it can stand in the nav bar beside Phosphor
// icons, and drops it rather than writing it onto the <svg>.
export function BanterIcon({ weight: _weight, ...props }: SVGProps<SVGSVGElement> & { weight?: string }) {
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      stroke="currentColor"
      strokeWidth={4.5}
      strokeLinecap="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M13 6v34" />
      <circle cx="25" cy="30" r="11" />
    </svg>
  )
}

