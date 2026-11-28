import { LATER_DESCRIPTION } from '@zumibot/shared/later'
import { describe, expect, it } from 'vitest'
import type { CommandPick, CommandSummary } from '@zumibot/shared/commands'
import type { AgentSummary } from '@zumibot/shared/types'
import type { EngineCommands } from '@zumibot/shared/engineCommands'
import { RUN_WORKFLOW_DESCRIPTION } from '@zumibot/shared/runWorkflow'
import {
  commentCommandMap,
  commentCommandMarks,
  commentCommandOptions,
  commentSlashQuery,
  filterCommands,
  filterWorkflowNames,
  insertCommentCommand,
  groupOptions,
  insertCommandName,
  keepPick,
  keepWorkflowPick,
  slashQuery,
  textSlashQuery,
  workflowMenuQuery,
  workflowQuery,
  type CommandOption
} from '../src/state/commandInput'

const agent = (name: string, commands: CommandSummary[], error: string | null = null): AgentSummary => ({
  filePath: `/agents/${name}.md`,
  name,
  description: '',
  color: null,
  icon: null,
  error,
  builtIn: false,
  commands
})

const wk = agent('wk', [
  { name: 'check', description: 'Check a built card and add it to a release' },
  { name: 'fix', description: 'Fix one bug and open a PR' }
])
const fix = agent('fx', [{ name: 'fixit', description: 'Mend it' }])
const rv = agent('rv', [{ name: 'check', description: 'Review a change against the structure' }])
const broken = agent('broken', [{ name: 'check', description: 'Never listed' }], 'bad frontmatter')
const plain = agent('plain', undefined as unknown as CommandSummary[])

const flagged = agent('fl', [
  { name: 'my-day', description: 'Plan my day', todos: true },
  { name: 'todo', description: 'Own todo', todos: true }
])

const ids = (options: readonly CommandOption[]): string[] =>
  options.map((o) => ('builtin' in o ? `builtin/${o.builtin}` : 'engine' in o ? `${o.engine}/${o.command.name}` : `${o.agent.name}/${o.command.name}`))

describe('filterCommands btw option', () => {
  it('leaves out the btw built-in when btw is false, keeps todo and agent commands', () => {
    expect(ids(filterCommands('', [wk], { btw: false }))).toEqual(['wk/check', 'wk/fix', 'builtin/todo', 'builtin/run-workflow', 'builtin/later'])
    expect(ids(filterCommands('bt', [wk], { btw: false }))).toEqual([])
  })
  it('keeps btw by default and when btw is true', () => {
    expect(ids(filterCommands('bt', [wk]))).toEqual(['builtin/btw'])
    expect(ids(filterCommands('bt', [wk], { btw: true }))).toEqual(['builtin/btw'])
  })
})

describe('filterCommands todo option', () => {
  it('leaves out the todo built-in when todo is false, keeps btw and agent commands', () => {
    expect(ids(filterCommands('', [wk], { todo: false }))).toEqual(['wk/check', 'wk/fix', 'builtin/btw', 'builtin/run-workflow', 'builtin/later'])
    expect(ids(filterCommands('tod', [wk], { todo: false }))).toEqual([])
  })
  it('also leaves out an agent command that makes to-dos by itself: the server would refuse it', () => {
    expect(ids(filterCommands('', [flagged], { todo: false, btw: false, runWorkflow: false, later: false }))).toEqual([])
    expect(ids(filterCommands('', [flagged], { btw: false, runWorkflow: false, later: false }))).toEqual(['fl/my-day', 'builtin/todo'])
  })
  it('keeps todo by default and when todo is true', () => {
    expect(ids(filterCommands('tod', [wk]))).toEqual(['builtin/todo'])
    expect(ids(filterCommands('tod', [wk], { todo: true }))).toEqual(['builtin/todo'])
  })
})

