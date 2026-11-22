import { promises as fs } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

// List keys merge across settings scopes, so a project's (or the user's) settings could add folders or hosts to a sandboxed
// run's own. Such a run is refused, never run wider than Agent Studio shows (governance.md 2.3, "Project settings that widen").

const WIDENING: readonly (readonly string[])[] = [
  ['sandbox', 'filesystem', 'allowWrite'],
  ['sandbox', 'filesystem', 'allowRead'],
  ['sandbox', 'network', 'allowedDomains'],
  ['sandbox', 'network', 'allowUnixSockets'],
  ['sandbox', 'excludedCommands'],
  ['permissions', 'additionalDirectories']
]

const at = (o: unknown, path: readonly string[]): unknown =>
  path.reduce<unknown>(
    (v, k) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>)[k] : undefined),
    o
  )

/** The widening keys a settings object sets to a non-empty list. */
export function wideningKeys(settings: unknown): string[] {
  return WIDENING.filter((p) => {
    const v = at(settings, p)
    return Array.isArray(v) && v.length > 0
  }).map((p) => p.join('.'))
}

/** The settings files the CLI reads for a run in `cwd`: the folder's and each parent's `.claude`, and the user's. */
export function settingsFilesOf(cwd: string, home: string): string[] {
  const files: string[] = []
  let dir = resolve(cwd)
  for (;;) {
    // ~/.claude/settings.json is the user scope, read below; a project at home itself is not a project.
    if (dir !== resolve(home)) files.push(join(dir, '.claude', 'settings.json'), join(dir, '.claude', 'settings.local.json'))
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  files.push(join(home, '.claude', 'settings.json'), join(home, '.claude', 'settings.local.json'), '/etc/claude-code/managed-settings.json')
  return files
}

/** The refusal line when any settings file the run would read widens the sandbox, else null. Unreadable JSON widens nothing. */
export async function wideningRefusal(cwd: string, home: string): Promise<string | null> {
  for (const file of settingsFilesOf(cwd, home)) {
    const text = await fs.readFile(file, 'utf8').catch(() => null)
    if (text === null) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      continue
    }
    const keys = wideningKeys(parsed)
    if (keys.length > 0) {
      return `This agent is sandboxed, but ${file} widens the sandbox (${keys.join(', ')}). Remove those keys, or turn isolation off for this agent in Agent Studio.`
    }
  }
  return null
}
