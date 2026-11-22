import { ALREADY_UPDATING, isNewer, parseVersion, type UpdateResult, type UpdateStatus } from '@zumibot/shared/update'

/** The release whose toast the user closed; a newer release shows it again. */
export const DISMISS_KEY = 'zumibot.update.dismissed'

/** The version the toast offers, or null: nothing newer, an install that cannot update itself, one already running, or one dismissed. */
export function toastVersion(s: UpdateStatus | null, dismissed: string | null): string | null {
  if (!s || s.availability !== 'ok' || !s.newer || s.installing || !s.latest) return null
  return s.latest.version === dismissed ? null : s.latest.version
}

/** Why an install cannot update, or null when it can. */
function unavailableLine(s: UpdateStatus): string | null {
  // Local mode updates itself only in a packaged desktop app; a development run always serves its own fresh build.
  if (s.availability === 'local') return 'Updates are off in a development run of the desktop app'
  if (s.availability === 'container') return 'Updates are not available in a container install: run the Docker installer again'
  if (s.availability === 'notInstaller') return 'Updates need the installer install'
  return null
}

/** The one status line under Version in About. */
export function aboutLine(s: UpdateStatus): string {
  const unavailable = unavailableLine(s)
  if (unavailable) return unavailable
  if (s.installing) return 'Updating…'
  if (s.checking) return 'Checking…'
  // "Up to date" would be a guess before the first check has answered.
  if (s.checkedAt === null) return 'Not checked yet'
  return s.newer && s.latest ? `Version ${s.latest.version} is available` : 'Up to date'
}

/** Check for updates does something: the server only checks when updates are available here, and one check runs at a time. */
export const canCheck = (s: UpdateStatus): boolean => s.availability === 'ok' && !s.checking && !s.installing

const stamp = (at: number): string => new Date(at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })

export const checkedLine = (checkedAt: number | null): string => (checkedAt === null ? 'Never' : stamp(checkedAt))

/** The last install, as a sentence. */
export function resultLine(r: UpdateResult): string {
  if (r.kind === 'updated') return `Updated from ${r.from} to ${r.to} on ${stamp(r.at)}`
  if (r.kind === 'rolledBack') return `Rolled back from ${r.from} to ${r.to} on ${stamp(r.at)}`
  // A failed roll back is stored as 'failed' going to the older version (or to no known version).
  if (isRollBackFailure(r)) return `Roll back${parseVersion(r.to) ? ` to ${r.to}` : ''} failed on ${stamp(r.at)}`
  return `Update to ${r.to} failed on ${stamp(r.at)}`
}

function isRollBackFailure(r: UpdateResult): boolean {
  return r.kind === 'failed' && (!parseVersion(r.to) || isNewer(r.from, r.to))
}

/** Roll back is offered only right after an update that swapped: older app.prev/data.prev pairs belong to an earlier update. */
export function canOfferRollBack(s: UpdateStatus): boolean {
  return s.canRollBack && s.lastResult?.kind === 'updated'
}

/** The confirm shown before every roll back (the busy prompt comes after it, when replies run). */
export function rollBackPrompt(r: UpdateResult): string {
  const day = new Date(r.at).toLocaleDateString([], { dateStyle: 'medium' })
  return `Go back to v${r.from}? Chats and settings changed since ${day} are set aside (kept in a .failed folder on the server).`
}

/** What the updating overlay suggests once an update takes too long: no server to log in to in Local mode. */
export function slowHint(local: boolean): string {
  return local
    ? 'If ZumiBot does not come back, quit it and open it again. A version that will not start is set aside, and the one the app came with runs.'
    : 'If the server does not come back, run ~/zumibot/bin/zumibot-rollback on the server.'
}

/** The toast line when the server runs another build than this tab loaded, or null (not known yet, or the same). */
export function reloadNotice(current: string | undefined, built: string): string | null {
  return current && current !== built ? `ZumiBot was updated. Reload to use v${current}.` : null
}

/**
 * What a running install's latest status means: wait while it runs; reload only when the version changed (the server
 * restarted into another build); otherwise it ended without a restart (a failed download or run, replies busy after the
 * download, a failed roll back) and the overlay must go, so the user can read why.
 */
export function runOutcome(run: { before: string }, s: UpdateStatus): 'wait' | 'reload' | 'clear' {
  if (s.installing) return 'wait'
  return s.current !== run.before ? 'reload' : 'clear'
}

/** The line shown after a run cleared: the server's error, else a result newer than `seenAt` (the one seen at the click). */
export function clearedText(s: UpdateStatus, seenAt: number | null): string {
  if (s.error) return s.error
  if (s.lastResult !== null && s.lastResult.at !== seenAt) return resultLine(s.lastResult)
  return 'The update stopped before it installed'
}

/** What the toast's x closes: an error line first, so a transient error never hides the version for good. */
export function dismissStep(toast: string | null, message: string | null): 'message' | 'version' | 'none' {
  if (toast === null) return 'none'
  return message !== null ? 'message' : 'version'
}

/** The confirm text when replies are still running. */
export function busyPrompt(kind: 'install' | 'rollBack', n: number): string {
  const them = n === 1 ? 'it' : 'them'
  const running = `${n} ${n === 1 ? 'reply is' : 'replies are'} running.`
  return kind === 'install'
    ? `${running} Updating stops ${them}. Update anyway?`
    : `${running} Rolling back stops ${them}. Roll back anyway?`
}

/** What to tell the user when a status call (Check) is refused. */
export function callErrorText(e: unknown): string {
  if (!(e instanceof Error)) return 'The request failed'
  return e.message || 'The request failed'
}

/** What to tell the user when starting an install or roll back is refused. */
export function installErrorText(e: unknown): string {
  if (!(e instanceof Error)) return 'Could not start the update'
  return e.message === ALREADY_UPDATING ? 'An update is already running' : e.message || 'Could not start the update'
}