describe('filterCommands run-workflow option', () => {
  it('lists /run-workflow with its description by prefix', () => {
    expect(filterCommands('run', [wk])).toContainEqual({ builtin: 'run-workflow', description: RUN_WORKFLOW_DESCRIPTION })
    expect(ids(filterCommands('RUN-W', [wk]))).toEqual(['builtin/run-workflow'])
  })
  it('is not offered after /todo, nor when runWorkflow is false', () => {
    expect(ids(filterCommands('run', [wk], { afterTodo: true }))).toEqual([])
    expect(ids(filterCommands('run', [wk], { runWorkflow: false }))).toEqual([])
    expect(ids(filterCommands('', [wk], { runWorkflow: false }))).toEqual(['wk/check', 'wk/fix', 'builtin/btw', 'builtin/todo', 'builtin/later'])
  })
  it('hides an agent command of the same name', () => {
    const own = agent('own', [
      { name: 'run-workflow', description: 'Mine' },
      { name: 'run-it', description: 'Other' }
    ])
    expect(ids(filterCommands('run', [own]))).toEqual(['own/run-it', 'builtin/run-workflow'])
  })
})

describe('filterCommands later option', () => {
  it('lists /later with its description by prefix, last among the built-ins', () => {
    expect(filterCommands('lat', [wk])).toContainEqual({ builtin: 'later', description: LATER_DESCRIPTION })
    expect(ids(filterCommands('', [wk], { btw: false, todo: false, runWorkflow: false }))).toEqual(['wk/check', 'wk/fix', 'builtin/later'])
  })
  it('is not offered after /todo, nor when later is false', () => {
    expect(ids(filterCommands('lat', [wk], { afterTodo: true }))).toEqual([])
    expect(ids(filterCommands('lat', [wk], { later: false }))).toEqual([])
  })
  it('hides an agent command of the same name', () => {
    const own = agent('own', [{ name: 'later', description: 'Mine' }])
    expect(ids(filterCommands('lat', [own]))).toEqual(['builtin/later'])
  })
})

describe('workflowQuery', () => {
  it('is the text after /run-workflow and its whitespace', () => {
    expect(workflowQuery('/run-workflow dai')).toBe('dai')
    expect(workflowQuery('/run-workflow ')).toBe('')
    expect(workflowQuery('/run-workflow   dai')).toBe('dai')
  })
  it('stays on the text past the name, so the menu filters to none and closes', () => {
    expect(workflowQuery('/run-workflow Daily report x')).toBe('Daily report x')
  })
  it('is null until the space, and for other text', () => {
    expect(workflowQuery('/run-workflow')).toBeNull()
    expect(workflowQuery('/run-workflowx dai')).toBeNull()
    expect(workflowQuery('x /run-workflow dai')).toBeNull()
    expect(workflowQuery('/todo /run-workflow dai')).toBeNull()
    expect(workflowQuery('/btw dai')).toBeNull()
    expect(workflowQuery('')).toBeNull()
  })
})

describe('filterWorkflowNames', () => {
  const ws = [
    { id: '1', name: 'Weekly report' },
    { id: '2', name: 'Report digest' },
    { id: '3', name: 'Daily report' },
    { id: '4', name: 'Cleanup' },
    { id: '5', name: '  ' }
  ]
  it('lists name prefixes first, then word prefixes, each in list order', () => {
    expect(filterWorkflowNames('rep', ws).map((w) => w.id)).toEqual(['2', '1', '3'])
    expect(filterWorkflowNames('REP', ws).map((w) => w.id)).toEqual(['2', '1', '3'])
  })
  it('lists all for an empty query, skipping nameless ones', () => {
    expect(filterWorkflowNames('', ws).map((w) => w.id)).toEqual(['1', '2', '3', '4'])
  })
  it('matches across words and is empty when nothing matches', () => {
    expect(filterWorkflowNames('weekly rep', ws).map((w) => w.id)).toEqual(['1'])
    expect(filterWorkflowNames('report d', ws).map((w) => w.id)).toEqual(['2'])
    expect(filterWorkflowNames('zzz', ws)).toEqual([])
    expect(filterWorkflowNames('Daily report x', ws)).toEqual([])
  })
  it('keeps at most 8', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: String(i), name: `Flow ${i}` }))
    expect(filterWorkflowNames('flow', many)).toHaveLength(8)
  })
})

