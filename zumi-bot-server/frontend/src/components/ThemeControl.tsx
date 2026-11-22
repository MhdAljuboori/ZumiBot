import { THEME_PREFS, type ThemePref } from '@zumibot/shared/types'

const LABELS: Record<ThemePref, string> = { system: 'System', light: 'Light', dark: 'Dark' }
const TITLES: Record<ThemePref, string> = { system: 'Follow system', light: 'Light', dark: 'Dark' }

function ThemeIcon({ theme }: { theme: ThemePref }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      {theme === 'system' && (
        <>
          <rect x="1.5" y="2.5" width="13" height="9" rx="1.5" />
          <path d="M5.5 14h5M8 11.5V14" />
        </>
      )}
      {theme === 'light' && (
        <>
          <circle cx="8" cy="8" r="3" />
          <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M3 13l1.4-1.4M11.6 4.4L13 3" />
        </>
      )}
      {theme === 'dark' && <path d="M13.5 9.5A5.5 5.5 0 1 1 6.5 2.5a4.5 4.5 0 0 0 7 7z" />}
    </svg>
  )
}

// Only the chosen option shows its label; the others are icon buttons named by aria-label.
export function ThemeControl(props: { value: ThemePref | null; onChange: (theme: ThemePref) => void }) {
  return (
    <div className="theme-seg" role="group" aria-label="Theme">
      {THEME_PREFS.map((t) => (
        <button
          key={t}
          type="button"
          data-tip={TITLES[t]}
          aria-label={LABELS[t]}
          data-testid={`theme-${t}`}
          aria-pressed={props.value === t}
          onClick={() => {
            if (props.value !== t) props.onChange(t)
          }}
        >
          <ThemeIcon theme={t} />
          {props.value === t && <span>{LABELS[t]}</span>}
        </button>
      ))}
    </div>
  )
}
