import { useSyncExternalStore } from 'react'
import type { UpdateStatus } from '@zumibot/shared/update'
import { api } from './api'
import {
  DISMISS_KEY,
  busyPrompt,
  callErrorText,
  clearedText,
  dismissStep,
  installErrorText,
  reloadNotice,
  rollBackPrompt,
  runOutcome,
  toastVersion
} from './state/update'

/** What a running install remembers, to know when the server's answer means it is over. */
interface Run {
  before: string
  seenAt: number | null
}
type Kind = 'install' | 'rollBack'

export interface UpdateView {
  status: UpdateStatus | null
  run: Run | null
  /** A confirm waiting for the user: 'ask' before every roll back, 'busy' when replies are running. */
  confirm: { kind: Kind; stage: 'ask' | 'busy'; prompt: string } | null
  message: string | null
  /** An Update or Roll back call is in flight (its buttons wait). */
  pending: boolean
  /** The version the toast offers, null for none. */
  toast: string | null
  /** The server runs a newer build than this tab loaded: the toast offers a reload (never forced). */
  reload: string | null
}

const POLL_MS = 2000

// One store for the toast, the overlay and About: they all read the same status, and the server pushes it once.
let view: UpdateView = { status: null, run: null, confirm: null, message: null, pending: false, toast: null, reload: null }
let dismissed: string | null = null
const listeners = new Set<() => void>()
let stop: (() => void) | null = null
let poll: ReturnType<typeof setInterval> | null = null

try {
  dismissed = localStorage.getItem(DISMISS_KEY)
} catch {
  // Storage can be blocked; the toast then shows again after a reload.
}

function set(patch: Partial<UpdateView>): void {
  const next = { ...view, ...patch }
  next.toast = toastVersion(next.status, dismissed)
  // While a run waits, receive reloads by itself once the version changes.
  next.reload = next.run ? null : reloadNotice(next.status?.current, __APP_VERSION__)
  view = next
  for (const l of [...listeners]) l()
}

function receive(s: UpdateStatus): void {
  // Another tab (or the server's own timer) started an install: this tab waits for it too.
  const run = view.run ?? (s.installing ? { before: s.current, seenAt: s.lastResult?.at ?? null } : null)
  const outcome = run ? runOutcome(run, s) : 'wait'
  if (run && outcome === 'reload') return location.reload()
  if (run && outcome === 'clear') {
    // It ended without a restart: drop the overlay and say why, instead of waiting for a restart that will not come.
    stopPolling()
    return set({ status: s, run: null, message: clearedText(s, run.seenAt) })
  }
  set({ status: s, run })
  if (run) startPolling()
}

function refresh(): void {
  api.update.status().then(receive, () => undefined) // down while the server restarts
}

function startPolling(): void {
  if (poll) return
  // The socket drops and reconnects across the restart, but a poll also covers a tab whose socket was already gone.
  poll = setInterval(() => {
    if (view.run) refresh()
    else stopPolling()
  }, POLL_MS)
}
function stopPolling(): void {
  if (poll) clearInterval(poll)
  poll = null
}

function start(): void {
  const offStatus = api.connection.onStatus((c) => c === 'connected' && refresh())
  const offChanged = api.update.onChanged(receive)
  // Coming back to the tab (or the desktop window out of the tray) asks too: the server checks the site again when its
  // last answer is stale, and a newer release then reaches every tab as update:changed, toast and all.
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') refresh()
  }
  document.addEventListener('visibilitychange', onVisible)
  refresh() // the first connect may already be over; a refusal while offline passes, the next connect asks again
  stop = () => {
    offStatus()
    offChanged()
    document.removeEventListener('visibilitychange', onVisible)
    stopPolling()
  }
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  if (listeners.size === 1) start()
  return () => {
    listeners.delete(l)
    if (listeners.size === 0) {
      stop?.()
      stop = null
    }
  }
}

export function useUpdate(): UpdateView {
  return useSyncExternalStore(subscribe, () => view)
}

// Module-level, not state: a second click lands before React has drawn the disabled button.
let starting = false

async function begin(kind: Kind, force: boolean): Promise<void> {
  const s = view.status
  if (!s || starting || view.run) return
  starting = true
  set({ message: null, pending: true })
  try {
    const r = await (kind === 'install' ? api.update.install({ force }) : api.update.rollBack({ force }))
    if ('busy' in r) return set({ message: null, confirm: { kind, stage: 'busy', prompt: busyPrompt(kind, r.busy) } })
    // A status that arrived meanwhile may already have set the run (the server pushes installing first); keep it.
    set({ confirm: null, run: view.run ?? { before: s.current, seenAt: s.lastResult?.at ?? null } })
    startPolling()
  } catch (e) {
    set({ confirm: null, run: null, message: installErrorText(e) })
  } finally {
    starting = false
    set({ pending: false })
  }
}

/** Starts an update or roll back. A roll back always asks first; with replies running either asks again (the confirm in `view.confirm`). */
export function startUpdate(kind: Kind = 'install'): Promise<void> {
  const last = view.status?.lastResult
  if (kind === 'rollBack' && last) {
    if (!starting && !view.run) set({ message: null, confirm: { kind, stage: 'ask', prompt: rollBackPrompt(last) } })
    return Promise.resolve()
  }
  return begin(kind, false)
}
export const answerConfirm = (yes: boolean): Promise<void> => {
  const c = view.confirm
  set({ confirm: null })
  // 'Yes' to the first ask still lets the server say replies are running; only the busy prompt forces.
  return yes && c ? begin(c.kind, c.stage === 'busy') : Promise.resolve()
}

/** The toast's x: an error line goes first; the version is hidden (and remembered) only when none shows. */
export function dismissToast(): void {
  const step = dismissStep(view.toast, view.message)
  if (step === 'message') return set({ message: null })
  if (step === 'none' || view.toast === null) return
  dismissed = view.toast
  try {
    localStorage.setItem(DISMISS_KEY, view.toast)
  } catch {
    // Not remembered across a reload; fine.
  }
  set({})
}

export const dismissMessage = (): void => set({ message: null })

/** Runs a status-returning call and publishes what it returns (Check); false when it failed. */
export async function updateCall(call: () => Promise<UpdateStatus>): Promise<boolean> {
  set({ message: null })
  try {
    receive(await call())
    return true
  } catch (e) {
    set({ message: callErrorText(e) })
    return false
  }
}
