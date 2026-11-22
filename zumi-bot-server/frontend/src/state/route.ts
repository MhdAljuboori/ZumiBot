// Each chat, Settings section, routine, the To-dos page and the Archived page has its own address, so a reload or a saved link opens
// it again; every other view lives at the root.
import { ARCHIVED, CHAT_PREFIX, NEW_ROUTINE, ROUTINES, TODOS, WORKFLOWS } from '@zumibot/shared/appPaths'
export {
  VOICE,
  archivedFromPath,
  chatIdFromPath,
  routinesPath,
  todosFromPath,
  voiceFromPath,
  workflowsPath
} from '@zumibot/shared/appPaths'

const SETTINGS = '/settings'

export const SETTINGS_SECTIONS = [
  'general',
  'notifications',
  'vault',
  'claude-code',
  'connectors',
  'channels',
  'audit',
  'voice',
  'jev',
  'usage',
  'sync',
  'island',
  'account',
  'about'
] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

export const pathFor = (chatId: string | null): string => (chatId === null ? '/' : CHAT_PREFIX + encodeURIComponent(chatId))

/** The Settings section a path names, or null outside Settings. An unknown section (an old link) opens General. */
export function settingsFromPath(pathname: string): SettingsSection | null {
  if (pathname !== SETTINGS && !pathname.startsWith(SETTINGS + '/')) return null
  const raw = pathname.slice(SETTINGS.length + 1)
  return SETTINGS_SECTIONS.find((s) => s === raw) ?? 'general'
}

export const settingsPath = (section: SettingsSection): string => `${SETTINGS}/${section}`

export const archivedPath = (chatId: string | null): string => (chatId === null ? ARCHIVED : `${ARCHIVED}/${encodeURIComponent(chatId)}`)

export const todosPath = (taskId: string | null): string => (taskId === null ? TODOS : `${TODOS}/${encodeURIComponent(taskId)}`)

const INBOX = '/inbox'

/** The Inbox (`/inbox`) and the message open in it (`/inbox/<id>`), or null elsewhere. */
export function inboxFromPath(pathname: string): { messageId: string | null } | null {
  if (pathname === INBOX) return { messageId: null }
  if (!pathname.startsWith(INBOX + '/')) return null
  const raw = pathname.slice(INBOX.length + 1)
  if (raw === '' || raw.includes('/')) return null
  try {
    return { messageId: decodeURIComponent(raw) }
  } catch {
    return null
  }
}

export const inboxPath = (messageId: string | null = null): string =>
  messageId === null ? INBOX : `${INBOX}/${encodeURIComponent(messageId)}`

/**
 * The Workflows views: the list (`/workflows`), a workflow (`/workflows/<id>`) and one of its runs
 * (`/workflows/<id>/runs/<runId>`, and `/audit` after it for the run's Audit log tab), or null elsewhere. Any other shape, a trailing slash included, is not routed.
 */
export function workflowsFromPath(pathname: string): { workflowId: string | null; runId: string | null; audit?: true } | null {
  if (pathname === WORKFLOWS) return { workflowId: null, runId: null }
  if (!pathname.startsWith(WORKFLOWS + '/')) return null
  const parts = pathname.slice(WORKFLOWS.length + 1).split('/')
  const audit = parts.length === 4 && parts[1] === 'runs' && parts[3] === 'audit'
  if (parts.length !== 1 && !(parts.length === 3 && parts[1] === 'runs') && !audit) return null
  if (parts.some((x, i) => i !== 1 && i !== 3 && x === '')) return null
  try {
    const route = { workflowId: decodeURIComponent(parts[0]), runId: parts.length >= 3 ? decodeURIComponent(parts[2]) : null }
    return audit ? { ...route, audit: true } : route
  } catch {
    return null
  }
}

/**
 * Routines mode (`/routines`), with nothing open (`routine` null), a new routine (`/routines/new`, `{id: null}`) or a
 * saved one (`/routines/<id>`); null elsewhere.
 */
export function routinesFromPath(pathname: string): { routine: { id: string | null } | null } | null {
  if (pathname === ROUTINES) return { routine: null }
  if (!pathname.startsWith(ROUTINES + '/')) return null
  const raw = pathname.slice(ROUTINES.length + 1)
  if (raw === '' || raw.includes('/')) return null
  if (raw === NEW_ROUTINE) return { routine: { id: null } }
  try {
    return { routine: { id: decodeURIComponent(raw) } }
  } catch {
    return null
  }
}

/**
 * How to bring the address bar to `want`. A move the app made (its path changed since the last sync) adds a history
 * entry; an address the view did not follow (Back to a deleted chat, a cancelled Back) is corrected in place.
 */
export function historyStep(current: string, want: string, last: string | null): 'push' | 'replace' | null {
  if (current === want) return null
  return last !== null && last !== want ? 'push' : 'replace'
}