describe('keepWorkflowPick', () => {
  const pick = { id: 'w1', name: 'Report' }
  it('holds while the text starts with /run-workflow and the picked name', () => {
    expect(keepWorkflowPick('/run-workflow Report ', pick)).toBe(pick)
    expect(keepWorkflowPick('/run-workflow Report', pick)).toBe(pick)
    expect(keepWorkflowPick('/run-workflow Report weekly please', pick)).toBe(pick)
    expect(keepWorkflowPick('/run-workflow  report go', pick)).toBe(pick)
  })
  it('drops once the name or the command is edited, and stays null without a pick', () => {
    expect(keepWorkflowPick('/run-workflow Repor', pick)).toBeNull()
    expect(keepWorkflowPick('/run-workflow Reports', pick)).toBeNull()
    expect(keepWorkflowPick('/run-workflow Daily', pick)).toBeNull()
    expect(keepWorkflowPick('/run-workflowx Report', pick)).toBeNull()
    expect(keepWorkflowPick('Report', pick)).toBeNull()
    expect(keepWorkflowPick('', pick)).toBeNull()
    expect(keepWorkflowPick('/run-workflow Report', null)).toBeNull()
  })
})

describe('workflowMenuQuery', () => {
  const pick = { id: 'w1', name: 'Report' }
  it('is the Workflows query with no pick', () => {
    expect(workflowMenuQuery('/run-workflow Rep', '/run-workflow Rep', null)).toBe('Rep')
    expect(workflowMenuQuery('/run-workflow Report ', '/run-workflow Report ', null)).toBe('Report ')
  })
  it('stays closed after a pick, so Enter sends rather than picks a longer name', () => {
    expect(workflowMenuQuery('/run-workflow Report ', '/run-workflow Report ', pick)).toBeNull()
    expect(workflowMenuQuery('/run-workflow Report weekly', '/run-workflow Report weekly', pick)).toBeNull()
  })
  it('opens again once the picked name is edited', () => {
    expect(workflowMenuQuery('/run-workflow Repo', '/run-workflow Repo', pick)).toBe('Repo')
  })
})

describe('slashQuery', () => {
  it('reads the query after a leading slash in the first block', () => {
    expect(slashQuery('/', true)).toEqual({ query: '', afterTodo: false })
    expect(slashQuery('/ch', true)).toEqual({ query: 'ch', afterTodo: false })
    expect(slashQuery('/upgrade-check', true)).toEqual({ query: 'upgrade-check', afterTodo: false })
    expect(slashQuery('/to', true)).toEqual({ query: 'to', afterTodo: false })
  })
  it('reads the query typed right after a leading /todo', () => {
    expect(slashQuery('/todo /my', true)).toEqual({ query: 'my', afterTodo: true })
    expect(slashQuery('/todo /', true)).toEqual({ query: '', afterTodo: true })
    expect(slashQuery('/todo   /my', true)).toEqual({ query: 'my', afterTodo: true })
  })
  it('does not open after /todo alone, another name, or /todo in a later block', () => {
    expect(slashQuery('/todo ', true)).toBeNull()
    expect(slashQuery('/todo', true)).toEqual({ query: 'todo', afterTodo: false })
    expect(slashQuery('/todos /my', true)).toBeNull()
    expect(slashQuery('/btw /my', true)).toBeNull()
    expect(slashQuery('/todo /my', false)).toBeNull()
    expect(slashQuery('/todo /todo /my', true)).toBeNull()
  })
  it('is null anywhere else', () => {
    expect(slashQuery('x /ch', true)).toBeNull()
    expect(slashQuery('/ch ', true)).toBeNull()
    expect(slashQuery('/Ch', true)?.query).toBe('Ch') // engine rows have uppercase names
    expect(slashQuery('/c$h', true)).toBeNull()
    expect(slashQuery('/ch', false)).toBeNull()
    expect(slashQuery('', true)).toBeNull()
  })
})

