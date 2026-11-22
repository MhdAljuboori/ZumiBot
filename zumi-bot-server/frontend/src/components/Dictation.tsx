import { keepFocus } from '../media'
import { formatElapsed, langLabel, micLabel, transcribingText, voiceErrorText } from '../state/voice'
import type { Dictation } from '../useDictation'

function MicIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="5.75" y="1.75" width="4.5" height="8" rx="2.25" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M3.5 7.75a4.5 4.5 0 0 0 9 0M8 12.25v2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

/** The mic beside Send: tap to start, tap to stop; while transcribing a tap cancels. */
export function DictationButton({ d, disabled }: { d: Dictation; disabled: boolean }) {
  const { phase } = d.state
  const label = micLabel(phase)
  return (
    <button
      type="button"
      className="dictation-btn"
      data-testid="dictation-button"
      data-phase={phase}
      aria-label={label}
      aria-pressed={phase === 'listening'}
      data-tip={label}
      disabled={disabled}
      onMouseDown={keepFocus}
      onClick={d.tap}
    >
      {phase === 'listening' ? (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="currentColor" />
        </svg>
      ) : phase === 'transcribing' ? (
        <span className="spinner" aria-hidden="true" />
      ) : (
        <MicIcon />
      )}
    </button>
  )
}

/** The line above the box while dictating, its error, and the live region that announces each step. */
export function DictationStrip({ d }: { d: Dictation }) {
  const { phase, error } = d.state
  let line = null
  if (phase === 'error' && error) {
    line = (
      <div className="attach-error" role="alert" data-testid="dictation-error">
        {voiceErrorText(error)}
      </div>
    )
  } else if (phase === 'listening') {
    const lang = langLabel(d.lang)
    line = (
      <div className="dictation-strip" data-testid="dictation-strip">
        {/* The spaces are for the text read out and copied; the flex gap spaces it on screen. */}
        <span className="dictation-dot" aria-hidden="true">
          ●
        </span>{' '}
        Listening <span className="dictation-time">{formatElapsed(d.elapsedMs)}</span> <span aria-hidden="true">·</span>{' '}
        <button
          type="button"
          className="dictation-lang"
          data-testid="dictation-lang"
          aria-label={`Dictation language: ${lang}`}
          data-tip="Dictation language: Auto, English or Arabic"
          onMouseDown={keepFocus}
          onClick={d.cycleLang}
        >
          {lang}
        </button>
      </div>
    )
  } else if (phase === 'transcribing') {
    line = (
      <div className="dictation-strip" data-testid="dictation-strip">
        {transcribingText(d.state)}
        {d.state.capped && (
          <>
            {' '}
            <span className="dictation-note">Stopped at 5:00</span>
          </>
        )}
      </div>
    )
  } else if (phase === 'idle' && d.capNote) {
    line = (
      <div className="dictation-strip" data-testid="dictation-strip">
        <span className="dictation-note">Stopped at 5:00</span>
      </div>
    )
  }
  return (
    <>
      {/* Always in the page: a live region added together with its text is often not announced. */}
      <div className="sr-only" role="status" aria-live="polite">
        {d.announcement}
      </div>
      {line}
    </>
  )
}
