import { CLAUDE_DENIED, type EngineCommand } from '@zumibot/shared/engineCommands'

// Pure. Turns the raw answer of a commands probe into the rows the `/` menu may show. Rows are built field by field, so nothing
// else the CLI answered (the account, models, paths) is kept. A shape that is not the expected one gives no rows, never a throw.

/** `path` is Codex only: a skill's SKILL.md, kept on the server and never sent to a page. */
export interface EngineCommandRow extends EngineCommand {
  path?: string
}

// Same shape as the composer's `/name` rule, plus `:` for plugin-namespaced commands.
const NAME = /^[A-Za-z0-9][A-Za-z0-9_:.-]*$/
// Names ZumiBot answers itself, so an engine row of that name would never run.
const RESERVED = new Set(['btw', 'todo', 'run-workflow'])
// A plugin named after the other engine (Claude Code's `codex:rescue`, `codex:review`…) hands the work to that engine: the
// menu of one engine's chat shows only that engine's own commands.
const OTHER_ENGINE: Record<'claude' | 'codex', string> = { claude: 'codex:', codex: 'claude:' }
const MAX_DESCRIPTION = 300
// A hint is a few words beside the name; a long one would push the menu row wider than the menu.
const MAX_HINT = 80

const obj = (v: unknown): Record<string, any> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : null

const validName = (v: unknown): v is string => typeof v === 'string' && NAME.test(v)

// The first line only: a long description is a menu row, not a manual.
const oneLine = (v: unknown): string => (typeof v === 'string' ? v.split(/\r?\n/, 1)[0].trim().slice(0, MAX_DESCRIPTION) : '')

/**
 * The names `get_skills_dialog` lists, which tell a skill from a command in `initialize`'s one list. A claude.ai skill is listed
 * there as `anthropic-skills:pdf` but runs as `/pdf`, so its short name counts too (for a non-built-in row only: a CLI built-in
 * of that name, such as `/deep-research`, is a command of its own).
 */
function claudeSkillNames(answer: unknown): { full: Set<string>; synced: Set<string> } {
  const full = new Set<string>()
  const synced = new Set<string>()
  const list = obj(answer)?.skills
  if (!Array.isArray(list)) return { full, synced }
  for (const item of list) {
    const s = obj(item)
    if (!s || typeof s.name !== 'string') continue
    full.add(s.name)
    if (s.source === 'claude.ai sync') synced.add(s.name.slice(s.name.lastIndexOf(':') + 1))
  }
  return { full, synced }
}

/** `skills` is the `get_skills_dialog` answer; without one every row is a command. */
export function claudeCommandRows(answer: unknown, skills?: unknown): EngineCommandRow[] {
  const list = obj(answer)?.commands
  if (!Array.isArray(list)) return []
  const skill = claudeSkillNames(skills)
  const seen = new Set<string>()
  const rows: EngineCommandRow[] = []
  for (const item of list) {
    const c = obj(item)
    if (!c || !validName(c.name)) continue
    const name = c.name
    // Only a CLI built-in can be denied: a user's own command called `model` is theirs.
    if (c.builtin === true && CLAUDE_DENIED.has(name)) continue
    if (name.startsWith('__') || name.startsWith(OTHER_ENGINE.claude) || RESERVED.has(name) || seen.has(name)) continue
    seen.add(name)
    const isSkill = skill.full.has(name) || (c.builtin !== true && skill.synced.has(name))
    const row: EngineCommandRow = { name, description: oneLine(c.description), kind: isSkill ? 'skill' : 'command' }
    const hint = typeof c.argumentHint === 'string' ? c.argumentHint.trim().slice(0, MAX_HINT) : ''
    if (hint) row.hint = hint
    rows.push(row)
  }
  return rows
}

export function codexSkillRows(answer: unknown): EngineCommandRow[] {
  const folders = obj(answer)?.data
  if (!Array.isArray(folders)) return []
  const seen = new Set<string>()
  const rows: EngineCommandRow[] = []
  for (const folder of folders) {
    const skills = obj(folder)?.skills
    if (!Array.isArray(skills)) continue
    for (const item of skills) {
      const s = obj(item)
      if (!s || s.enabled !== true || !validName(s.name) || typeof s.path !== 'string' || seen.has(s.name)) continue
      if (s.name.startsWith(OTHER_ENGINE.codex)) continue
      seen.add(s.name)
      const short = obj(s.interface)?.shortDescription ?? s.shortDescription ?? s.description
      rows.push({ name: s.name, description: oneLine(short), path: s.path, kind: 'skill' })
    }
  }
  return rows
}