describe('textSlashQuery', () => {
  it('reads the query before a bare caret', () => {
    expect(textSlashQuery('/ch', 3, 3)).toEqual({ query: 'ch', afterTodo: false })
    expect(textSlashQuery('/', 1, 1)).toEqual({ query: '', afterTodo: false })
    expect(textSlashQuery('/check rest', 3, 3)).toEqual({ query: 'ch', afterTodo: false }) // the caret inside the name
    expect(textSlashQuery('/todo /ch rest', 9, 9)).toEqual({ query: 'ch', afterTodo: true })
  })
  it('is null after the name, with a selection, or when the text does not start with a slash', () => {
    expect(textSlashQuery('/check rest', 11, 11)).toBeNull()
    expect(textSlashQuery('/check rest', 2, 5)).toBeNull()
    expect(textSlashQuery('see /ch', 7, 7)).toBeNull()
    expect(textSlashQuery('a\n/ch', 5, 5)).toBeNull() // a later line is not the first block
    expect(textSlashQuery('', 0, 0)).toBeNull()
  })
})

describe('insertCommandName', () => {
  it('replaces the typed query with /name and a space, caret after it', () => {
    expect(insertCommandName('/ch', 3, 'check')).toEqual({ text: '/check ', caret: 7 })
    expect(insertCommandName('/', 1, 'fix')).toEqual({ text: '/fix ', caret: 5 })
    expect(insertCommandName('/to', 3, 'todo')).toEqual({ text: '/todo ', caret: 6 })
  })
  it('keeps a leading /todo before the inserted name', () => {
    expect(insertCommandName('/todo /m', 8, 'my-day')).toEqual({ text: '/todo /my-day ', caret: 14 })
    expect(insertCommandName('/todo /', 7, 'my-day')).toEqual({ text: '/todo /my-day ', caret: 14 })
    expect(insertCommandName('/todo /m x', 8, 'my-day')).toEqual({ text: '/todo /my-day  x', caret: 14 })
  })
  it('keeps the text after the caret', () => {
    expect(insertCommandName('/ch https://x/1', 3, 'check')).toEqual({ text: '/check  https://x/1', caret: 7 })
  })
})

