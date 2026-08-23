import type { SVGProps } from 'react'

export function BanterIcon(props: SVGProps<SVGSVGElement>) {
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

