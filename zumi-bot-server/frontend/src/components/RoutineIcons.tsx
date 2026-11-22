const ICON = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true
} as const

export type RoutineIconName =
  'calendar' | 'chat' | 'history' | 'clock' | 'play' | 'expand' | 'agent' | 'bulb' | 'shield' | 'section' | 'alert'

/** Glyphs for the routine editor's card heads and buttons. */
export function RoutineIcon({ name }: { name: RoutineIconName }) {
  return (
    <svg className="glyph" {...ICON}>
      {name === 'calendar' && (
        <>
          <rect x="3.5" y="5" width="17" height="15" rx="3" />
          <path d="M8 3v4M16 3v4M3.5 10h17" />
        </>
      )}
      {name === 'chat' && (
        <>
          <path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7l-4.5 3.5V17H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" />
          <path d="M8 10h8M8 13h5" />
        </>
      )}
      {name === 'history' && (
        <>
          <path d="M3.5 12a8.5 8.5 0 1 0 2.5-6" />
          <path d="M3.5 4.5V8H7M12 8v4l3 2" />
        </>
      )}
      {name === 'clock' && (
        <>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 7.5V12l3 2" />
        </>
      )}
      {name === 'agent' && (
        <>
          <rect x="4" y="7" width="16" height="12" rx="3" />
          <path d="M12 7V4M9 12v1M15 12v1" />
        </>
      )}
      {name === 'bulb' && (
        <>
          <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V16h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z" />
        </>
      )}
      {name === 'shield' && (
        <>
          <path d="M12 3.5l7 2.8v5.4c0 4.2-2.9 7.6-7 8.8-4.1-1.2-7-4.6-7-8.8V6.3z" />
          <path d="M12 8.5v4M12 15.5v.01" />
        </>
      )}
      {name === 'section' && (
        <>
          <path d="M12 4l8.5 4.5L12 13 3.5 8.5z" />
          <path d="M3.5 12.5L12 17l8.5-4.5M3.5 16.5L12 21l8.5-4.5" />
        </>
      )}
      {name === 'alert' && (
        <>
          <path d="M10.3 4.2 2.9 17.5A2 2 0 0 0 4.6 20.5h14.8a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z" />
          <path d="M12 9.5v4M12 17v.01" />
        </>
      )}
      {name === 'play' && <path d="M8 5.5v13l10.5-6.5z" />}
      {name === 'expand' && <path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" />}
    </svg>
  )
}

/** A card's square icon tile, the title and a one-line subtitle, with the card's control after them. */
export function CardHead({
  icon,
  title,
  subtitle,
  children
}: {
  icon: RoutineIconName
  title: string
  subtitle: string
  children?: React.ReactNode
}) {
  return (
    <div className="rt-card-head">
      <span className="rt-tile">
        <RoutineIcon name={icon} />
      </span>
      <div className="rt-card-title">
        <h3>{title}</h3>
        {subtitle && <div className="rt-sub">{subtitle}</div>}
      </div>
      {children}
    </div>
  )
}
