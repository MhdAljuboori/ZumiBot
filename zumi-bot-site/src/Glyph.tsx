import type { ReactNode } from 'react'

// Line icons for the drawn app windows, in a 24 box.
const GLYPHS = {
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </>
  ),
  bell: <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5h4" />,
  agents: (
    <>
      <rect x="4" y="7" width="16" height="12" rx="4" />
      <path d="M12 3.5V7M9.5 12.5v1.5M14.5 12.5v1.5" />
    </>
  ),
  routines: (
    <>
      <circle cx="6.5" cy="6.5" r="2.5" />
      <circle cx="17.5" cy="17.5" r="2.5" />
      <path d="M9 6.5h4a3 3 0 0 1 3 3v5.5" />
    </>
  ),
  workflows: (
    <>
      <circle cx="5.5" cy="7" r="2" />
      <circle cx="5.5" cy="17" r="2" />
      <circle cx="18.5" cy="12" r="2" />
      <path d="M7.5 7c5 0 4 5 9 5M7.5 17c5 0 4-5 9-5" />
    </>
  ),
  todos: <path d="M4 6.5l1.5 1.5L8 5.5M4 12.5l1.5 1.5L8 11.5M11 7h9M11 13h9M11 19h9" />,
  inbox: (
    <>
      <rect x="3.5" y="4.5" width="17" height="4" rx="1" />
      <path d="M5 8.5V19h14V8.5M10 12.5h4" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  branch: (
    <>
      <circle cx="6" cy="5.25" r="2.7" />
      <circle cx="6" cy="18.75" r="2.7" />
      <circle cx="18" cy="8.25" r="2.7" />
      <path d="M6 8v8.1M18 11c0 4.5-12 3-12 5.1" />
    </>
  ),
  file: <path d="M5 3h10l4 4v14H5z" />,
  chevron: <path d="M6 9l6 6 6-6" />,
  attach: <path d="M20 11.5l-8 8a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L9.7 17a1.7 1.7 0 0 1-2.4-2.4L15 7" />,
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
    </>
  ),
  send: <path d="M12 19V5M5 12l7-7 7 7" />,
  check: <path d="M5 12.5l4.5 4.5L19 7" />,
  download: <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />,
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
    </>
  ),
  palette: (
    <>
      <path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.1 0 1.7-.8 1.7-1.6 0-1.2-1-1.5-1-2.6 0-.9.8-1.6 1.7-1.6h2.4a3.7 3.7 0 0 0 3.7-3.7c0-4.3-3.8-7.5-8.5-7.5z" />
      <circle cx="8" cy="11" r="1" />
      <circle cx="11" cy="7.5" r="1" />
      <circle cx="15.5" cy="8.5" r="1" />
    </>
  ),
  engine: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  link: <path d="M10 14a4 4 0 0 1 0-5.6l2.8-2.8a4 4 0 0 1 5.6 5.6L17 12.6M14 10a4 4 0 0 1 0 5.6l-2.8 2.8a4 4 0 0 1-5.6-5.6L7 11.4" />,
  calendar: (
    <>
      <rect x="4" y="5" width="16" height="15" rx="2" />
      <path d="M4 10h16M9 3v4M15 3v4" />
    </>
  ),
  message: <path d="M4 5h16v11H9l-5 4z" />,
  history: <path d="M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4M12 8v4l3 2" />,
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  )
} satisfies Record<string, ReactNode>

export type GlyphName = keyof typeof GLYPHS

export function Glyph({ name, size = 16, weight = 1.8 }: { name: GlyphName; size?: number; weight?: number }) {
  return (
    <svg
      className="glyph"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={weight}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {GLYPHS[name]}
    </svg>
  )
}

/** GitHub's mark (Octicons `mark-github`), filled in the link's color. The link around it carries the name. */
export function GitHubMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}

/** The pointer drawn over a mock window: filled, with a ring in the page color so it reads on any surface. */
export function Pointer({ className, fill = 'var(--fg)' }: { className: string; fill?: string }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 2l15 11-6.5 1.2L9 21z" fill={fill} stroke="var(--bg)" strokeWidth="1.5" />
    </svg>
  )
}
