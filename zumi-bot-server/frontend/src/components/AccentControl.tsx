import { ACCENTS, type Accent } from '@zumibot/shared/types'

const LABELS: Record<Accent, string> = { blue: 'Blue', teal: 'Teal', coral: 'Coral', graphite: 'Graphite' }

// Each option shows its own color as a swatch (styles/studio.css, .accent-swatch), whatever theme is showing, so the
// choice reads before it is made. Every option keeps its label: colors alone would not name them.
export function AccentControl(props: { value: Accent | null; onChange: (accent: Accent) => void }) {
  return (
    <div className="theme-seg accent-seg" role="group" aria-label="Color">
      {ACCENTS.map((a) => (
        <button
          key={a}
          type="button"
          data-tip={LABELS[a]}
          data-testid={`accent-${a}`}
          aria-pressed={props.value === a}
          onClick={() => {
            if (props.value !== a) props.onChange(a)
          }}
        >
          <span className="accent-swatch" data-swatch={a} aria-hidden="true" />
          <span>{LABELS[a]}</span>
        </button>
      ))}
    </div>
  )
}