describe('filterCommands', () => {
  it('lists /btw first, then every agent command in file order for an empty query', () => {
    expect(ids(filterCommands('', [wk]))).toEqual(['wk/check', 'wk/fix', 'builtin/btw', 'builtin/todo', 'builtin/run-workflow', 'builtin/later'])
  })
  it('lists /todo after /btw with its description, and by prefix', () => {
    expect(filterCommands('to', [])).toEqual([{ builtin: 'todo', description: "Put this reply's action items on the chat's to-do list" }])
    expect(ids(filterCommands('t', [fix]))).toEqual(['builtin/todo'])
    expect(ids(filterCommands('TO', [flagged]))).toEqual(['builtin/todo'])
  })
  it("hides an agent's own todo command like btw", () => {
    expect(ids(filterCommands('', [flagged]))).toEqual(['fl/my-day', 'builtin/btw', 'builtin/todo', 'builtin/run-workflow', 'builtin/later'])
  })
  it('after /todo lists agent commands only: no btw, no todo', () => {
    expect(ids(filterCommands('', [wk], { afterTodo: true }))).toEqual(['wk/check', 'wk/fix'])
    expect(ids(filterCommands('', [flagged], { afterTodo: true }))).toEqual(['fl/my-day'])
    expect(filterCommands('', [], { afterTodo: true })).toEqual([])
    expect(filterCommands('bt', [wk], { afterTodo: true })).toEqual([])
    expect(ids(filterCommands('ch', [wk], { afterTodo: false }))).toEqual(['wk/check'])
  })
  it('keeps agent order and skips agents that failed to load', () => {
    expect(ids(filterCommands('ch', [wk, rv, broken]))).toEqual(['wk/check', 'rv/check'])
  })
  it('falls back to description words after name prefixes', () => {
    expect(ids(filterCommands('bug', [wk]))).toEqual(['wk/fix'])
    // 'release' and 'review' are description words; no name starts with 're'.
    expect(ids(filterCommands('re', [wk, rv]))).toEqual(['wk/check', 'rv/check'])
  })
  it('lists a command once even when name and description both match', () => {
    expect(ids(filterCommands('check', [wk]))).toEqual(['wk/check'])
  })
  it('is empty when nothing matches and still offers the built-in for an agent without commands', () => {
    expect(filterCommands('zzz', [wk, rv])).toEqual([])
    expect(ids(filterCommands('', [plain]))).toEqual(['builtin/btw', 'builtin/todo', 'builtin/run-workflow', 'builtin/later'])
  })
  it("lists /btw first and hides an agent's own btw even for description matches", () => {
    const own = agent('own', [
      { name: 'btw', description: 'Secret aside' },
      { name: 'btwin', description: 'Twin' }
    ])
    expect(filterCommands('bt', [own])).toContainEqual({ builtin: 'btw', description: 'Ask on the side; the run keeps going' })
    expect(ids(filterCommands('bt', [own]))).toEqual(['own/btwin', 'builtin/btw'])
    expect(ids(filterCommands('btw', [own]))).toEqual(['own/btwin', 'builtin/btw'])
    expect(ids(filterCommands('BT', [own]))).toEqual(['own/btwin', 'builtin/btw'])
    expect(filterCommands('secret', [own])).toEqual([])
    expect(filterCommands('side', [])).toEqual([])
    expect(ids(filterCommands('', []))).toEqual(['builtin/btw', 'builtin/todo', 'builtin/run-workflow', 'builtin/later'])
    expect(filterCommands('btwx', [own])).toEqual([])
  })
})

describe('groupOptions', () => {
  it('groups per agent in the given order, leaving out the built-in btw', () => {
    const groups = groupOptions(filterCommands('', [rv, wk]))
    expect(groups.map((g) => g.agent.name)).toEqual(['rv', 'wk'])
    expect(groups.map((g) => ids(g.options))).toEqual([['rv/check'], ['wk/check', 'wk/fix']])
  })
  it('is empty for no options', () => {
    expect(groupOptions([])).toEqual([])
  })
})

describe('keepPick', () => {
  const pick: CommandPick = { agent: 'wk', name: 'check' }
  it('keeps the pick while the leading name still matches', () => {
    expect(keepPick('/check L', pick)).toBe(pick)
    expect(keepPick('/check ', pick)).toBe(pick)
    expect(keepPick('/check', pick)).toBe(pick)
  })
  it('drops it once the leading name changes or goes', () => {
    expect(keepPick('/chec L', pick)).toBeNull()
    expect(keepPick('/checks L', pick)).toBeNull()
    expect(keepPick('hello', pick)).toBeNull()
    expect(keepPick('', pick)).toBeNull()
  })
  it('passes null through', () => {
    expect(keepPick('/check L', null)).toBeNull()
  })
  it('reads the command after a leading /todo', () => {
    const mine: CommandPick = { agent: 'work-assistant', name: 'my-day' }
    expect(keepPick('/todo /my-day x', mine)).toBe(mine)
    expect(keepPick('/todo   /my-day', mine)).toBe(mine)
    expect(keepPick('/todo /my-da x', mine)).toBeNull()
    expect(keepPick('/todo x', mine)).toBeNull()
    expect(keepPick('/todo', mine)).toBeNull()
    expect(keepPick('/todos /my-day', mine)).toBeNull()
    expect(keepPick('/todo /my-day x', mine, [agent('work-assistant', [{ name: 'my-day', description: 'd' }])])).toBe(mine)
    expect(keepPick('/todo /my-day x', mine, [wk])).toBeNull()
  })
  it('drops it once its agent is gone or no longer offers the command', () => {
    expect(keepPick('/check L', pick, [wk, rv])).toBe(pick)
    // The new-chat agent switched from wk to rv: rv's own /check is resolved by name, not sent as wk's.
    expect(keepPick('/check L', pick, [rv])).toBeNull()
    expect(keepPick('/check L', pick, [])).toBeNull()
    expect(keepPick('/check L', pick, [agent('wk', [{ name: 'fix', description: 'Fix' }])])).toBeNull()
    expect(keepPick('/check L', pick, [agent('wk', wk.commands!, 'bad frontmatter')])).toBeNull()
  })
})

