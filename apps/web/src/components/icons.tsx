import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

const base = {
  width: 24,
  height: 24,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
}

export function PhoneIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M6.5 3.5h2.2l1.5 3.6-1.8 1.4a11.5 11.5 0 0 0 5.1 5.1l1.4-1.8 3.6 1.5v2.2a2.5 2.5 0 0 1-2.7 2.5C10.1 17.5 6.5 13.9 4 7.2A2.5 2.5 0 0 1 6.5 3.5Z" />
    </svg>
  )
}

export function VideoIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="3" y="6.5" width="12" height="11" rx="2.2" />
      <path d="M15 10.2l5.2-2.6a.6.6 0 0 1 .8.6v7.6a.6.6 0 0 1-.8.6L15 13.8Z" />
    </svg>
  )
}

export function MicIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="9" y="3" width="6" height="10.5" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" />
    </svg>
  )
}

export function SmileIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.5 14.2c.9 1.2 2.1 1.8 3.5 1.8s2.6-.6 3.5-1.8" />
      <path d="M9 9.6h.01M15 9.6h.01" strokeWidth="2.4" />
    </svg>
  )
}

export function PlusIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 8.4v7.2M8.4 12h7.2" />
    </svg>
  )
}

export function MoreIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="5.5" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="12" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function CloseIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
    </svg>
  )
}
