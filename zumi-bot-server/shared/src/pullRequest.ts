import type { PrCheck, PrChecks, PrState } from './types'

// Pure, like gitChanges.ts: the frontend draws from these and the backend folds `gh`'s JSON with them.

export const PR_TITLE_MAX = 256
export const PR_BODY_MAX = 60_000
/** The tail of a failing check's log that Send to agent carries; the rest is dropped with a line saying how much. */
export const LOG_TAIL_MAX = 4_000
/** Commits listed in the Open PR dialog and in a drafted body. */
export const PR_COMMITS_MAX = 50

export const GH_MISSING = 'gh is not installed. Install the GitHub CLI to open pull requests from here.'
export const GH_LOGGED_OUT = 'gh is installed but not signed in. Run `gh auth login` in a terminal, then try again.'

/**
 * Anything token-shaped is replaced before a message is stored, logged or shown: gh prints a token back in some of its
 * errors, and a chat item, a log line and the meta all outlive the moment.
 */
export function scrubToken(text: string): string {
  return (
    text
      .replace(/\bgh[pousr]_[A-Za-z0-9_]{16,}/g, '***')
      .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '***')
      // A remote URL can carry credentials, and git prints the remote back in a rejected push.
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1***@')
  )
}

/**
 * One line out of a tool's stderr: its own `error:` or `fatal:` line when it has one, else the first line. Scrubbed and
 * cut, so nothing of the environment and no token reaches the user, a log or the meta.
 */
export function toolLine(stderr: string, fallback: string): string {
  const lines = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const first = lines.find((l) => /^(error|fatal|x |X )/i.test(l)) ?? lines[0]
  return scrubToken((first ?? fallback).replace(/^[xX]\s+/, '')).slice(0, 300)
}

// ---------- the checks rollup ----------

type Raw = Record<string, unknown>
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const up = (v: unknown): string => str(v).toUpperCase()

/** What one entry of the rollup amounts to. SKIPPED and NEUTRAL are not failures, so they count as passing. */
function outcomeOf(e: Raw): 'pending' | 'passing' | 'failing' {
  // A CheckRun reports status + conclusion; a StatusContext only state.
  const status = up(e.status)
  const state = up(e.state)
  if (status === 'QUEUED' || status === 'IN_PROGRESS' || status === 'WAITING' || status === 'PENDING') return 'pending'
  if (state === 'PENDING' || state === 'EXPECTED') return 'pending'
  const done = up(e.conclusion) || state
  if (done === '') return 'pending' // reported but not concluded yet
  return ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR'].includes(done) ? 'failing' : 'passing'
}