describe('comment box commands', () => {
  it('opens on a /word anywhere after whitespace, not inside a path', () => {
    expect(commentSlashQuery('@wk /ch', 7)).toEqual({ start: 4, query: 'ch' })
    expect(commentSlashQuery('/', 1)).toEqual({ start: 0, query: '' })
    expect(commentSlashQuery('see a/b', 7)).toBeNull()
    expect(commentSlashQuery('@wk /check ', 11)).toBeNull()
  })

  it('lists the commands of every mentioned agent, in mention order, and no built-ins', () => {
    const members = [wk, rv, fix, broken]
    expect(ids(commentCommandOptions('', '@rv and @wk /', members))).toEqual(['rv/check', 'wk/check', 'wk/fix'])
    expect(ids(commentCommandOptions('fix', '@fx @broken /fix', members))).toEqual(['fx/fixit'])
    expect(commentCommandOptions('', 'no one /', members)).toEqual([])
  })

  it('inserts the picked command and moves the caret past it', () => {
    expect(insertCommentCommand('@wk /ch rest', { start: 4 }, 7, 'check')).toEqual({ text: '@wk /check  rest', caret: 11 })
  })
})

describe('commentCommandMarks', () => {
  const card = { name: 'card', description: 'Make a card' }
  const wm = agent('workiom-master', [card])
  const other = agent('writer', [card, { name: 'draft', description: 'Draft' }])
  const broken = agent('broken', [{ name: 'fix', description: 'Fix' }], 'bad yaml')

  it('marks a /name a mentioned agent owns, tinted for its one owner, wherever it sits', () => {
    const text = '@workiom-master /card make it\nthen /draft and /nope'
    expect(commentCommandMarks(text, [wm, other])).toEqual([{ start: 16, end: 21, agent: wm }])
    expect(commentCommandMap(text, [wm, other])).toEqual(new Map([['card', 'workiom-master']]))
  })

  it('leaves a command two mentioned agents own untinted, and skips paths, code and broken agents', () => {
    expect(commentCommandMap('@workiom-master @writer /card', [wm, other])).toEqual(new Map([['card', '']]))
    expect(commentCommandMarks('@workiom-master see /etc/hosts and `/card`', [wm])).toEqual([])
    expect(commentCommandMarks('@broken /fix', [broken])).toEqual([])
  })
})

