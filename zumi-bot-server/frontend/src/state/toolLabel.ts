import { AGUI_TEXT, AGUI_TOOL } from '@zumibot/shared/agui'
import { automationSummary } from '@zumibot/shared/automations'
import { desktopActionSummary } from '@zumibot/shared/desktop'
import { applyPatchPaths, toolSummary } from '@zumibot/shared/toolSummary'
import { visibleText } from '@zumibot/shared/visibleText'

/** A tool call's row head (chat and dispatched agents): what it did in words, and the exact command, path or URL under it. */
export interface ToolLabel {
  title: string
  detail: string | null
}

const DETAIL_MAX = 300

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null)
const pos = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null)

/** One line (a multi-line command reads past its first line), hidden characters escaped: the agent wrote it. */
function line(s: string, max = DETAIL_MAX): string {
  const t = visibleText(s.replace(/\s+/g, ' ').trim())
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

const baseName = (p: string): string => p.replace(/\/+$/, '').split('/').pop() || p

// Codex's calls on its subagents (a `collabAgentToolCall`'s tool), in words.
const SUBAGENT_CALLS = new Map([
  ['wait', 'Wait for subagents'],
  ['sendInput', 'Message a subagent'],
  ['closeAgent', 'Close a subagent'],
  ['resumeAgent', 'Resume a subagent']
])

/** "lines 40–119" for a Read with offset/limit; the CLI's offset is the first line read. */
function lines(o: Obj): string {
  const from = pos(o.offset)
  const count = pos(o.limit)
  if (count !== null) return ` (lines ${from ?? 1}–${(from ?? 1) + count - 1})`
  return from !== null ? ` (from line ${from})` : ''
}

function host(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

export function toolLabel(name: string, input: unknown): ToolLabel {
  const desktop = desktopActionSummary(name, input)
  if (desktop !== null) return { title: desktop, detail: null }
  const o = isObj(input) ? input : {}
  switch (name) {
    case 'Bash': {
      const cmd = str(o.command)
      const what = str(o.description)
      if (what !== null) return { title: line(what, 200), detail: cmd === null ? null : line(cmd) }
      return { title: 'Bash', detail: cmd === null ? null : line(cmd) }
    }
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit': {
      const path = str(o.file_path) ?? str(o.notebook_path)
      const verb = name === 'NotebookEdit' ? 'Edit' : name
      if (path === null) return { title: verb, detail: null }
      return { title: line(`${verb} ${baseName(path)}${name === 'Read' ? lines(o) : ''}`, 200), detail: line(path) }
    }
    case 'Grep': {
      const pattern = str(o.pattern)
      const where = [str(o.path), str(o.glob)].filter((x): x is string => x !== null).join(' · ')
      return { title: pattern === null ? 'Search' : line(`Search for ${pattern}`, 200), detail: where === '' ? null : line(where) }
    }
    case 'Glob': {
      const pattern = str(o.pattern)
      const where = str(o.path)
      return { title: pattern === null ? 'Find files' : line(`Find files ${pattern}`, 200), detail: where === null ? null : line(where) }
    }
    case 'WebFetch': {
      const url = str(o.url)
      return url === null ? { title: 'Fetch a page', detail: null } : { title: line(`Fetch ${host(url)}`, 200), detail: line(url) }
    }
    case 'Agent':
    case 'Task': {
      const what = str(o.description)
      const type = str(o.subagent_type)
      return { title: what === null ? 'Agent' : line(`Agent: ${what}`, 200), detail: type === null ? null : line(type) }
    }
    case 'ApplyPatch': {
      const paths = applyPatchPaths(o)
      if (paths.length === 0) return { title: 'Apply patch', detail: null }
      return { title: 'Apply patch', detail: line(`${baseName(paths[0])}${paths.length > 1 ? ` +${paths.length - 1} more` : ''}`) }
    }
    case 'SandboxPermissions':
      return { title: 'Sandbox permissions', detail: null }
    // A Codex call on its subagents other than a spawn: what it did, and the subagents it named.
    case 'Subagents': {
      const tool = str(o.tool)
      const agents = Array.isArray(o.agents) ? o.agents.filter((a): a is string => str(a) !== null) : []
      const title = tool === null ? 'Subagents' : (SUBAGENT_CALLS.get(tool) ?? line(`Subagents: ${tool}`, 200))
      return { title, detail: agents.length ? line(agents.join(', ')) : null }
    }
    case 'WebSearch': {
      const q = str(o.query)
      return { title: q === null ? 'Search the web' : line(`Search the web: ${q}`, 200), detail: null }
    }
    // A remote agent's tool ran on its server, never here, and the row says so; its name and arguments are the server's.
    case AGUI_TOOL: {
      const tool = str(o.tool)
      const args = str(o.argsText) ?? (o.args === undefined || o.args === null ? null : str(JSON.stringify(o.args)))
      return { title: AGUI_TEXT.remoteTool(tool === null ? null : line(tool, 200)), detail: args === null ? null : line(args) }
    }
  }
  if (name.startsWith('mcp__')) {
    // mcp__<server>__<tool>: the tool in words, its server and first text argument under it.
    const [, server = '', ...rest] = name.split('__')
    const tool = rest.join('__').replace(/_/g, ' ')
    const first = Object.values(o).find((v): v is string => str(v) !== null)
    // A delete's head is its exact target, as on its approval card.
    const target = automationSummary(name, input)
    return { title: line(target ?? (tool || name), 200), detail: line(first === undefined ? server : `${server} · ${first}`) }
  }
  return { title: visibleText(toolSummary(name, input)), detail: null }
}
