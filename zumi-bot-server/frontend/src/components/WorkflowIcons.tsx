import type { StepKind, WorkflowTrigger } from '@zumibot/shared/workflows'

const ICON = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true
} as const

/** The rail's Workflows glyph, for a message a workflow sent. */
export function WorkflowGlyph() {
  return (
    <svg className="glyph" {...ICON}>
      <circle cx="5" cy="6" r="2" />
      <circle cx="19" cy="12" r="2" />
      <circle cx="5" cy="18" r="2" />
      <path d="M7 6h3a4 4 0 0 1 4 4v0.5M7 18h3a4 4 0 0 0 4-4v-0.5M14 12h3" />
    </svg>
  )
}

/** One glyph per step kind, the same stroke style as the routine icons. Used by the canvas nodes, the add menu and the inspector. */
export function StepIcon({ kind }: { kind: StepKind }) {
  return (
    <svg className="glyph" {...ICON}>
      {kind === 'trigger' && <path d="M13 3 5 14h6l-1 7 8-11h-6z" />}
      {kind === 'agent' && (
        <>
          <rect x="4" y="7" width="16" height="12" rx="3" />
          <path d="M12 7V4M9 12v1M15 12v1" />
        </>
      )}
      {kind === 'room' && (
        <>
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
        </>
      )}
      {kind === 'chat' && <path d="M4 5.5h16v10.5H10l-4.5 3.5V16H4z" />}
      {kind === 'foreach' && <path d="M19.5 12a7.5 7.5 0 1 1-2.4-5.5M19.5 4v4h-4M10 9.5l4 2.5-4 2.5z" />}
      {kind === 'llm' && <path d="M12 3.5l1.9 5 5 1.9-5 1.9-1.9 5-1.9-5-5-1.9 5-1.9zM18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" />}
      {kind === 'condition' && (
        <>
          <path d="M12 3.5 20.5 12 12 20.5 3.5 12z" />
          <path d="M10 10.2a2 2 0 1 1 2.6 1.9c-.4.2-.6.5-.6.9M12 15.4v.01" />
        </>
      )}
      {kind === 'approval' && (
        <>
          <path d="M12 3.5l7 2.8v5.4c0 4.2-2.9 7.6-7 8.8-4.1-1.2-7-4.6-7-8.8V6.3z" />
          <path d="M8.8 12.2l2.2 2.2 4.2-4.4" />
        </>
      )}
      {kind === 'wait' && <path d="M7 3.5h10M7 20.5h10M8 3.5V6l4 6 4-6V3.5M8 20.5V18l4-6 4 6v2.5" />}
      {kind === 'notify' && (
        <>
          <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15z" />
          <path d="M10 20.5a2 2 0 0 0 4 0" />
        </>
      )}
      {kind === 'http' && (
        <>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M3.5 12h17M12 3.5c2.4 2.3 3.6 5.1 3.6 8.5s-1.2 6.2-3.6 8.5c-2.4-2.3-3.6-5.1-3.6-8.5s1.2-6.2 3.6-8.5z" />
        </>
      )}
      {kind === 'transform' && <path d="M4 6h16l-6 7v5l-4 2v-7z" />}
      {kind === 'workflow' && (
        <>
          <rect x="3.5" y="4" width="7" height="6" rx="1.5" />
          <rect x="13.5" y="14" width="7" height="6" rx="1.5" />
          <path d="M7 10v3a2 2 0 0 0 2 2h4.5M11.5 13l2 2-2 2" />
        </>
      )}
    </svg>
  )
}

/** The trigger's kind on a sidebar row: a play mark, a clock, a bolt, a speech bubble, a checkbox, a tray, a document or an envelope. */
export function TriggerKindIcon({ kind }: { kind: WorkflowTrigger['kind'] }) {
  return (
    <svg className="glyph" {...ICON}>
      {kind === 'schedule' && (
        <>
          <circle cx="12" cy="12" r="8" />
          <path d="M12 8v4l3 2" />
        </>
      )}
      {kind === 'webhook' && <path d="M13 3 5 14h6l-1 7 8-11h-6z" />}
      {kind === 'manual' && <path d="M8 5v14l11-7z" />}
      {kind === 'reply' && (
        <path d="M5 5h14a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 16h-7l-4.5 4v-4H5a1.5 1.5 0 0 1-1.5-1.5v-8A1.5 1.5 0 0 1 5 5z" />
      )}
      {kind === 'todo' && (
        <>
          <rect x="4" y="4" width="16" height="16" rx="3" />
          <path d="m8.5 12.5 2.5 2.5 4.5-5" />
        </>
      )}
      {kind === 'inbox' && (
        <path d="M3.5 13.5 6 5.5h12l2.5 8M3.5 13.5V18a1.5 1.5 0 0 0 1.5 1.5h14a1.5 1.5 0 0 0 1.5-1.5v-4.5h-5.5a3 3 0 0 1-6 0z" />
      )}
      {kind === 'file' && (
        <>
          <path d="M6 3.5h8l4 4V19a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5 19V5a1.5 1.5 0 0 1 1-1.5z" />
          <path d="M14 3.5V8h4M8.5 13h7M8.5 16.5h7" />
        </>
      )}
      {kind === 'email' && (
        <>
          <rect x="3.5" y="5.5" width="17" height="13" rx="2" />
          <path d="m4 7 8 6 8-6" />
        </>
      )}
    </svg>
  )
}