describe('engine rows', () => {
  const goalAgent = agent('ga', [{ name: 'goal-check', description: 'Check the goal' }])
  const claude: EngineCommands = {
    engine: 'claude',
    commands: [
      { name: 'goal', description: 'Set a goal', kind: 'command' },
      { name: 'superpowers:brainstorming', description: 'Explore ideas before building', kind: 'skill' },
      { name: 'review', description: 'Review the goal of a change', kind: 'command' }
    ]
  }

  it('lists them after the agent rows: name prefixes, then description words', () => {
    const options = filterCommands('go', [goalAgent], { engine: claude })
    expect(ids(options)).toEqual(['ga/goal-check', 'claude/goal', 'claude/review'])
    expect(options[1]).toEqual({ engine: 'claude', command: { name: 'goal', description: 'Set a goal', kind: 'command' } })
  })
  it('puts description word matches after name matches', () => {
    expect(ids(filterCommands('goal', [goalAgent], { engine: claude }))).toEqual(['ga/goal-check', 'claude/goal', 'claude/review'])
  })
  it("orders the agent's commands, ZumiBot's, the engine's skills, then the engine's commands", () => {
    expect(ids(filterCommands('', [goalAgent], { engine: claude }))).toEqual([
      'ga/goal-check',
      'builtin/btw',
      'builtin/todo',
      'builtin/run-workflow',
      'builtin/later',
      'claude/superpowers:brainstorming',
      'claude/goal',
      'claude/review'
    ])
  })
  it('keeps each group in its place while a query narrows it', () => {
    const codexSkills: EngineCommands = { engine: 'codex', commands: [{ name: 'todo-list', description: 'Track work', kind: 'skill' }] }
    const todoAgent = agent('ta', [{ name: 'todo-sync', description: 'Sync' }])
    expect(ids(filterCommands('to', [todoAgent], { engine: codexSkills }))).toEqual(['ta/todo-sync', 'builtin/todo', 'codex/todo-list'])
  })
  it('matches a namespaced name by prefix, case-insensitively', () => {
    expect(ids(filterCommands('superpowers:br', [], { engine: claude }))).toEqual(['claude/superpowers:brainstorming'])
    expect(ids(filterCommands('SUPERPOWERS:', [], { engine: claude }))).toEqual(['claude/superpowers:brainstorming'])
  })
  it('shows after /todo too', () => {
    expect(ids(filterCommands('go', [goalAgent], { engine: claude, afterTodo: true }))).toEqual(['ga/goal-check', 'claude/goal', 'claude/review'])
  })
  it('null or no list is the old result exactly', () => {
    expect(filterCommands('', [wk], { engine: null })).toEqual(filterCommands('', [wk]))
    expect(filterCommands('go', [goalAgent], { engine: null })).toEqual(filterCommands('go', [goalAgent]))
  })
  it('groupOptions and the comment list skip them', () => {
    expect(groupOptions(filterCommands('', [goalAgent], { engine: claude })).map((g) => ids(g.options))).toEqual([['ga/goal-check']])
    expect(commentCommandOptions('go', '@ga hi', [goalAgent]).map((o) => o.command.name)).toEqual(['goal-check'])
  })
  it('keeps a name with a colon in the slash query', () => {
    expect(slashQuery('/superpowers:br', true)?.query).toBe('superpowers:br')
    expect(slashQuery('/todo /a.b_c-d', true)).toEqual({ query: 'a.b_c-d', afterTodo: true })
    expect(slashQuery('/super powers', true)).toBeNull()
  })

  describe('keepPick', () => {
    const pick: CommandPick = { agent: 'a', name: 'superpowers:brainstorming', engine: 'claude' }
    const agentA = agent('a', [])
    it('keeps it while the leading name holds and the list still has it', () => {
      expect(keepPick('/superpowers:brainstorming fix it', pick, [agentA], claude)).toBe(pick)
      expect(keepPick('/todo /superpowers:brainstorming', pick, [agentA], claude)).toBe(pick)
      expect(keepPick('/superpowers:brainstorming fix it', pick)).toBe(pick)
    })
    it('drops it once the name is edited', () => {
      expect(keepPick('/superpowers:brainstormin fix it', pick, [agentA], claude)).toBeNull()
      expect(keepPick('/superpowers:brainstormings', pick, [agentA], claude)).toBeNull()
      expect(keepPick('hello', pick, [agentA], claude)).toBeNull()
    })
    it('drops it when the list no longer holds the name or is another engine', () => {
      expect(keepPick('/superpowers:brainstorming x', pick, [agentA], { engine: 'claude', commands: [] })).toBeNull()
      expect(keepPick('/superpowers:brainstorming x', pick, [agentA], { engine: 'codex', commands: claude.commands })).toBeNull()
      expect(keepPick('/superpowers:brainstorming x', pick, [agentA], null)).toBe(pick)
    })
    it('drops it when its agent is no longer the chat agent, even while the new list loads', () => {
      expect(keepPick('/superpowers:brainstorming x', pick, [agent('b', [])], null)).toBeNull()
    })
  })
})
