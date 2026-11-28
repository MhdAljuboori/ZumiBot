// Addresses of the app's views, kept in shared so the backend can read a chat address the way the UI does.
// The frontend's state/route.ts re-exports these.
export const CHAT_PREFIX = '/chat/'
export const ARCHIVED = '/archived'
export const TODOS = '/todos'
export const WORKFLOWS = '/workflows'
export const ROUTINES = '/routines'
export const VOICE = '/voice'
// Settings › Claude Code, where the user's skills are listed and edited (the frontend's settingsPath('claude-code')).
export const CLAUDE_CODE_SETTINGS = '/settings/claude-code'
// Routine ids are UUIDs, so this segment never names a saved routine.
export const NEW_ROUTINE = 'new'
// What `/todos/mine` named before the board (My to-dos); read as the board itself, so an old link still lands there.
const OLD_MY_TODOS = 'mine'

/** The chat a path names, or null for the root and anything this app does not route. */
export function chatIdFromPath(pathname: string): string | null {
  if (!pathname.startsWith(CHAT_PREFIX)) return null
  const raw = pathname.slice(CHAT_PREFIX.length)
  if (raw === '' || raw.includes('/')) return null
  try {
    return decodeURIComponent(raw)
  } catch {
    return null
  }
}

/** The Archived page (`/archived`) and the archived chat open in it (`/archived/<id>`), or null elsewhere. */
export function archivedFromPath(pathname: string): { chatId: string | null } | null {
  if (pathname === ARCHIVED) return { chatId: null }
  if (!pathname.startsWith(ARCHIVED + '/')) return null
  const raw = pathname.slice(ARCHIVED.length + 1)
  if (raw === '' || raw.includes('/')) return null
  try {
    return { chatId: decodeURIComponent(raw) }
  } catch {
    return null
  }
}

/** The task board (`/todos`) and the card open on it (`/todos/<task id>`), or null elsewhere. A chat id from before the board names no task, so the board just opens. */
export function todosFromPath(pathname: string): { taskId: string | null } | null {
  if (pathname === TODOS) return { taskId: null }
  if (!pathname.startsWith(TODOS + '/')) return null
  const raw = pathname.slice(TODOS.length + 1)
  if (raw === '' || raw.includes('/')) return null
  try {
    const id = decodeURIComponent(raw)
    return { taskId: id === OLD_MY_TODOS ? null : id }
  } catch {
    return null
  }
}

// A run belongs to a workflow, so a run id without one has no address of its own.
// The audit tab is a run's too, so it has no address without one.
export function workflowsPath(workflowId: string | null, runId: string | null = null, audit = false): string {
  if (workflowId === null) return WORKFLOWS
  const base = `${WORKFLOWS}/${encodeURIComponent(workflowId)}`
  if (runId === null) return base
  const run = `${base}/runs/${encodeURIComponent(runId)}`
  return audit ? `${run}/audit` : run
}

export const routinesPath = (routine: { id: string | null } | null): string =>
  routine === null ? ROUTINES : `${ROUTINES}/${routine.id === null ? NEW_ROUTINE : encodeURIComponent(routine.id)}`

/** The voice conversation page (`/voice`); `start` is the home-screen shortcut's `?start=1`, which asks it to start listening. Null elsewhere. */
export function voiceFromPath(pathname: string, search: string): { start: boolean } | null {
  if (pathname !== VOICE) return null
  return { start: new URLSearchParams(search).get('start') === '1' }
}
