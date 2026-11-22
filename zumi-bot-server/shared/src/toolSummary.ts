import { automationSummary } from './automations'
import { FILL_FIELD_LABELS, isFillField } from './vault'

const MAX = 80

const cut = (s: string): string => (s.length > MAX ? s.slice(0, MAX - 1) + '…' : s)

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/** The file paths of a Codex ApplyPatch call's `changes` (`{path, kind}` entries), in order. */
export function applyPatchPaths(o: Record<string, unknown>): string[] {
  if (!Array.isArray(o.changes)) return []
  return o.changes.flatMap((c) =>
    c && typeof c === 'object' && typeof (c as { path?: unknown }).path === 'string' ? [(c as { path: string }).path] : []
  )
}

const baseName = (p: string): string => p.replace(/\/+$/, '').split('/').pop() || p

export function toolSummary(name: string, input: unknown): string {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const automation = automationSummary(name, input)
  if (automation !== null) return cut(automation)
  switch (name) {
    case 'Bash': {
      const first = (str(o.command) ?? '').split('\n')[0]
      return cut(`Bash(${first})`)
    }
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return cut(`${name} ${str(o.file_path) ?? str(o.notebook_path) ?? ''}`.trimEnd())
    case 'Grep':
    case 'Glob':
      return cut(`${name} ${str(o.pattern) ?? ''}`.trimEnd())
    case 'ApplyPatch': {
      const paths = applyPatchPaths(o)
      if (paths.length === 0) return 'ApplyPatch'
      return cut(`ApplyPatch ${baseName(paths[0])}${paths.length > 1 ? ` +${paths.length - 1} more` : ''}`)
    }
    case 'WebFetch':
      return cut(`WebFetch ${str(o.url) ?? ''}`.trimEnd())
    case 'WebSearch':
      return cut(`WebSearch ${str(o.query) ?? ''}`.trimEnd())
    case 'mcp__zumibot_vault__vault_items':
      return 'Checked the vault'
    // The stored row's input is only {item: <name>, field}.
    case 'mcp__zumibot_browser__browser_fill_from_vault':
      return cut(
        `Filled from vault · ${str(o.item) ?? 'unknown item'} · ${isFillField(o.field) ? FILL_FIELD_LABELS[o.field] : 'unknown field'}`
      )
    default: {
      const first = Object.values(o).find((v): v is string => typeof v === 'string')
      return cut(first === undefined ? name : `${name} ${first}`)
    }
  }
}
