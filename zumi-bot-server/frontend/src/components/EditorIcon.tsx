export type EditorIconName =
  | 'sliders'
  | 'code'
  | 'revert'
  | 'trash'
  | 'save'
  | 'idcard'
  | 'chip'
  | 'palette'
  | 'tools'
  | 'terminal'
  | 'wand'
  | 'copy'
  | 'check'
  | 'info'
  | 'file'
  | 'shield'
  | 'list'

/** Line icons for the agent editor, drawn like the sidebar glyphs: 16px grid, current text color. */
export function EditorIcon({ name }: { name: EditorIconName }) {
  return (
    <svg
      className="glyph"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {name === 'sliders' && (
        <>
          <path d="M2.5 4.5h6M12.5 4.5h1M2.5 11.5h1M7.5 11.5h6" />
          <circle cx="10.5" cy="4.5" r="1.75" />
          <circle cx="5.5" cy="11.5" r="1.75" />
        </>
      )}
      {name === 'code' && <path d="M5 4.5 1.75 8 5 11.5M11 4.5 14.25 8 11 11.5M9.25 3 6.75 13" />}
      {name === 'revert' && <path d="M2.75 2.75v3.5h3.5M3 6.1A5.5 5.5 0 1 1 3.4 10.5" />}
      {name === 'trash' && <path d="M2.75 4.25h10.5M6.25 4.25V2.75h3.5v1.5M4.25 4.25l.6 9h6.3l.6-9M6.75 7v3.75M9.25 7v3.75" />}
      {name === 'save' && <path d="M2.75 2.75h8l2.5 2.5v8H2.75zM5.25 2.75v3h5v-3M4.75 13.25v-4h6.5v4" />}
      {name === 'idcard' && (
        <>
          <rect x="1.75" y="3" width="12.5" height="10" rx="1.75" />
          <circle cx="5.5" cy="7" r="1.4" />
          <path d="M3.5 10.5c.4-.9 1.1-1.35 2-1.35s1.6.45 2 1.35M9.5 6.5h3M9.5 9.25h3" />
        </>
      )}
      {name === 'chip' && (
        <>
          <rect x="4" y="4" width="8" height="8" rx="1.25" />
          <path d="M6.75 6.75h2.5v2.5h-2.5zM6.25 1.75V4M9.75 1.75V4M6.25 12v2.25M9.75 12v2.25M1.75 6.25H4M1.75 9.75H4M12 6.25h2.25M12 9.75h2.25" />
        </>
      )}
      {name === 'palette' && (
        <>
          <path d="M8 1.75a6.25 6.25 0 1 0 0 12.5c.85 0 1.4-.55 1.4-1.3 0-.4-.17-.7-.4-1-.22-.3-.4-.6-.4-1 0-.75.6-1.3 1.4-1.3h1.55c1.75 0 2.9-1.25 2.9-2.95C14.45 3.95 11.6 1.75 8 1.75z" />
          <g fill="currentColor" stroke="none">
            <circle cx="4.75" cy="7.5" r="0.95" />
            <circle cx="6.5" cy="4.6" r="0.95" />
            <circle cx="9.9" cy="4.6" r="0.95" />
          </g>
        </>
      )}
      {name === 'tools' && (
        <path d="M10.25 2a3.25 3.25 0 0 0-3.1 4.25L2.4 11a1.45 1.45 0 0 0 2.05 2.05L9.2 8.3A3.25 3.25 0 0 0 13.45 5.2L11.6 7l-2-.6-.6-2z" />
      )}
      {name === 'terminal' && <path d="M2.5 4l4 4-4 4M8.5 12.5h5" />}
      {name === 'wand' && <path d="M2.5 13.5l7.25-7.25M8.75 5.25l2 2M12.5 1.75v3M11 3.25h3M13 9v2M12 10h2M5 2v2M4 3h2" />}
      {name === 'copy' && (
        <>
          <rect x="5.5" y="5.5" width="8.25" height="8.25" rx="1.5" />
          <path d="M10.5 5.5V3.75a1.5 1.5 0 0 0-1.5-1.5H3.75a1.5 1.5 0 0 0-1.5 1.5V9a1.5 1.5 0 0 0 1.5 1.5H5.5" />
        </>
      )}
      {name === 'check' && <path d="M3 8.5l3.25 3L13 4.5" />}
      {name === 'info' && (
        <>
          <circle cx="8" cy="8" r="6.25" />
          <path d="M8 7.25v4M8 4.9v.1" />
        </>
      )}
      {name === 'file' && <path d="M4 1.75h5l3 3v9.5H4zM9 1.75v3h3" />}
      {name === 'shield' && <path d="M8 1.75l5 2v3.9c0 3.1-2.1 5.5-5 6.6-2.9-1.1-5-3.5-5-6.6v-3.9z" />}
      {name === 'list' && <path d="M2 4.25l1 1 2-2M2 9.25l1 1 2-2M7.5 4.5h6.5M7.5 9.5h6.5M7.5 13h6.5" />}
    </svg>
  )
}