const nameOf = (e: Raw): string => str(e.name) || str(e.context) || 'check'
// A status's target URL is whatever the integration that posted it said: only an https link becomes clickable.
const httpsOnly = (u: string): string => (/^https:\/\//i.test(u) ? u : '')
const urlOf = (e: Raw): string => httpsOnly(str(e.detailsUrl)) || httpsOnly(str(e.targetUrl))

/** The Actions job a check's details URL points at: `…/runs/<run>/job/<job>`; absent for anything but Actions. */
export function jobIdOf(url: string): string | undefined {
  const m = /\/runs\/\d+\/job\/(\d+)/.exec(url)
  return m ? m[1] : undefined
}

/**
 * `statusCheckRollup` folded into what the card and the chip show. A failure wins over anything still running: a check
 * that failed is a fact, and waiting to say so would hide it until the rest finish.
 */
export function foldRollup(raw: unknown): PrChecks | undefined {
  if (!Array.isArray(raw)) return undefined
  const entries = raw.filter((e): e is Raw => typeof e === 'object' && e !== null)
  if (entries.length === 0) return undefined
  const failing: PrCheck[] = []
  let pending = 0
  for (const e of entries) {
    const o = outcomeOf(e)
    if (o === 'pending') pending += 1
    else if (o === 'failing') {
      const url = urlOf(e)
      const jobId = jobIdOf(url)
      failing.push({ name: nameOf(e), ...(url ? { url } : {}), ...(jobId ? { jobId } : {}) })
    }
  }
  const status = failing.length > 0 ? 'failing' : pending > 0 ? 'pending' : 'passing'
  return { status, total: entries.length, pending, failing }
}

/** "3 checks passing", "1 of 4 failing", "2 checks running". */
export function checksLine(c: PrChecks | undefined): string | null {
  if (!c) return null
  const n = (k: number) => `${k} ${k === 1 ? 'check' : 'checks'}`
  if (c.status === 'failing') return `${c.failing.length} of ${n(c.total)} failing`
  if (c.status === 'pending') return `${n(c.pending)} running`
  return `${n(c.total)} passing`
}

/** What the chip and the card read beside a PR: "#12 · open", with the checks when there are any. */
export function prLabel(pr: { number: number; state: PrState; draft?: true; checks?: PrChecks }): string {
  const head = `#${pr.number} · ${pr.draft && pr.state === 'open' ? 'draft' : pr.state}`
  const checks = checksLine(pr.checks)
  return checks === null ? head : `${head} · ${checks}`
}

/** A PR is worth polling only while it is open and something is still running. */
export const prUnfinished = (pr: { state: PrState; checks?: PrChecks }): boolean => pr.state === 'open' && pr.checks?.status === 'pending'

// ---------- the dialog's draft ----------

/** One line per commit, `<sha> <subject>`, as `git log --oneline` gives them. */
export const commitSubjects = (lines: readonly string[]): string[] =>
  lines.map((l) => l.replace(/^[0-9a-f]{7,40}\s+/, '').trim()).filter((l) => l !== '')

/** The title the dialog starts with: the card's own, else the one commit's subject, else the branch. */
export function draftTitle(card: string | null, commits: readonly string[], branch: string): string {
  const subjects = commitSubjects(commits)
  const from = (card ?? '').trim() || (subjects.length === 1 ? subjects[0] : '') || branch.replace(/^zumibot\//, '')
  return from.replace(/\s+/g, ' ').trim().slice(0, PR_TITLE_MAX)
}

/** The body the dialog starts with: the card's notes, then what the branch commits. Nothing is sent that the user did not see. */
export function draftBody(notes: string | null, commits: readonly string[]): string {
  const parts: string[] = []
  const text = (notes ?? '').trim()
  if (text !== '') parts.push(text)
  const subjects = commitSubjects(commits).slice(0, PR_COMMITS_MAX)
  if (subjects.length > 0) parts.push(['## Commits', ...subjects.map((s) => `- ${s}`)].join('\n'))
  return parts.join('\n\n').slice(0, PR_BODY_MAX)
}

// ---------- Send to agent ----------

/** The last `LOG_TAIL_MAX` characters of a log, with a line saying what was dropped. */
export function logTail(log: string): string {
  const text = log.replace(/\r\n?/g, '\n').replace(/\n+$/, '')
  if (text.length <= LOG_TAIL_MAX) return text
  const kept = text.slice(text.length - LOG_TAIL_MAX)
  const from = kept.indexOf('\n') // start on a whole line
  return `… ${text.length - LOG_TAIL_MAX} earlier characters not shown\n${from < 0 ? kept : kept.slice(from + 1)}`
}

/**
 * The ordinary user turn Send to agent posts: which check failed, where it is, and the tail of its log. A check that is
 * not a GitHub Actions job has no log through gh, and the message says so instead of pretending.
 */
export function checkMessage(pr: { number: number }, check: PrCheck, log: string | null): string {
  const lines = [`The check **${check.name}** is failing on pull request #${pr.number}.`]
  if (check.url) lines.push(check.url)
  if (log === null || log.trim() === '') {
    lines.push('', 'Its log is not available through the GitHub CLI, so open the link to read it.')
  } else {
    const tail = scrubToken(logTail(log))
    lines.push('', 'The tail of its log:', '```', tail, '```')
  }
  lines.push('', 'Please work out why it fails and fix it.')
  return lines.join('\n')
}
